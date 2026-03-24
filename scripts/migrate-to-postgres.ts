/**
 * Migration script: Seeds Postgres from local JSON/CSV files.
 *
 * Run with:  npx tsx scripts/migrate-to-postgres.ts
 *
 * Requires POSTGRES_URL env var (Neon connection string).
 */

import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(__dirname, "..", "data");
const SCHEMA_PATH = path.join(__dirname, "..", "lib", "db", "schema.sql");
const BATCH_SIZE = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanPhone(raw: unknown): string {
  let s = String(raw || "")
    .replace(/^=/, "")
    .replace(/^"/, "")
    .replace(/"$/, "");
  const d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

function parseDate(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (raw < 1 || raw > 200000) return null;
    const epoch = new Date(1899, 11, 30);
    epoch.setDate(epoch.getDate() + Math.floor(raw));
    const y = epoch.getFullYear();
    const m = String(epoch.getMonth() + 1).padStart(2, "0");
    const d = String(epoch.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(raw).replace(/"/g, "").trim();
  if (!s) return null;
  const datePart = s.split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}/.test(datePart)) return datePart.slice(0, 10);
  const slashMatch = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, "0");
    const day = slashMatch[2].padStart(2, "0");
    const year = slashMatch[3];
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${year}-${month}-${day}`;
  }
  const isoTMatch = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoTMatch) return isoTMatch[1];
  return null;
}

function parseCsvLine(line: string): string[] {
  const r: string[] = [];
  let cur = "",
    q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      r.push(cur);
      cur = "";
    } else cur += ch;
  }
  r.push(cur);
  return r;
}

async function batchInsert(
  pool: Pool,
  sql: string,
  rows: unknown[][],
  label: string
) {
  if (rows.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    // Build parameterised VALUES string
    const colCount = batch[0].length;
    const valueClauses: string[] = [];
    const params: unknown[] = [];
    for (let r = 0; r < batch.length; r++) {
      const placeholders: string[] = [];
      for (let c = 0; c < colCount; c++) {
        params.push(batch[r][c]);
        placeholders.push(`$${params.length}`);
      }
      valueClauses.push(`(${placeholders.join(",")})`);
    }
    const fullSql = `${sql} VALUES ${valueClauses.join(",")} ON CONFLICT DO NOTHING`;
    const res = await pool.query(fullSql, params);
    inserted += res.rowCount ?? 0;
    if ((i / BATCH_SIZE) % 20 === 0) {
      console.log(
        `  [${label}] ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} ...`
      );
    }
  }
  return inserted;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const connStr = process.env.POSTGRES_URL;
  if (!connStr) {
    console.error("POSTGRES_URL env var is required");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  console.log("=== APC Dashboard Postgres Migration ===\n");

  // ── Step 1: Create tables ──────────────────────────────────────────────
  console.log("1. Creating tables...");
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  await pool.query(schema);
  console.log("   Tables created.\n");

  // ── Step 2: Import list_phones from CSV files ──────────────────────────
  console.log("2. Importing list_phones from CSV files...");
  const csvFiles = [
    "BL021926BO",
    "DG021726SC",
    "JH022326MN",
    "JL021926CR",
    "JL021926LP",
    "JL022526RS",
    "RT",
  ];
  const listPhoneRows: [string, string][] = [];

  for (const listKey of csvFiles) {
    const csvPath = path.join(DATA_DIR, `${listKey}.csv`);
    if (!fs.existsSync(csvPath)) {
      console.log(`   SKIP: ${listKey}.csv not found`);
      continue;
    }
    const text = fs.readFileSync(csvPath, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) continue;

    const headers = parseCsvLine(lines[0]).map((h) =>
      h.trim().toLowerCase()
    );
    const phoneColIndices = headers
      .map((h, i) => ({ h, i }))
      .filter(
        ({ h }) =>
          h.includes("phone") ||
          h.includes("number") ||
          h.includes("cell") ||
          h.includes("mobile") ||
          h.includes("home")
      )
      .map(({ i }) => i);
    const colsToCheck =
      phoneColIndices.length > 0 ? phoneColIndices : headers.map((_, i) => i);

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      const c = parseCsvLine(l);
      for (const idx of colsToCheck) {
        const p = cleanPhone(c[idx] || "");
        if (p.length === 10) {
          listPhoneRows.push([p, listKey]);
          count++;
        }
      }
    }
    console.log(`   ${listKey}: ${count} phones`);
  }

  // Also import from list_gate.json (pre-computed phone→lists map)
  const listGatePath = path.join(DATA_DIR, "list_gate.json");
  if (fs.existsSync(listGatePath)) {
    const listGate = JSON.parse(fs.readFileSync(listGatePath, "utf8"));
    let gateCount = 0;
    for (const [phone, lists] of Object.entries(
      listGate.phoneToLists ?? {}
    )) {
      for (const listKey of lists as string[]) {
        listPhoneRows.push([phone, listKey]);
        gateCount++;
      }
    }
    console.log(`   list_gate.json: ${gateCount} phone-list pairs`);
  }

  // Deduplicate
  const listPhoneSet = new Set(listPhoneRows.map((r) => `${r[0]}|${r[1]}`));
  const dedupedListPhones = Array.from(listPhoneSet).map((s) => {
    const [phone, listKey] = s.split("|");
    return [phone, listKey];
  });

  const listInserted = await batchInsert(
    pool,
    "INSERT INTO list_phones (phone, list_key)",
    dedupedListPhones,
    "list_phones"
  );
  console.log(
    `   Inserted ${listInserted} list_phone rows (${dedupedListPhones.length} unique).\n`
  );

  // ── Step 3: Import 3CX gate data ──────────────────────────────────────
  console.log("3. Importing 3CX gate data...");
  const gatePath = path.join(DATA_DIR, "tcx_gate.json");
  let tcxMaxDate: string | null = null;

  if (fs.existsSync(gatePath)) {
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    tcxMaxDate = gate.maxDate ?? null;

    // mail4_phones
    const mail4Rows = ((gate.mail4Phones ?? []) as string[])
      .filter((p) => p.length === 10)
      .map((p) => [p]);
    const m4Inserted = await batchInsert(
      pool,
      "INSERT INTO mail4_phones (phone)",
      mail4Rows,
      "mail4_phones"
    );
    console.log(`   mail4_phones: ${m4Inserted} rows`);

    // phone_last_queue
    const plqRows: [string, string, string][] = [];
    for (const [phone, entry] of Object.entries(
      gate.phoneLastQueue ?? {}
    )) {
      const e = entry as { queue: string; date: string };
      if (phone.length === 10 && e.date) {
        plqRows.push([phone, e.queue, e.date]);
      }
    }
    const plqInserted = await batchInsert(
      pool,
      "INSERT INTO phone_last_queue (phone, queue, call_date)",
      plqRows,
      "phone_last_queue"
    );
    console.log(`   phone_last_queue: ${plqInserted} rows`);

    // opened_calls
    const openedRows: [string, string][] = [];
    for (const [date, phones] of Object.entries(
      gate.openedByDate ?? {}
    )) {
      for (const phone of phones as string[]) {
        if (phone.length === 10) {
          openedRows.push([date, phone]);
        }
      }
    }
    const ocInserted = await batchInsert(
      pool,
      "INSERT INTO opened_calls (call_date, phone)",
      openedRows,
      "opened_calls"
    );
    console.log(`   opened_calls: ${ocInserted} rows`);
  }
  console.log();

  // ── Step 4: Import AIM seed data ──────────────────────────────────────
  console.log("4. Importing AIM seed data...");
  const aimPath = path.join(DATA_DIR, "aim_seed.json");
  let aimMaxDate: string | null = null;
  let aimTransferCount = 0;

  if (fs.existsSync(aimPath)) {
    const aim = JSON.parse(fs.readFileSync(aimPath, "utf8"));

    // aim_transfers
    const transferRows: unknown[][] = [];
    for (const t of aim.transfers ?? []) {
      const phone = String(t.phone || "");
      const date = String(t.date || "");
      if (phone.length !== 10 || !date) continue;
      if (!aimMaxDate || date > aimMaxDate) aimMaxDate = date;
      transferRows.push([
        String(t.callId || `gen_${phone}_${date}`),
        phone,
        t.listKey || null,
        t.agent || null,
        date,
        t.dSec ?? 0,
        t.cost ?? 0,
      ]);
    }
    aimTransferCount = transferRows.length;
    const atInserted = await batchInsert(
      pool,
      "INSERT INTO aim_transfers (call_id, phone, list_key, agent, call_date, duration_sec, cost)",
      transferRows,
      "aim_transfers"
    );
    console.log(`   aim_transfers: ${atInserted} rows`);

    // aim_daily_costs
    const dcRows: unknown[][] = [];
    for (const [listKey, dateCosts] of Object.entries(
      (aim.dailyCosts ?? {}) as Record<
        string,
        Record<string, { min: number; cost: number }>
      >
    )) {
      for (const [date, stats] of Object.entries(dateCosts)) {
        dcRows.push([listKey, date, stats.min, stats.cost]);
      }
    }
    const dcInserted = await batchInsert(
      pool,
      "INSERT INTO aim_daily_costs (list_key, call_date, minutes, cost)",
      dcRows,
      "aim_daily_costs"
    );
    console.log(`   aim_daily_costs: ${dcInserted} rows`);

    // aim_agent_daily_costs
    const adcRows: unknown[][] = [];
    for (const [agent, dateCosts] of Object.entries(
      (aim.agentDailyCosts ?? {}) as Record<
        string,
        Record<string, { min: number; cost: number }>
      >
    )) {
      for (const [date, stats] of Object.entries(dateCosts)) {
        adcRows.push([agent, date, stats.min, stats.cost]);
      }
    }
    const adcInserted = await batchInsert(
      pool,
      "INSERT INTO aim_agent_daily_costs (agent, call_date, minutes, cost)",
      adcRows,
      "aim_agent_daily_costs"
    );
    console.log(`   aim_agent_daily_costs: ${adcInserted} rows`);

    // aim_phone_agent (from phoneToAgentAll)
    const paRows: unknown[][] = [];
    for (const [phone, entry] of Object.entries(
      (aim.phoneToAgentAll ?? {}) as Record<
        string,
        { agent: string; date?: string }
      >
    )) {
      if (phone.length === 10 && entry.agent) {
        paRows.push([phone, entry.agent, entry.date || "2026-01-01"]);
      }
    }
    const paInserted = await batchInsert(
      pool,
      "INSERT INTO aim_phone_agent (phone, agent, last_call_date)",
      paRows,
      "aim_phone_agent"
    );
    console.log(`   aim_phone_agent: ${paInserted} rows`);

    // aim_phone_history (from transfers — phone + listKey + date)
    const phSet = new Set<string>();
    const phRows: unknown[][] = [];
    for (const t of aim.transfers ?? []) {
      const phone = String(t.phone || "");
      const date = String(t.date || "");
      const listKey = String(t.listKey || "");
      if (phone.length !== 10 || !date || !listKey) continue;
      const key = `${phone}|${listKey}|${date}`;
      if (phSet.has(key)) continue;
      phSet.add(key);
      phRows.push([phone, listKey, date]);
    }
    const phInserted = await batchInsert(
      pool,
      "INSERT INTO aim_phone_history (phone, list_key, call_date)",
      phRows,
      "aim_phone_history"
    );
    console.log(`   aim_phone_history: ${phInserted} rows`);
  }
  console.log();

  // ── Step 5: Import Moxy deals ─────────────────────────────────────────
  console.log("5. Importing Moxy deals...");
  const moxyPath = path.join(DATA_DIR, "moxy_seed.json");
  let moxyMaxDate: string | null = null;
  let moxyCount = 0;

  if (fs.existsSync(moxyPath)) {
    const moxy = JSON.parse(fs.readFileSync(moxyPath, "utf8"));
    const dealRows: unknown[][] = [];

    for (const d of moxy.deals ?? []) {
      const soldDate = parseDate(d.soldDate);
      const hp = cleanPhone(d.homePhone ?? "");
      const mp = cleanPhone(d.mobilePhone ?? d.cellphone ?? d.cellPhone ?? "");
      const admin = parseFloat(String(d.admin || "0")) || 0;

      if (soldDate && (!moxyMaxDate || soldDate > moxyMaxDate)) {
        moxyMaxDate = soldDate;
      }

      dealRows.push([
        d.customerId || null,
        d.contractNo || null,
        soldDate,
        d.firstName || null,
        d.lastName || null,
        hp || null,
        mp || null,
        d.salesperson || null,
        d.dealStatus || null,
        d.promoCode || null,
        d.campaign || null,
        d.source || null,
        d.cancelReason || null,
        d.make || null,
        d.model || null,
        d.state || null,
        admin,
      ]);
    }
    moxyCount = dealRows.length;
    const mxInserted = await batchInsert(
      pool,
      "INSERT INTO moxy_deals (customer_id, contract_no, sold_date, first_name, last_name, home_phone, mobile_phone, salesperson, deal_status, promo_code, campaign, source, cancel_reason, make, model, state, admin)",
      dealRows,
      "moxy_deals"
    );
    console.log(`   moxy_deals: ${mxInserted} rows`);
  }
  console.log();

  // ── Step 6: Update seed_metadata ──────────────────────────────────────
  console.log("6. Updating seed_metadata...");
  const metaRows: [string, string | null, number][] = [
    ["aim", aimMaxDate, aimTransferCount],
    ["tcx", tcxMaxDate, 0],
    ["moxy", moxyMaxDate, moxyCount],
    ["lists", null, dedupedListPhones.length],
  ];
  for (const [source, maxDate, rowCount] of metaRows) {
    await pool.query(
      `INSERT INTO seed_metadata (source, max_date, updated_at, row_count)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (source) DO UPDATE
       SET max_date = EXCLUDED.max_date,
           updated_at = NOW(),
           row_count = EXCLUDED.row_count`,
      [source, maxDate, rowCount]
    );
  }
  console.log("   Metadata updated.\n");

  // ── Done ──────────────────────────────────────────────────────────────
  console.log("=== Migration complete! ===");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
