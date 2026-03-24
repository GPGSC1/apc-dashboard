#!/usr/bin/env node
/**
 * Seed Rebuild Script
 *
 * Converts raw CSV/XLS exports from DashBuild folder into JSON seed files.
 * Sources:
 *   ../3CX_Seed.csv   → data/tcx_seed.json
 *   ../AIM_Seed.csv   → data/aim_seed.json  (transfers + dailyCosts for ALL calls)
 *   ../MOX_Seed.xls   → data/moxy_seed.json
 *
 * Usage:
 *   node seed-rebuild.js
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const PARENT_DIR = path.join(__dirname, "..");

// ─── Helpers ───────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const cols = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function normalizePhone(raw) {
  const d = raw.replace(/^=/, "").replace(/^"/, "").replace(/"$/, "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : d.slice(-10);
}

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/"/g, "").trim();
  // "1/1/2026 0:35" → "2026-01-01"
  const datePart = s.split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}/.test(datePart)) return datePart.slice(0, 10);
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

// Parse AIM date format: "Mar 18, 2026, 11:51:49 PM" → "2026-03-18"
function parseAimDate(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/"/g, "").trim();
  // Try ISO first
  const isoM = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoM) return isoM[1];
  // "Mar 18, 2026, 11:51:49 PM"
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}

const AGENT_SHORT = {
  "Transfer Outbound Agent with Moxy": "Moxy OG",
  "Transfer Activation Outbound Agent with Moxy": "Activation",
  "Female Transfer Outbound Agent with Moxy version 3": "Female v3",
  "Transfer Outbound Agent with Moxy version 2": "Moxy v2",
  "Male Transfer Outbound Agent with Moxy version 3": "Male v3",
  "Overflow Agent with Spanish Transfer": "Overflow ES",
  "Outbound Jr. Closer to TO Agent with Moxy Tools": "Jr Closer",
};
const shortAgent = (name) => AGENT_SHORT[name] || name;

const detectListKey = (text) => {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const match10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (match10) return (match10[1] + match10[2] + match10[3]).toUpperCase();
  const match8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (match8) return (match8[1] + match8[2]).toUpperCase();
  return null;
};

const KNOWN_LISTS = ["RT", "JL021926LP", "BL021926BO", "JH022326MN", "JL021926CR", "DG021726SC", "JL022526RS"];

// ─── 1. Rebuild 3CX Seed ──────────────────────────────────────────────────
function rebuild3cx() {
  const csvPath = path.join(PARENT_DIR, "3CX_Seed.csv");
  if (!fs.existsSync(csvPath)) { console.error("[3CX] 3CX_Seed.csv not found"); return; }

  console.log("[3CX] Reading CSV...");
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split("\n");

  let headerIdx = 3;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].toLowerCase().includes("callid")) { headerIdx = i; break; }
  }

  // 3CX CSV header sometimes has extra empty columns that don't match data layout.
  // Auto-detect the correct Status column by scanning the first few data rows for
  // "answered" or "unanswered" — that gives us the true column alignment.
  let SSI = -1;
  for (let probe = headerIdx + 1; probe < Math.min(headerIdx + 100, lines.length); probe++) {
    const pc = parseCsvLine(lines[probe].trim());
    for (let j = 10; j < 16; j++) {
      const v = (pc[j] || "").trim().toLowerCase();
      if (v === "answered" || v === "unanswered") { SSI = j; break; }
    }
    if (SSI >= 0) break;
  }
  if (SSI < 0) SSI = 12; // fallback

  // All other columns are relative to Status position (which is always after Destination Name)
  const CI  = 0;                // CallID
  const STI = 1;                // Start Time
  const IOI = 3;                // In/Out
  const PHI = 8;                // Originated By (phone)
  const DNI = SSI - 1;          // Destination Name (always right before Status)
  const TTI = SSI + 2;          // Talk Time (sec) (Status + 2)
  const QI  = SSI + 7;          // Queue Name (Status + 7)

  console.log("[3CX] Auto-detected Status at col", SSI, "→ DNI=%d SSI=%d TTI=%d QI=%d", DNI, SSI, TTI, QI);

  const SALES_QUEUES = ["mail 1", "mail 2", "mail 3", "mail 4", "mail 5", "mail 6", "home 1", "home 2", "home 4", "home 5"];

  const rows = [];
  const seenIds = new Set();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < 13) continue;

    const callId = (c[CI] || "").trim();
    if (!callId || seenIds.has(callId)) continue;

    const phone = normalizePhone(c[PHI] || "");
    if (!phone || phone.length !== 10) continue;

    const queueName = (c[QI] || "").trim();
    const isSalesQueue = SALES_QUEUES.some(q => queueName.toLowerCase().includes(q));
    if (!isSalesQueue) continue;

    const startTime = (c[STI] || "").trim();
    const destName = (c[DNI] || "").trim();
    const status = (c[SSI] || "").trim().toLowerCase();
    const talkSec = parseFloat(c[TTI] || "0") || 0;
    const inOut = (c[IOI] || "").trim();

    rows.push([callId, startTime, phone, destName, status, talkSec, queueName, inOut]);
    seenIds.add(callId);
  }

  // Pre-compute mail4Phones, phoneLastQueue, and per-date stats for fast loading
  const mail4Phones = new Set();
  const phoneLastQueue = {};  // phone → { queue, date }
  let maxDate = "";

  // Per-list per-date stats for the calls route
  // listStats[listKey][date] = { total, opened, minutes }
  // We need phone→list mapping to do this, but we don't have list CSVs here.
  // Instead, pre-compute the ITD gate data that data/route.ts needs.

  for (const row of rows) {
    const [callId, startTime, phone, destName, status, talkSec, queueName, inOut] = row;
    if (phone.length !== 10 || inOut.toLowerCase() !== "inbound") continue;

    const qLower = queueName.toLowerCase();
    if (qLower.includes("mail 4")) {
      mail4Phones.add(phone);
    }

    // Track most recent sales queue call
    const dateStr = parseDate(startTime);
    if (dateStr) {
      const existing = phoneLastQueue[phone];
      if (!existing || dateStr > existing.date) {
        phoneLastQueue[phone] = { queue: qLower, date: dateStr };
      }
      if (dateStr > maxDate) maxDate = dateStr;
    }
  }

  // Only keep phoneLastQueue entries for phones in mail4Phones (used for queue recency gate)
  const filteredPLQ = {};
  for (const phone of mail4Phones) {
    if (phoneLastQueue[phone]) filteredPLQ[phone] = phoneLastQueue[phone];
  }

  // Pre-compute opened call stats per date (for data/route — avoids loading full seed at runtime)
  // openedByDate[date] = { phones: [phone1, phone2, ...] }
  const openedByDate = {};
  for (const row of rows) {
    const [callId, startTime, phone, destName, status, talkSec, queueName, inOut] = row;
    if (status !== "answered") continue;
    if (!destName || destName.toUpperCase().startsWith("AI F")) continue;
    if (talkSec <= 0) continue;
    if (!queueName.toLowerCase().includes("mail 4")) continue;
    const dt = parseDate(startTime);
    if (!dt) continue;
    if (!openedByDate[dt]) openedByDate[dt] = [];
    openedByDate[dt].push(phone);
  }

  console.log(`[3CX] Pre-computed: ${mail4Phones.size} mail4Phones, ${Object.keys(filteredPLQ).length} phoneLastQueue (filtered), ${Object.keys(openedByDate).length} opened dates, maxDate=${maxDate}`);

  const seed = {
    generatedAt: new Date().toISOString(),
    count: rows.length,
    headers: ["callId", "startTime", "phone", "destName", "status", "talkTimeSec", "queueName", "inOut"],
    rows,
  };

  // Write full seed (still needed by calls route)
  const outPath = path.join(DATA_DIR, "tcx_seed.json");
  fs.writeFileSync(outPath + ".tmp", JSON.stringify(seed));
  fs.renameSync(outPath + ".tmp", outPath);
  console.log(`[3CX] Wrote ${rows.length} rows to tcx_seed.json`);

  // Write pre-computed ITD gate data (used by data/route.ts instead of parsing 121K rows)
  const gatePath = path.join(DATA_DIR, "tcx_gate.json");
  const gateData = {
    generatedAt: new Date().toISOString(),
    maxDate,
    mail4Phones: Array.from(mail4Phones),
    phoneLastQueue: filteredPLQ,
    openedByDate,
  };
  fs.writeFileSync(gatePath + ".tmp", JSON.stringify(gateData));
  fs.renameSync(gatePath + ".tmp", gatePath);
  const gateSize = fs.statSync(gatePath).size;
  console.log(`[3CX] Wrote tcx_gate.json (${(gateSize / 1024).toFixed(0)}KB — ${mail4Phones.size} mail4, ${Object.keys(filteredPLQ).length} queues, ${Object.keys(openedByDate).length} dates)`);
}

// ─── 2. Rebuild AIM Seed ──────────────────────────────────────────────────
function rebuildAim() {
  const csvPath = path.join(PARENT_DIR, "AIM_Seed.csv");
  if (!fs.existsSync(csvPath)) { console.error("[AIM] AIM_Seed.csv not found"); return; }

  console.log("[AIM] Reading CSV (this may take a moment for 1M+ rows)...");
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split("\n");

  // Parse header
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  console.log("[AIM] Headers:", headers.join(", "));

  const idx = (name) => headers.findIndex(h => h.includes(name));
  const AGENT_NAME_I = idx("agent name");
  const FROM_I = idx("from");
  const TO_I = idx("to");
  const DUR_SEC_I = idx("duration (seconds)");
  const COST_I = idx("cost");
  const OUTCOME_I = idx("outcomes");
  const STARTED_I = idx("started at");
  const CALL_ID_I = idx("call id");
  const CAMPAIGN_I = idx("campaign name");
  const TRANSFER_DUR_I = idx("transfer call duration");

  console.log(`[AIM] Column indices: agent=${AGENT_NAME_I}, dur=${DUR_SEC_I}, cost=${COST_I}, outcome=${OUTCOME_I}, started=${STARTED_I}, callId=${CALL_ID_I}, campaign=${CAMPAIGN_I}`);

  const transfers = [];
  const seenIds = new Set();

  // dailyCosts: { listKey: { date: { min, cost } } }
  // agentDailyCosts: { agent: { date: { min, cost } } }
  const dailyCosts = {};
  const agentDailyCosts = {};

  let totalRows = 0;
  let transferCount = 0;
  let skippedNoList = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    totalRows++;

    // Parse the line carefully — AIM CSV has quoted fields with commas in dates
    const c = parseCsvLine(line);

    const callId = (c[CALL_ID_I] || "").trim();
    const agentName = (c[AGENT_NAME_I] || "").trim();
    const agent = shortAgent(agentName);
    const campaignName = (c[CAMPAIGN_I] || "").trim();
    const listKey = detectListKey(campaignName);
    const outcomeRaw = (c[OUTCOME_I] || "").trim().toLowerCase();
    const isTransfer = outcomeRaw.includes("transferred");
    const durationSec = parseFloat(c[DUR_SEC_I] || "0") || 0;
    const cost = parseFloat(c[COST_I] || "0") || 0;
    const startedAt = (c[STARTED_I] || "").trim();
    const date = parseAimDate(startedAt);
    const phone = normalizePhone(c[TO_I] || "");

    if (!listKey || !KNOWN_LISTS.includes(listKey)) { skippedNoList++; continue; }
    if (!date) continue;

    // Accumulate ALL call minutes/cost per list per day (for dial cost tracking)
    if (!dailyCosts[listKey]) dailyCosts[listKey] = {};
    if (!dailyCosts[listKey][date]) dailyCosts[listKey][date] = { min: 0, cost: 0 };
    dailyCosts[listKey][date].min += durationSec / 60;
    dailyCosts[listKey][date].cost += cost;

    // Accumulate ALL call minutes/cost per agent per day
    if (agent) {
      if (!agentDailyCosts[agent]) agentDailyCosts[agent] = {};
      if (!agentDailyCosts[agent][date]) agentDailyCosts[agent][date] = { min: 0, cost: 0 };
      agentDailyCosts[agent][date].min += durationSec / 60;
      agentDailyCosts[agent][date].cost += cost;
    }

    // Only store transfer calls in the transfers array (for phone attribution)
    if (isTransfer && phone && phone.length === 10 && callId && !seenIds.has(callId)) {
      transfers.push({
        callId,
        phone,
        listKey,
        agent,
        date,
        dSec: durationSec,
        cost,
      });
      seenIds.add(callId);
      transferCount++;
    }
  }

  // Round dailyCosts values
  for (const li of Object.keys(dailyCosts)) {
    for (const d of Object.keys(dailyCosts[li])) {
      dailyCosts[li][d].min = Math.round(dailyCosts[li][d].min);
      dailyCosts[li][d].cost = Math.round(dailyCosts[li][d].cost * 100) / 100;
    }
  }

  const seed = {
    generatedAt: new Date().toISOString(),
    count: transfers.length,
    transfers,
    dailyCosts,
    agentDailyCosts,
  };

  const outPath = path.join(DATA_DIR, "aim_seed.json");
  fs.writeFileSync(outPath + ".tmp", JSON.stringify(seed));
  fs.renameSync(outPath + ".tmp", outPath);
  console.log(`[AIM] Processed ${totalRows} total rows`);
  console.log(`[AIM] Transfers: ${transferCount}, Skipped (no list): ${skippedNoList}`);
  console.log(`[AIM] DailyCosts lists: ${Object.keys(dailyCosts).length}`);
  console.log(`[AIM] AgentDailyCosts agents: ${Object.keys(agentDailyCosts).length}`);
  console.log(`[AIM] Wrote aim_seed.json`);
}

// ─── 3. Rebuild Moxy Seed ─────────────────────────────────────────────────
function rebuildMoxy() {
  const xlsPath = path.join(PARENT_DIR, "MOX_Seed.xls");
  if (!fs.existsSync(xlsPath)) { console.error("[Moxy] MOX_Seed.xls not found"); return; }

  console.log("[Moxy] Reading XLS...");
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(xlsPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Read as array of arrays to handle the format correctly
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  // Row 0 is a timestamp, Row 1 is headers, Row 2+ is data
  const headers = rawRows[1].map(h => String(h).trim().toLowerCase());
  console.log(`[Moxy] ${rawRows.length - 2} data rows, headers: ${headers.slice(0, 15).join(", ")}`);

  // Map column indices
  const col = (name) => headers.findIndex(h => h.includes(name));
  const SOLD_DATE_I = col("sold date");
  const LAST_NAME_I = col("last name");
  const FIRST_NAME_I = col("first name");
  const STATE_I = col("state");
  const PROMO_I = col("promo code");
  const HOME_I = col("home #");
  const MOBILE_I = col("mobile #");
  const CID_I = col("customer id");
  const CAMPAIGN_I = col("campaign");
  const SOURCE_I = col("source");
  const CONTRACT_I = col("contract #");
  const MAKE_I = col("vehicle make");
  const MODEL_I = col("vehicle model");
  const STATUS_I = col("deal status");
  const CLOSER_I = col("salesperson 1");
  const CANCEL_I = col("cancel reason");

  console.log(`[Moxy] Key indices: soldDate=${SOLD_DATE_I}, cid=${CID_I}, status=${STATUS_I}, closer=${CLOSER_I}, home=${HOME_I}`);

  // Convert Excel date serial to MM/DD/YYYY (for compatibility with existing parsing)
  function excelDateToStr(val) {
    if (typeof val === "number") {
      // Excel serial date → JS date
      const d = new Date((val - 25569) * 86400000);
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return `${m}/${day}/${d.getUTCFullYear()}`;
    }
    return String(val || "");
  }

  const deals = [];
  const seenIds = new Set();

  for (let i = 2; i < rawRows.length; i++) {
    const r = rawRows[i];
    const cid = String(r[CID_I] || "").trim();
    if (!cid || seenIds.has(cid)) continue;

    const hp = String(r[HOME_I] || "").replace(/\D/g, "");
    const cp = String(r[MOBILE_I] || "").replace(/\D/g, "");
    const soldDateRaw = excelDateToStr(r[SOLD_DATE_I]);

    deals.push({
      customerId: cid,
      soldDate: soldDateRaw,
      firstName: String(r[FIRST_NAME_I] || ""),
      lastName: String(r[LAST_NAME_I] || ""),
      homePhone: hp.length === 11 && hp.startsWith("1") ? hp.slice(1) : hp,
      mobilePhone: cp.length === 11 && cp.startsWith("1") ? cp.slice(1) : cp,
      salesperson: String(r[CLOSER_I] || ""),
      dealStatus: String(r[STATUS_I] || ""),
      promoCode: String(r[PROMO_I] || ""),
      campaign: String(r[CAMPAIGN_I] || ""),
      source: String(r[SOURCE_I] || ""),
      contractNo: String(r[CONTRACT_I] || ""),
      cancelReason: String(r[CANCEL_I] || ""),
      make: String(r[MAKE_I] || ""),
      model: String(r[MODEL_I] || ""),
      state: String(r[STATE_I] || ""),
      admin: "",
    });
    seenIds.add(cid);
  }

  const seed = {
    generatedAt: new Date().toISOString(),
    count: deals.length,
    deals,
  };

  const outPath = path.join(DATA_DIR, "moxy_seed.json");
  fs.writeFileSync(outPath + ".tmp", JSON.stringify(seed));
  fs.renameSync(outPath + ".tmp", outPath);
  console.log(`[Moxy] Wrote ${deals.length} deals to moxy_seed.json`);
}

// ─── 4. Build list_gate.json (phone → list mappings from CSVs) ────────────
function rebuildListGate() {
  console.log("[Lists] Building list_gate.json from CSV files...");

  const phoneToLists = {};  // phone → [listKey1, listKey2, ...]
  const listPhoneCount = {};

  const KNOWN = ["RT", "JL021926LP", "BL021926BO", "JH022326MN", "JL021926CR", "DG021726SC", "JL022526RS"];

  for (const file of fs.readdirSync(DATA_DIR)) {
    const lower = file.toLowerCase();
    if (lower === ".gitkeep" || !lower.match(/\.csv$/i)) continue;

    const baseName = file.replace(/\.csv$/i, "");
    // Determine list key
    let listKey = null;
    if (KNOWN.includes(baseName.toUpperCase())) {
      listKey = baseName.toUpperCase();
    } else if (baseName.toLowerCase().includes("respond")) {
      listKey = "RT";
    } else {
      const m10 = baseName.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
      if (m10) listKey = (m10[1] + m10[2] + m10[3]).toUpperCase();
      else {
        const m8 = baseName.match(/([A-Za-z]{2})(\d{6})/);
        if (m8) listKey = (m8[1] + m8[2]).toUpperCase();
      }
    }
    if (!listKey) continue;

    const filePath = path.join(DATA_DIR, file);
    let text;
    try { text = fs.readFileSync(filePath, "utf8"); }
    catch { text = fs.readFileSync(filePath, "latin1"); }

    const lines = text.split(/\r?\n/);
    if (lines.length < 2) continue;

    // Parse headers to find phone columns
    const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    const phoneColIndices = headers
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h.includes("phone") || h.includes("number") || h.includes("cell") || h.includes("mobile") || h.includes("home"))
      .map(({ i }) => i);
    const colsToCheck = phoneColIndices.length > 0 ? phoneColIndices : headers.map((_, i) => i);

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      const c = parseCsvLine(l);
      for (const idx of colsToCheck) {
        let p = (c[idx] || "").replace(/\D/g, "");
        if (p.length === 11 && p.startsWith("1")) p = p.slice(1);
        if (p.length === 10) {
          if (!phoneToLists[p]) phoneToLists[p] = [];
          if (!phoneToLists[p].includes(listKey)) phoneToLists[p].push(listKey);
          count++;
        }
      }
    }
    listPhoneCount[listKey] = count;
    console.log(`[Lists]   ${file} → ${listKey}: ${count} phones`);
  }

  const totalPhones = Object.keys(phoneToLists).length;
  const gatePath = path.join(DATA_DIR, "list_gate.json");
  const gateData = {
    generatedAt: new Date().toISOString(),
    totalPhones,
    phoneToLists,
  };
  fs.writeFileSync(gatePath + ".tmp", JSON.stringify(gateData));
  fs.renameSync(gatePath + ".tmp", gatePath);
  const gateSize = fs.statSync(gatePath).size;
  console.log(`[Lists] Wrote list_gate.json (${(gateSize / 1024 / 1024).toFixed(1)}MB — ${totalPhones} unique phones)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────
function main() {
  console.log("\n=== Seed Rebuild from CSV/XLS exports ===\n");

  rebuild3cx();
  console.log("");
  rebuildAim();
  console.log("");
  rebuildMoxy();
  console.log("");
  rebuildListGate();

  console.log("\n=== Done ===\n");
}

main();
