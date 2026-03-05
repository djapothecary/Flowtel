import axios from 'axios';
import { Pool } from 'pg';
import pLimit from 'p-limit';
import dotenv from 'dotenv';

dotenv.config();

// ---  CONFIGURATION  ---
const API_BASE = process.env.API_URL || 'http://localhost:3000/api/v1';
const API_KEY = process.env.API_KEY || 'MOCK_KEY';
const CONCURRENCY_LIMIT = 10;   // Matches DB pool size or API thread count
const BATCH_FLUSH_SIZE = 5000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres@localhost:5434/postgres',
    max: CONCURRENCY_LIMIT // Ensure DB pool matches our concurrency
});

// The 'Referee' (my brand) that ensures the database isn't overwhelmed with too many parallel writes
const limit = pLimit(CONCURRENCY_LIMIT);

async function run() {
    console.log("--- INITIATING SECTOR INGESTION ---");

    // 1. Resumability: Get last successful cursor
    const stateRes = await pool.query('SELECT cursor_value FROM ingestion_state WHERE id = 1');
    let currentCursor: string | null = stateRes.rows[0]?.cursor_value || null;

    let totalIngested = 0;
    let buffer: any[] = [];
    const flushTasks: Promise<void>[] = [];

    while(true) {
        try {
            // 2. FETCH DATA
            const url = `${API_BASE}/events?cursor=${currentCursor || ''}&limit=1000`;
            const response = await axios.get(url, { headers: { 'X-API-Key': API_KEY } });

            const { events, next_cursor } = response.data;
            if (!events || events.length === 0) break;

            buffer.push(...events);
            totalIngested += events.length;

            // 3. PIPELINE PERSISTENCE
            if (buffer.length >= BATCH_FLUSH_SIZE) {
                // ARCHITECT'S DESCISON: Snapshot the buffer so the network loop can clear it
                // and keep fetching immediately without waiting for the DB write.
                const snapshot = [...buffer];
                const capturedCursor = currentCursor;
                buffer = [];

                // Add the flush task to the 'Referee's' queue
                const task = limit(async () => {
                    await flushBuffer(snapshot);
                    // Only update the 'resumable' state once the DB write is confirmed
                    await pool.query(
                        'INSERT INTO ingestion_state (id, cursor_value) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET cursor_value = $1',
                        [capturedCursor]
                    );
                });

                flushTasks.push(task);
                console.log(`[HUD] Progress: ${totalIngested.toLocaleString()} events in pipeline...`);
            }

            if (!next_cursor) break;
            currentCursor = next_cursor;

        } catch (error: any) {
            console.error(`[CRITICAL] Link Interrupted: ${error.message}`);
            //  Http 429 Too many requests:
            //  indicates that the user has sent too many requests within a specified amount of time
            if (error.response?.status === 429) {
                console.log("Rate limited. Pausing for 5 seconds...");
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    // 4. FINAL SYNCHRONIZATION
    // Before exiting, we must ensure any final items in the buffer are flushed
    if (buffer.length > 0) {
        flushTasks.push(limit(() => flushBuffer([...buffer])));
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
