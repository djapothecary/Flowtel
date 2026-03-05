import axios from 'axios';
import { Pool } from 'pg';
import pLimit from 'p-limit';
// import dotenv from 'dotenv';

// dotenv.config();

// ---  CONFIGURATION  ---
const API_BASE = process.env.API_URL || 'http://localhost:3000/api/v1';
const API_KEY = process.env.API_KEY || 'MOCK_KEY';
const CONCURRENCY_LIMIT = 2;   // Matches DB pool size or API thread count
const BATCH_FLUSH_SIZE = 1000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres@localhost:5434/postgres',
    max: CONCURRENCY_LIMIT // Ensure DB pool matches our concurrency
});

// The 'Referee' (my brand) that ensures the database isn't overwhelmed with too many parallel writes
const limit = pLimit(CONCURRENCY_LIMIT);

//  Initialize the database with "self-healing"
async function initializeDatabase() {
    const client = await pool.connect();

    try {
        console.log("[SYSTEM] Synchronizing database schema ...");

        //  1.  Create the events table
        await client.query(`
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                data JSONB NOT NULL,
                processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

        //  2.  Create the ingestion_state table
        await client.query(`
            CREATE TABLE IF NOT EXISTS ingestion_state (
                id INT PRIMARY KEY,
                cursor_value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

        console.log("[SUCCESS] Database schema certified.");
    } finally {
        client.release();
    }
}

async function run() {
    console.log("--- INITIATING SECTOR INGESTION ---");

    // ARCHITECT'S FIX: Implementation of a 'Ready-Check' loop
    let client;
    let connected = false;
    let retries = 5;

    while (!connected && retries > 0) {
        try {
            client = await pool.connect();
            connected = true;
            client.release();
            console.log("[SUCCESS] Database link established.");
        } catch (err) {
            retries--;
            console.log(`[WAIT] Database initializing... (${retries} attempts remaining)`);
            await new Promise(res => setTimeout(res, 3000)); // Wait 3 seconds
        }
    }

    if (!connected) {
        console.error("[FATAL] Could not synchronize with database. Terminating.");
        process.exit(1);
    }

    //  ARCHITECT FIX: ensure tables exists before querying
    await initializeDatabase();

    // 1. Resumability: Get last successful cursor
    const stateRes = await pool.query('SELECT cursor_value FROM ingestion_state WHERE id = 1');

    // --- TEMPORARY TESTING SPEED BUMP ---
    //  running too fast to test stopping/resume, intentionally pausing
    // console.log(`[DEBUG] Sector Sync Complete. Pause for manual interrupt...`);
    // await new Promise(r => setTimeout(r, 2000)); // 2-second window to hit Ctrl+C

    let currentCursor: string | null = stateRes.rows[0]?.cursor_value || null;

    let totalIngested = 0;
    let buffer: any[] = [];
    const flushTasks: Promise<void>[] = [];

    while(true) {
        try {
            const url = `${API_BASE}/events?cursor=${currentCursor || ''}&limit=1000`;

            const response = await axios.get(url, {
                headers: {
                    'X-API-Key': API_KEY,
                    'User-Agent': 'Refinery-Ingestion-Engine/1.0'
                }
            });

            // ARCHITECT'S FIX: Aligning with the discovered API Schema
            const events = response.data.data;
            const pagination = response.data.pagination;
            const meta = response.data.meta;

            if (!events || events.length === 0) {
                console.log("[SYSTEM] Sector empty. Terminating scan.");
                break;
            }

            buffer.push(...events);
            totalIngested += events.length;

            // 3. PIPELINE PERSISTENCE (Existing logic)
            if (buffer.length >= BATCH_FLUSH_SIZE) {
                const snapshot = [...buffer];
                const capturedCursor = currentCursor;
                buffer = [];

                const task = limit(async () => {
                    await flushBuffer(snapshot);
                    await pool.query(
                        'INSERT INTO ingestion_state (id, cursor_value) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET cursor_value = $1',
                        [capturedCursor]
                    );
                });

                flushTasks.push(task);

                // Log with the total count from 'meta' to show progress against the 3M goal
                const progress = ((totalIngested / meta.total) * 100).toFixed(2);
                console.log(`[HUD] Progress: ${totalIngested.toLocaleString()} / ${meta.total.toLocaleString()} (${progress}%)`);
            }

            // Move to next cursor
            if (!pagination.hasMore || !pagination.nextCursor) break;
            currentCursor = pagination.nextCursor;

            // ARCHITECT'S FIX: The 'Steady Hand' Delay
            // This ensures we don't trigger the burst governor again.
            const SUSTAINED_DELAY = 500; // 500ms gap between batches
            await new Promise(r => setTimeout(r, SUSTAINED_DELAY));

        } catch (error: any) {
            if (error.response?.status === 404 || error.message.endsWith("404")) {
                    console.error(`[FATAL] Route not found (404). Check API_BASE path: ${API_BASE}`);
                    process.exit(1); // Stop the engine so it doesn't keep "blowing up"
                }

            //  Http 429 Too many requests:
            //  indicates that the user has sent too many requests within a specified amount of time
            if (error.response?.status === 429) {
                    // If we hit a 429, the 'Ref' calls a major timeout.
                    console.warn(`[GOVERNOR] Sustained limit exceeded. Initiating 60s System Reset...`);

                    // Wipe current session state if needed and wait
                    await new Promise(r => setTimeout(r, 60000));

                    // Optimization: Reduce concurrency further if we keep hitting this
                    continue;
                }

            if (error.response?.status === 404 || error.message.includes("404")) {
                console.error(`[FATAL] Route lost. Check API_BASE.`);
                process.exit(1);
            }

            // For general network blips, wait 2s and continue
            console.error(`[RETRY] Link Interrupted: ${error.message}. Re-establishing in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
    }

    // 4. FINAL SYNCHRONIZATION
    // Before exiting, we must ensure any final items in the buffer are flushed
    if (buffer.length > 0) {
        const finalSnapshot = [...buffer];
        const finalCursor = currentCursor; // Capture the actual final cursor

        const finalTask = limit(async () => {
            await flushBuffer(finalSnapshot);
            // ARCHITECT'S FIX: Ensure the final state is captured
            await pool.query(
                'INSERT INTO ingestion_state (id, cursor_value) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET cursor_value = $1',
                [finalCursor]
            );
        });
        flushTasks.push(finalTask);
    }

    // Wait for all background DB flushes to complete
    console.log("[SYSTEM] Finalizing all pending sector writes...");
    await Promise.all(flushTasks);

    console.log(`--- INGESTION COMPLETE: ${totalIngested.toLocaleString()} TOTAL EVENTS ---`);
}

async function flushBuffer(events: any[]) {
    const client = await pool.connect();
    try {
        const values = events.flatMap(e => [e.id, JSON.stringify(e)]);
        // Standard multi-row parameter generation ($1, $2), ($3, $4)...
        const placeholders = events.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',');
        const query = `INSERT INTO events (id, data) VALUES ${placeholders} ON CONFLICT (id) DO NOTHING`;

        await client.query(query, values);
    } finally  {
        client.release();
    }
}

run().catch(err => console.error("Fatal Engine Failure:", err));
