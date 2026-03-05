import express from 'express';
const app = express();
const PORT = 3000;

//  simulating 3 million events
const TOTAL_EVENTS = 3000000;
const BATCH_SIZE = 1000;
// const TOTAL_EVENTS = 30;
// const BATCH_SIZE = 1;

// ADD A LOGGER to the mock server to track what is hitting it and causing infinite loop
// 1. ARCHITECT'S DIAGNOSTIC: Log every raw request
app.use((req, res, next) => {
    console.log(`[RAW_HANDSHAKE] ${new Date().toISOString()} | ${req.method} ${req.url}`);
    next();
});

// 2. THE VERSIONED ROUTER: Ensures /api/v1 is a hard boundary
const v1Router = express.Router();

v1Router.get('/events', (req, res) => {
    const cursor = parseInt(req.query.cursor as string || '0');
    const limit = parseInt(req.query.limit as string || '100000');

    console.log(`[DATA_SYNC] Providing ${limit} events starting from cursor ${cursor}`);

    const events = [];
    // We'll simulate 10,000 events for this lab test
    // Passed, increasing to 50000
    // const MAX_LAB_EVENTS = 10000;
    const MAX_LAB_EVENTS = 500000;

    for (let i = 0; i < limit && (cursor + i) < MAX_LAB_EVENTS; i++) {
        events.push({
            id: `ev_${cursor + i}`,
            timestamp: new Date().toISOString(),
            data: { status: "MOCK_TELEMETRY" }
        });
    }

    const nextCursor = (cursor + limit < MAX_LAB_EVENTS) ? (cursor + limit).toString() : null;

    res.json({
        events,
        next_cursor: nextCursor
    });
});

// 3. MOUNT THE ROUTER: This handles the /api/v1 prefix automatically
app.use('/api/v1', v1Router);

// 4. THE CATCH-ALL: Helps identify misconfigured clients
app.use((req, res) => {
    console.warn(`[404_DETECTION] Unmapped route attempted: ${req.url}`);
    res.status(404).send(`Telemetry route not found: ${req.url}`);
});

//  enhanced logging
app.listen(PORT, () => {
    console.log("-----------------------------------------");
    console.log(`[LAB] Mock Server Active: Port ${PORT}`);
    console.log(`[EXPECTING] http://localhost:${PORT}/api/v1/events`);
    console.log("-----------------------------------------");
});
