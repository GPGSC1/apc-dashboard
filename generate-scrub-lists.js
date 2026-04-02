// Generate scrub lists for GPG campaign
// 1. sales-phones.csv — all phones from moxy_deals + moxy_home_deals (all statuses)
// 2. nevans-phones.csv — phones called 15+ times by AIM that never answered
//
// NevAns approach: Use aim_phone_history (phone, list_key, call_date) from Postgres.
// Each row = one unique (phone, list, date) combination from AIM calls.
// A phone with 15+ rows was called on at least 15 different (list,date) combos.
// Exclude phones that ever appear in aim_transfers (transferred = answered)
// or queue_calls with status='answered' (human picked up).

const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const PG_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL
  || "postgresql://neondb_owner:npg_fnOl2MUvIau3@ep-quiet-star-anl5gyqh-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require";

function normalize(raw) {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

async function main() {
  const outDir = path.resolve(__dirname);

  const client = new Client({ connectionString: PG_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("[DB] Connected to Postgres");
  console.log("");

  // ── Part 1: Sales phones ──────────────────────────────────────────────────
  console.log("[Sales] Querying moxy_deals...");
  const autoRes = await client.query("SELECT home_phone, mobile_phone FROM moxy_deals");
  console.log("[Sales] moxy_deals: " + autoRes.rows.length + " rows");

  console.log("[Sales] Querying moxy_home_deals...");
  const homeRes = await client.query("SELECT home_phone, mobile_phone FROM moxy_home_deals");
  console.log("[Sales] moxy_home_deals: " + homeRes.rows.length + " rows");

  const salesPhones = new Set();
  for (const row of autoRes.rows.concat(homeRes.rows)) {
    const hp = normalize(row.home_phone);
    const mp = normalize(row.mobile_phone);
    if (hp) salesPhones.add(hp);
    if (mp) salesPhones.add(mp);
  }

  const salesPath = path.join(outDir, "sales-phones.csv");
  fs.writeFileSync(salesPath, ["phone"].concat(Array.from(salesPhones).sort()).join("\n") + "\n");
  console.log("");
  console.log("[DONE] sales-phones.csv: " + salesPhones.size + " unique phones");
  console.log("  -> " + salesPath);
  console.log("");

  // ── Part 2: NevAns phones ─────────────────────────────────────────────────
  // Phones called 15+ times (using aim_phone_history row count as proxy)
  // that NEVER appear in aim_transfers or answered queue_calls
  console.log("[NevAns] Running query...");
  console.log("  - Finding phones with 15+ AIM call history rows");
  console.log("  - Excluding phones in aim_transfers (ever transferred)");
  console.log("  - Excluding phones answered in queue_calls");
  console.log("");

  const nevAnsRes = await client.query(`
    SELECT h.phone, COUNT(*) as call_count
    FROM aim_phone_history h
    WHERE NOT EXISTS (
      SELECT 1 FROM aim_transfers t WHERE t.phone = h.phone
    )
    AND NOT EXISTS (
      SELECT 1 FROM queue_calls q WHERE q.phone = h.phone AND q.status = 'answered'
    )
    GROUP BY h.phone
    HAVING COUNT(*) >= 15
    ORDER BY COUNT(*) DESC
  `);

  console.log("[NevAns] Found " + nevAnsRes.rows.length + " phones with 15+ call history rows, never answered");
  if (nevAnsRes.rows.length > 0) {
    console.log("[NevAns] Top 10 by call count:");
    for (const row of nevAnsRes.rows.slice(0, 10)) {
      console.log("  " + row.phone + " -> " + row.call_count + " history rows");
    }
  }

  const nevAnsPhones = new Set();
  for (const row of nevAnsRes.rows) {
    const p = normalize(row.phone);
    if (p) nevAnsPhones.add(p);
  }

  const nevAnsPath = path.join(outDir, "nevans-phones.csv");
  fs.writeFileSync(nevAnsPath, ["phone"].concat(Array.from(nevAnsPhones).sort()).join("\n") + "\n");
  console.log("");
  console.log("[DONE] nevans-phones.csv: " + nevAnsPhones.size + " unique phones");
  console.log("  -> " + nevAnsPath);

  await client.end();
}

main().catch(function(e) {
  console.error(e);
  process.exit(1);
});
