const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = 'postgresql://neondb_owner:npg_fnOl2MUvIau3@ep-quiet-star-anl5gyqh-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

function cleanPhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  return digits.slice(-10);
}

function parseCallDate(raw) {
  // Format: "1/1/2026 0:35" or "3/15/2026 14:22"
  if (!raw) return null;
  const parts = raw.trim().split(' ');
  if (parts.length < 1) return null;
  const dateParts = parts[0].split('/');
  if (dateParts.length !== 3) return null;
  const month = dateParts[0].padStart(2, '0');
  const day = dateParts[1].padStart(2, '0');
  const year = dateParts[2];
  return `${year}-${month}-${day}`;
}

// Simple CSV line parser that handles quoted fields
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

async function main() {
  const client = await pool.connect();
  try {
    // 1. Drop and recreate
    console.log('Dropping and recreating queue_calls...');
    await client.query('DROP TABLE IF EXISTS queue_calls');
    await client.query(`
      CREATE TABLE queue_calls (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(10),
        queue VARCHAR(100),
        call_date DATE,
        first_ext VARCHAR(20),
        agent_name VARCHAR(100),
        direction VARCHAR(20),
        status VARCHAR(20)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX idx_queue_calls_dedup
      ON queue_calls (phone, queue, call_date)
    `);
    console.log('Table created with unique index on (phone, queue, call_date).');

    // 2. Parse CSV
    const csvPath = path.join(__dirname, '..', '3CX_Seed.csv');
    const raw = fs.readFileSync(csvPath, 'utf-8');
    const lines = raw.split(/\r?\n/);

    // Row 4 is header (0-indexed line 3), data starts row 5 (line 4)
    const dataLines = lines.slice(4).filter(l => l.trim().length > 0);
    console.log(`CSV data lines: ${dataLines.length}`);

    // Build map: (phone, queue, call_date) -> best row (prefer one with extension)
    const dedup = new Map();
    let skippedNoQueue = 0;
    let totalParsed = 0;

    for (const line of dataLines) {
      const cols = parseCSVLine(line);
      if (cols.length < 22) continue;
      totalParsed++;

      const lastQueueName = (cols[21] || '').trim();
      if (!lastQueueName) { skippedNoQueue++; continue; }

      const direction = (cols[3] || '').trim();
      const firstExt = (cols[4] || '').trim();
      const agentName = (cols[5] || '').trim();
      const phone = cleanPhone(cols[8] || '');
      const status = (cols[12] || '').trim().toLowerCase();
      const callDate = parseCallDate(cols[1] || '');

      if (!callDate || !phone) continue;

      const key = `${phone}|${lastQueueName}|${callDate}`;
      const existing = dedup.get(key);
      if (!existing) {
        dedup.set(key, { phone, queue: lastQueueName, call_date: callDate, first_ext: firstExt, agent_name: agentName, direction, status });
      } else {
        // Prefer the one with an extension (answered) over blank (unanswered)
        if (!existing.first_ext && firstExt) {
          dedup.set(key, { phone, queue: lastQueueName, call_date: callDate, first_ext: firstExt, agent_name: agentName, direction, status });
        }
      }
    }

    console.log(`Parsed ${totalParsed} data lines, skipped ${skippedNoQueue} with no Last Queue Name.`);
    console.log(`Unique (phone, queue, call_date) entries: ${dedup.size}`);

    // 3. Bulk insert
    const rows = Array.from(dedup.values());
    let inserted = 0;
    const batchSize = 100;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const r of batch) {
        values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
        params.push(r.phone, r.queue, r.call_date, r.first_ext, r.agent_name, r.direction, r.status);
      }

      await client.query(
        `INSERT INTO queue_calls (phone, queue, call_date, first_ext, agent_name, direction, status)
         VALUES ${values.join(', ')}
         ON CONFLICT (phone, queue, call_date) DO UPDATE SET
           first_ext = CASE WHEN EXCLUDED.first_ext != '' THEN EXCLUDED.first_ext ELSE queue_calls.first_ext END,
           agent_name = CASE WHEN EXCLUDED.first_ext != '' THEN EXCLUDED.agent_name ELSE queue_calls.agent_name END,
           direction = CASE WHEN EXCLUDED.first_ext != '' THEN EXCLUDED.direction ELSE queue_calls.direction END,
           status = CASE WHEN EXCLUDED.first_ext != '' THEN EXCLUDED.status ELSE queue_calls.status END`,
        params
      );
      inserted += batch.length;
    }

    console.log(`\n--- Import Complete ---`);
    console.log(`Total rows imported: ${inserted}`);

    // 4. Stats
    const totalRes = await client.query('SELECT COUNT(*) as cnt FROM queue_calls');
    console.log(`Rows in table: ${totalRes.rows[0].cnt}`);

    const dirRes = await client.query('SELECT direction, COUNT(*) as cnt FROM queue_calls GROUP BY direction ORDER BY direction');
    console.log('\nCount by direction:');
    for (const r of dirRes.rows) console.log(`  ${r.direction}: ${r.cnt}`);

    const statusRes = await client.query('SELECT status, COUNT(*) as cnt FROM queue_calls GROUP BY status ORDER BY status');
    console.log('\nCount by status:');
    for (const r of statusRes.rows) console.log(`  ${r.status}: ${r.cnt}`);

    const aiRes = await client.query("SELECT COUNT(*) as cnt FROM queue_calls WHERE first_ext LIKE '99%'");
    console.log(`\nAI FWD (first_ext starts with 99): ${aiRes.rows[0].cnt}`);

    const queueRes = await client.query('SELECT queue, COUNT(*) as cnt FROM queue_calls GROUP BY queue ORDER BY cnt DESC LIMIT 15');
    console.log('\nQueue name sample (top 15):');
    for (const r of queueRes.rows) console.log(`  ${r.queue}: ${r.cnt}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
