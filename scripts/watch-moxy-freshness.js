// Moxy data freshness watcher.
// Confirms Lenovo's Moxy pulls are flowing into Neon at the expected cadence.
// Run periodically during Phase 2b cutover to verify dashboard-side decommission is safe.
//
// Reports for each table:
//   - Most recent row (sold_date and import timestamp if available)
//   - Hours since most recent row
//   - Row count for today + yesterday
//   - Status: GREEN (< 30 min stale) / YELLOW (30-90 min) / RED (> 90 min)
//
// Usage: node scripts/watch-moxy-freshness.js

const { Pool } = require("pg");
const fs = require("fs");

const envText = fs.readFileSync(".env.local", "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });

function fmtDur(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

(async () => {
  // Today/yesterday in CT
  const fmt = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
  const today = fmt(new Date());
  const yesterday = fmt(new Date(Date.now() - 86_400_000));

  console.log(`Snapshot ${new Date().toISOString()}\nToday CT: ${today}\nYesterday CT: ${yesterday}\n`);

  for (const table of ["moxy_deals", "moxy_home_deals"]) {
    console.log(`=== ${table} ===`);
    try {
      // Most recent sold_date
      const maxSold = await pool.query(
        `SELECT MAX(sold_date) AS d, COUNT(*) AS n FROM ${table} WHERE sold_date IS NOT NULL`
      );
      console.log(`  max(sold_date):   ${maxSold.rows[0].d}   (${Number(maxSold.rows[0].n).toLocaleString()} rows)`);

      // Today's count
      const todayCnt = await pool.query(
        `SELECT COUNT(*) AS n FROM ${table} WHERE sold_date = $1`,
        [today]
      );
      const ydayCnt = await pool.query(
        `SELECT COUNT(*) AS n FROM ${table} WHERE sold_date = $1`,
        [yesterday]
      );
      console.log(`  today (${today}):    ${Number(todayCnt.rows[0].n).toLocaleString()} rows`);
      console.log(`  yest. (${yesterday}): ${Number(ydayCnt.rows[0].n).toLocaleString()} rows`);

      // Most recent ROW imported. moxy_deals doesn't have an updated_at column,
      // but seed_metadata tracks last refresh per source.
      const meta = await pool.query(
        `SELECT max_date, updated_at FROM seed_metadata WHERE source = $1`,
        [table === "moxy_deals" ? "moxy" : "moxy_home"]
      );
      if (meta.rows.length > 0) {
        const m = meta.rows[0];
        const updatedAt = new Date(m.updated_at);
        const ageMs = Date.now() - updatedAt.getTime();
        const status = ageMs < 30 * 60_000 ? "\x1b[32mGREEN\x1b[0m" : ageMs < 90 * 60_000 ? "\x1b[33mYELLOW\x1b[0m" : "\x1b[31mRED\x1b[0m";
        console.log(`  seed_metadata:    max=${m.max_date}  updated=${m.updated_at}  (${fmtDur(ageMs)} ago)  ${status}`);
      } else {
        console.log(`  seed_metadata:    \x1b[31mNO ENTRY\x1b[0m`);
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
    console.log();
  }

  // Walco freshness via seed_metadata.updated_at (per Lenovo: imported_at on the
  // walco_payments table only advances when PBS returns NEW rows; afternoons with
  // no late payments leave imported_at "stale" for hours even though the hourly
  // cron is healthy. seed_metadata.updated_at advances on every successful fire
  // regardless of whether new rows landed — that's the right freshness signal).
  console.log("=== walco_payments (Lenovo, seed_metadata-based) ===");
  try {
    const wcMeta = await pool.query(
      `SELECT max_date, updated_at FROM seed_metadata WHERE source = 'walco_payments'`
    );
    if (wcMeta.rows.length > 0) {
      const m = wcMeta.rows[0];
      const ageMs = Date.now() - new Date(m.updated_at).getTime();
      // Walco runs hourly during business hours, so 90-min threshold for green.
      const status = ageMs < 90 * 60_000 ? "\x1b[32mGREEN\x1b[0m" : ageMs < 4 * 3600_000 ? "\x1b[33mYELLOW\x1b[0m" : "\x1b[31mRED\x1b[0m";
      console.log(`  seed_metadata:    max_date=${m.max_date}  updated=${m.updated_at}  (${fmtDur(ageMs)} ago)  ${status}`);
    } else {
      console.log(`  seed_metadata:    \x1b[31mNO ENTRY\x1b[0m (Lenovo's pbs-payments.js fix not yet deployed?)`);
    }
    // Also report row totals for sanity
    const wcRecent = await pool.query(
      `SELECT MAX(payment_date) AS max_pay, COUNT(*) AS n, MAX(imported_at) AS max_import
       FROM walco_payments WHERE payment_amount > 0`
    );
    const r = wcRecent.rows[0];
    console.log(`  rows:             max_pay=${r.max_pay}  total positive=${Number(r.n).toLocaleString()}  last_insert=${r.max_import}`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }

  await pool.end();
})();
