// Rebuild Postgres tables from raw CSV/XLS exports in DashBuild folder
// Reads: AIM_Seed.csv, AIM_Seed2.csv, 3CX_Seed.csv, MOX_Seed.xls
// Writes directly to Postgres (no JSON seed files)

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const XLSX = require("xlsx");

const DASHBUILD = path.resolve(__dirname, "..");
const PG_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;

const KNOWN_LISTS = ["RT", "JL021926LP", "BL021926BO", "JH022326MN", "JL021926CR", "DG021726SC", "JL022526RS"];

function detectListKey(text) {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const m10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (m10) return (m10[1] + m10[2] + m10[3]).toUpperCase();
  const m8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (m8) return (m8[1] + m8[2]).toUpperCase();
  return null;
}

function shortAgent(name) {
  const map = {
    "Transfer Activation Outbound Agent with Moxy": "Activation",
    "Purchased Data Transfer Agent with Moxy": "Purchased Data",
    "Transfer Outbound Agent with Moxy": "Moxy OG",
    "Transfer Outbound Agent with Moxy version 2": "Moxy v2",
    "Meta Transfer Agent": "Meta Transfer Agent",
    "Cathy": "Cathy",
    "Overflow Agent with Spanish Transfer": "Overflow ES",
    "Outbound BF Agent with Moxy Tools": "BF Agent",
    "Outbound Jr. Closer to TO Agent with Moxy Tools": "Jr Closer",
    "Cancels Transfer Agent": "Cancels Transfer Agent",
  };
  return map[name] || name;
}

function normalizePhone(raw) {
  const d = raw.replace(/^=/, "").replace(/^"/, "").replace(/"$/, "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : d.slice(-10);
}

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // "Mar 21, 2026, 11:05:00 AM" format
  const m1 = s.match(/^([A-Za-z]+)\s+(\d+),\s+(\d{4})/);
  if (m1) {
    const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const mon = months[m1[1].toLowerCase().slice(0, 3)];
    if (mon) return `${m1[3]}-${mon}-${m1[2].padStart(2, "0")}`;
  }
  // ISO or YYYY-MM-DD
  const m2 = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return m2[0];
  // M/D/YYYY
  const m3 = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m3) return `${m3[3]}-${m3[1].padStart(2, "0")}-${m3[2].padStart(2, "0")}`;
  return null;
}

async function batchInsert(client, sql, colCount, rows, batchSize) {
  let total = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];
    const params = [];
    batch.forEach((row, idx) => {
      const placeholders = [];
      for (let c = 0; c < colCount; c++) {
        placeholders.push(`$${idx * colCount + c + 1}`);
        params.push(row[c]);
      }
      values.push(`(${placeholders.join(",")})`);
    });
    const fullSql = sql.replace("__VALUES__", values.join(","));
    await client.query(fullSql, params);
    total += batch.length;
  }
  return total;
}

async function main() {
  if (!PG_URL) { console.error("Set POSTGRES_URL env var"); process.exit(1); }
  const client = new Client({ connectionString: PG_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // ═══════════════════════════════════════════════════════════════════════
  // AIM: Process both CSV files
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== AIM ===");
  const aimFiles = ["AIM_Seed.csv", "AIM_Seed2.csv"].filter(f => fs.existsSync(path.join(DASHBUILD, f)));
  console.log("Files:", aimFiles);

  const seenCallIds = new Set();
  const transferRows = [];
  const phoneAgentMap = new Map(); // phone → { agent, date }
  const phoneHistoryRows = []; // [phone, listKey, date]
  const listDayCost = {}; // listKey|date → { min, cost }
  const agentDayCost = {}; // agent|date → { min, cost }

  for (const file of aimFiles) {
    const csvPath = path.join(DASHBUILD, file);
    const lines = fs.readFileSync(csvPath, "utf8").split("\n");
    const header = lines[0].split(",").map(h => h.trim().toLowerCase());

    const iAgent = header.indexOf("agent name");
    const iFrom = header.indexOf("from");
    const iTo = header.indexOf("to");
    const iDir = header.indexOf("direction");
    const iDurSec = header.indexOf("duration (seconds)");
    const iCost = header.indexOf("cost");
    const iOutcomes = header.indexOf("outcomes");
    const iStarted = header.indexOf("started at");
    const iCallId = header.indexOf("call id");
    const iCampaign = header.indexOf("campaign name");

    let processed = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Parse CSV respecting quotes
      const cols = [];
      let cur = "", inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ""; }
        else { cur += ch; }
      }
      cols.push(cur.trim());

      const callId = cols[iCallId] || "";
      if (!callId || seenCallIds.has(callId)) continue;
      seenCallIds.add(callId);

      const agentName = cols[iAgent] || "Unknown";
      const agent = shortAgent(agentName);
      const direction = (cols[iDir] || "").toLowerCase();
      const rawFrom = cols[iFrom] || "";
      const rawTo = cols[iTo] || "";
      const phone = normalizePhone(direction === "inbound" ? rawFrom : rawTo);
      const durationSec = parseFloat(cols[iDurSec]) || 0;
      const cost = parseFloat(cols[iCost]) || 0;
      const outcomes = (cols[iOutcomes] || "").toLowerCase();
      const startedAt = cols[iStarted] || "";
      const callDate = parseDate(startedAt);
      const campaignName = cols[iCampaign] || "";
      const listKey = detectListKey(campaignName);

      if (!callDate || phone.length !== 10) continue;
      processed++;

      // Phone→agent: ALL calls, no campaign filter
      if (agent && agent !== "Unknown") {
        const existing = phoneAgentMap.get(phone);
        if (!existing || callDate > existing.date) {
          phoneAgentMap.set(phone, { agent, date: callDate });
        }
      }

      // List-specific processing
      if (listKey && KNOWN_LISTS.includes(listKey)) {
        // Daily costs
        const lcKey = `${listKey}|${callDate}`;
        if (!listDayCost[lcKey]) listDayCost[lcKey] = { min: 0, cost: 0 };
        listDayCost[lcKey].min += durationSec / 60;
        listDayCost[lcKey].cost += cost;

        const acKey = `${agent}|${callDate}`;
        if (!agentDayCost[acKey]) agentDayCost[acKey] = { min: 0, cost: 0 };
        agentDayCost[acKey].min += durationSec / 60;
        agentDayCost[acKey].cost += cost;

        // Phone history for tiebreaker
        phoneHistoryRows.push([phone, listKey, callDate]);

        // Transfers
        if (outcomes.includes("transferred")) {
          transferRows.push([callId, phone, listKey, agent, callDate, Math.round(durationSec), Math.round(cost * 100) / 100]);
        }
      }
    }
    console.log(`  ${file}: ${processed} calls processed`);
  }

  console.log(`  Total unique calls: ${seenCallIds.size}`);
  console.log(`  Transfers: ${transferRows.length}`);
  console.log(`  Phone→agent mappings: ${phoneAgentMap.size}`);

  // Clear and reload AIM tables
  await client.query("DELETE FROM aim_transfers");
  await client.query("DELETE FROM aim_daily_costs");
  await client.query("DELETE FROM aim_agent_daily_costs");
  await client.query("DELETE FROM aim_phone_agent");
  await client.query("DELETE FROM aim_phone_history");

  if (transferRows.length > 0) {
    const n = await batchInsert(client,
      "INSERT INTO aim_transfers (call_id,phone,list_key,agent,call_date,duration_sec,cost) VALUES __VALUES__ ON CONFLICT DO NOTHING",
      7, transferRows, 200);
    console.log(`  Inserted ${n} transfers`);
  }

  // Daily costs
  const dcRows = [];
  for (const [key, v] of Object.entries(listDayCost)) {
    const [listKey, date] = key.split("|");
    dcRows.push([listKey, date, Math.round(v.min), Math.round(v.cost * 100) / 100]);
  }
  if (dcRows.length > 0) {
    await batchInsert(client,
      "INSERT INTO aim_daily_costs (list_key,call_date,minutes,cost) VALUES __VALUES__ ON CONFLICT (list_key,call_date) DO UPDATE SET minutes=EXCLUDED.minutes, cost=EXCLUDED.cost",
      4, dcRows, 200);
    console.log(`  Inserted ${dcRows.length} daily cost rows`);
  }

  // Agent daily costs
  const acRows = [];
  for (const [key, v] of Object.entries(agentDayCost)) {
    const [agent, date] = key.split("|");
    acRows.push([agent, date, Math.round(v.min), Math.round(v.cost * 100) / 100]);
  }
  if (acRows.length > 0) {
    await batchInsert(client,
      "INSERT INTO aim_agent_daily_costs (agent,call_date,minutes,cost) VALUES __VALUES__ ON CONFLICT (agent,call_date) DO UPDATE SET minutes=EXCLUDED.minutes, cost=EXCLUDED.cost",
      4, acRows, 200);
    console.log(`  Inserted ${acRows.length} agent daily cost rows`);
  }

  // Phone→agent
  const paRows = [];
  for (const [phone, entry] of phoneAgentMap) {
    paRows.push([phone, entry.agent, entry.date]);
  }
  if (paRows.length > 0) {
    await batchInsert(client,
      "INSERT INTO aim_phone_agent (phone,agent,last_call_date) VALUES __VALUES__ ON CONFLICT (phone) DO UPDATE SET agent=EXCLUDED.agent, last_call_date=EXCLUDED.last_call_date WHERE EXCLUDED.last_call_date >= aim_phone_agent.last_call_date",
      3, paRows, 200);
    console.log(`  Inserted ${paRows.length} phone→agent rows`);
  }

  // Phone history (dedup in memory first)
  const histSeen = new Set();
  const uniqueHist = phoneHistoryRows.filter(r => {
    const key = `${r[0]}|${r[1]}|${r[2]}`;
    if (histSeen.has(key)) return false;
    histSeen.add(key);
    return true;
  });
  if (uniqueHist.length > 0) {
    await batchInsert(client,
      "INSERT INTO aim_phone_history (phone,list_key,call_date) VALUES __VALUES__ ON CONFLICT DO NOTHING",
      3, uniqueHist, 200);
    console.log(`  Inserted ${uniqueHist.length} phone history rows`);
  }

  // Update metadata
  const aimMaxDate = transferRows.reduce((max, r) => r[4] > max ? r[4] : max, "");
  await client.query("INSERT INTO seed_metadata (source, max_date, updated_at, row_count) VALUES ('aim', $1, NOW(), $2) ON CONFLICT (source) DO UPDATE SET max_date=EXCLUDED.max_date, updated_at=NOW(), row_count=EXCLUDED.row_count",
    [aimMaxDate, seenCallIds.size]);

  // ═══════════════════════════════════════════════════════════════════════
  // 3CX
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== 3CX ===");
  const tcxPath = path.join(DASHBUILD, "3CX_Seed.csv");
  const tcxLines = fs.readFileSync(tcxPath, "utf8").split("\n");

  // Auto-detect Status column by scanning data rows
  let SSI = -1;
  for (let i = 1; i < Math.min(50, tcxLines.length); i++) {
    const cols = tcxLines[i].split(",");
    for (let c = 10; c < Math.min(20, cols.length); c++) {
      const val = (cols[c] || "").trim().toLowerCase().replace(/"/g, "");
      if (val === "answered" || val === "unanswered") { SSI = c; break; }
    }
    if (SSI >= 0) break;
  }
  console.log("  Status column index:", SSI);
  const DNI = SSI - 1;  // Destination Name
  const TTI = SSI + 2;  // Talk Time (seconds)
  const QI = SSI + 7;   // Queue

  await client.query("DELETE FROM mail4_phones");
  await client.query("DELETE FROM phone_last_queue");
  await client.query("DELETE FROM opened_calls");

  const mail4Set = new Set();
  const mail4Rows = [];
  const plqMap = new Map();
  const openedRows = [];
  const tcxSeenIds = new Set();

  for (let i = 1; i < tcxLines.length; i++) {
    const cols = tcxLines[i].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    const callId = cols[0] || "";
    if (!callId || tcxSeenIds.has(callId)) continue;
    tcxSeenIds.add(callId);

    const startTime = cols[1] || "";
    const inOut = (cols[3] || "").toLowerCase();
    const phone = normalizePhone(cols[8] || "");
    const destName = cols[DNI] || "";
    const status = (cols[SSI] || "").toLowerCase();
    const talkSec = parseInt(cols[TTI]) || 0;
    const queueName = (cols[QI] || "").toLowerCase();

    if (phone.length !== 10) continue;
    const callDate = parseDate(startTime);
    if (!callDate) continue;

    // Track inbound calls for mail4 and queue recency
    if (inOut === "inbound") {
      if (queueName.includes("mail 4") && !mail4Set.has(phone)) {
        mail4Set.add(phone);
        mail4Rows.push([phone]);
      }

      // Track most recent queue per phone
      const existing = plqMap.get(phone);
      if (!existing || callDate > existing.date) {
        plqMap.set(phone, { queue: queueName, date: callDate });
      }

      // Opened calls: answered, not AI agent, talk > 0, mail 4
      if (status === "answered" && talkSec > 0 && queueName.includes("mail 4")) {
        const isAI = destName.toLowerCase().includes("agent") || destName.toLowerCase().includes("moxy");
        if (!isAI) {
          openedRows.push([callDate, phone]);
        }
      }
    }
  }

  console.log(`  Total calls: ${tcxSeenIds.size}`);
  console.log(`  Mail 4 phones: ${mail4Rows.length}`);
  console.log(`  Opened calls: ${openedRows.length}`);

  if (mail4Rows.length > 0) {
    await batchInsert(client, "INSERT INTO mail4_phones (phone) VALUES __VALUES__ ON CONFLICT DO NOTHING", 1, mail4Rows, 500);
  }

  const plqRows = [];
  for (const [phone, entry] of plqMap) {
    plqRows.push([phone, entry.queue, entry.date]);
  }
  if (plqRows.length > 0) {
    await batchInsert(client,
      "INSERT INTO phone_last_queue (phone,queue,call_date) VALUES __VALUES__ ON CONFLICT (phone) DO UPDATE SET queue=EXCLUDED.queue, call_date=EXCLUDED.call_date WHERE EXCLUDED.call_date >= phone_last_queue.call_date",
      3, plqRows, 500);
    console.log(`  Inserted ${plqRows.length} phone_last_queue rows`);
  }

  // Dedup opened calls
  const openedSeen = new Set();
  const uniqueOpened = openedRows.filter(r => {
    const key = `${r[0]}|${r[1]}`;
    if (openedSeen.has(key)) return false;
    openedSeen.add(key);
    return true;
  });
  if (uniqueOpened.length > 0) {
    await batchInsert(client, "INSERT INTO opened_calls (call_date,phone) VALUES __VALUES__ ON CONFLICT DO NOTHING", 2, uniqueOpened, 500);
    console.log(`  Inserted ${uniqueOpened.length} opened calls`);
  }

  const tcxMaxDate = [...plqMap.values()].reduce((max, v) => v.date > max ? v.date : max, "");
  await client.query("INSERT INTO seed_metadata (source, max_date, updated_at, row_count) VALUES ('tcx', $1, NOW(), $2) ON CONFLICT (source) DO UPDATE SET max_date=EXCLUDED.max_date, updated_at=NOW(), row_count=EXCLUDED.row_count",
    [tcxMaxDate, tcxSeenIds.size]);

  // ═══════════════════════════════════════════════════════════════════════
  // MOXY
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== MOXY ===");
  const moxyPath = path.join(DASHBUILD, "MOX_Seed.xls");
  const wb = XLSX.readFile(moxyPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const allRows = XLSX.utils.sheet_to_json(ws, { defval: "", header: 1 });

  // Row 0 = timestamp, Row 1 = headers, Row 2+ = data
  // Build column index from row 1
  const hdr = allRows[1].map(h => String(h).trim().toLowerCase());
  const col = (name) => { const i = hdr.indexOf(name); return i; };
  const iSoldDate = col("sold date");
  const iLastName = col("last name");
  const iFirstName = hdr.findIndex(h => h.startsWith("first name"));
  const iState = col("state");
  const iPromo = col("promo code");
  const iHomePhone = hdr.findIndex(h => h.startsWith("home"));
  const iMobile = hdr.findIndex(h => h.startsWith("mobile") || h.startsWith("cell"));
  const iCustomerId = col("customer id");
  const iCampaign = col("campaign");
  const iSource = col("source");
  const iContractNo = hdr.findIndex(h => h.startsWith("contract"));
  const iMake = hdr.findIndex(h => h === "vehicle make" || h === "make");
  const iModel = hdr.findIndex(h => h === "vehicle model" || h === "model");
  const iDealStatus = col("deal status");
  const iSalesperson = hdr.findIndex(h => h.startsWith("salesperson") || h.startsWith("closer"));
  const iCancelReason = hdr.findIndex(h => h.startsWith("cancel reason"));
  const iAdmin = col("admin");

  console.log("  Columns detected:", { iSoldDate, iFirstName, iLastName, iHomePhone, iMobile, iCustomerId, iContractNo, iDealStatus, iSalesperson });

  function excelDateToISO(serial) {
    if (typeof serial === "number" && serial > 40000 && serial < 60000) {
      const d = new Date((serial - 25569) * 86400000);
      return d.toISOString().slice(0, 10);
    }
    return parseDate(String(serial));
  }

  await client.query("DELETE FROM moxy_deals");

  const moxyRows = [];
  const seenContracts = new Set();
  for (let i = 2; i < allRows.length; i++) {
    const r = allRows[i];
    const contractNo = String(r[iContractNo] || "").trim();
    const customerId = String(r[iCustomerId] || "").trim();
    if (contractNo && seenContracts.has(contractNo)) continue;
    if (contractNo) seenContracts.add(contractNo);

    const homePhone = normalizePhone(String(r[iHomePhone] || ""));
    const mobilePhone = normalizePhone(String(r[iMobile] || ""));
    const soldDate = excelDateToISO(r[iSoldDate]);
    const status = String(r[iDealStatus] || "").trim();
    if (!soldDate) continue;

    moxyRows.push([
      customerId, contractNo, soldDate,
      String(r[iFirstName] || "").trim(), String(r[iLastName] || "").trim(),
      homePhone, mobilePhone,
      String(r[iSalesperson] || "").trim(),
      status,
      String(r[iPromo] || "").trim(),
      String(r[iCampaign] || "").trim(),
      String(r[iSource] || "").trim(),
      String(r[iCancelReason] || "").trim(),
      String(r[iMake] || "").trim(),
      String(r[iModel] || "").trim(),
      String(r[iState] || "").trim(),
      r[iAdmin] !== undefined && r[iAdmin] !== "" ? parseFloat(r[iAdmin]) || null : null,
    ]);
  }

  console.log(`  Total deals: ${moxyRows.length}`);
  if (moxyRows.length > 0) {
    await batchInsert(client,
      "INSERT INTO moxy_deals (customer_id,contract_no,sold_date,first_name,last_name,home_phone,mobile_phone,salesperson,deal_status,promo_code,campaign,source,cancel_reason,make,model,state,admin) VALUES __VALUES__",
      17, moxyRows, 100);
    console.log(`  Inserted ${moxyRows.length} deals`);
  }

  const moxyMaxDate = moxyRows.reduce((max, r) => r[2] > max ? r[2] : max, "");
  await client.query("INSERT INTO seed_metadata (source, max_date, updated_at, row_count) VALUES ('moxy', $1, NOW(), $2) ON CONFLICT (source) DO UPDATE SET max_date=EXCLUDED.max_date, updated_at=NOW(), row_count=EXCLUDED.row_count",
    [moxyMaxDate, moxyRows.length]);

  // ═══════════════════════════════════════════════════════════════════════
  // Verify
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== VERIFICATION ===");
  const tables = ["aim_transfers", "aim_daily_costs", "aim_agent_daily_costs", "aim_phone_agent", "aim_phone_history", "mail4_phones", "phone_last_queue", "opened_calls", "moxy_deals", "list_phones"];
  for (const t of tables) {
    const r = await client.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    console.log(`  ${t}: ${r.rows[0].cnt} rows`);
  }

  // Verify Henry McDowell
  const henry = await client.query("SELECT agent FROM aim_phone_agent WHERE phone = '7022450017'");
  console.log(`\n  Henry McDowell (7022450017) agent: ${henry.rows[0]?.agent || 'NOT FOUND'}`);

  await client.end();
  console.log("\nDone!");
}

main().catch(e => { console.error(e); process.exit(1); });
