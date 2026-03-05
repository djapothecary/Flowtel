import { Pool } from 'pg';
import axios from 'axios';

async function submit() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    //  1.  Extract all IDs in on high-speed query
    console.log("Fetching event IDs for submission ...");
    const res = await pool.query('SELECT id FROM events ORDER BY processed_at ASC');
    const ids = res.rows.map(r => r.id).join('\n');

    //  2.  Submit via the API (Option 1: Plain Text)
    try {
        const response = await axios.post(
            `${process.env.API_URL}/submissions?github_repo=MY_REPO_URL`,
            ids,
            {
                headers: {
                    'X-API_Key': process.env.API_KEY,
                    'Content-Type': 'text/plain'
                }
            }
        );
        console.log("--- SUBMISSION SUCCESSFUL ---");
        console.log(response.data);
    } catch (error: any) {
        console.error("Submission Failed.", error.response?.data || error.message);
    }
}