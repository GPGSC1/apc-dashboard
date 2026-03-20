#!/usr/bin/env node
/**
 * Nightly Seed Update Script
 *
 * Fetches yesterday's data from AIM, 3CX, and Moxy APIs,
 * then appends to seed JSON files with ID-only dedup.
 *
 * Usage:
 *   node seed-update.js              # defaults to yesterday (Central Time)
 *   node seed-update.js --date 2026-03-18   # specific date
 *
 * Requires .env.local with:
 *   AIM_BEARER_TOKEN, TCX_DOMAIN, TCX_USERNAME, TCX_PASSWORD, MOXY_BEARER
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// ─── Load .env.local ────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}

const DATA_DIR = path.join(__dirname, "data");
const AIM_REST = "https://dash.aimnow.ai/api";
const MOXY_BASE = "https://MoxyAPI.moxyws.com";
const MOXY_BEARER = process.env.MOXY_BEARER || "a242ccb0-738e-4e4f-a418-facf89297904";

// ─── Date helpers (no UTC shift) ────────────────────────────────────────────
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/"/g, "").trim();
  const datePart = s.split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}/.test(datePart)) return datePart.slice(0, 10);
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const isoT = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoT) return isoT[1];
  return null;
}

function yesterdayCentral() {
  const now = new Date();
  const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  ct.setDate(ct.getDate() - 1);
  const y = ct.getFullYear();
  const m = String(ct.getMonth() + 1).padStart(2, "0");
  const d = String(ct.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getTargetDate() {
  const idx = process.argv.indexOf("--date");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return yesterdayCentral();
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on("error", reject);
    req.end();
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers },
      (res) => {
        let d = "";
        const cookies = (res.headers["set-cookie"] || []).join("; ");
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ body: d, cookies, status: res.statusCode }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── AIM Seed Update ────────────────────────────────────────────────────────
async function updateAimSeed(targetDate) {
  const token = process.env.AIM_BEARER_TOKEN;
  if (!token) { console.warn("[AIM] No AIM_BEARER_TOKEN, skipping"); return; }

  const seedPath = path.join(DATA_DIR, "aim_seed.json");
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

  const existingIds = new Set(seed.transfers.map((t) => t.callId).filter(Boolean));

  // Fetch transferred calls for the target date
  const fromISO = `${targetDate}T06:00:00.000Z`;
  const toISO = `${targetDate}T06:00:00.000Z`.replace(targetDate, (() => {
    const d = new Date(targetDate + "T12:00:00Z");
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })());

  let allCalls = [];
  let page = 1;
  while (true) {
    const url = `${AIM_REST}/calls?startedAt[]=${encodeURIComponent(fromISO)}&startedAt[]=${encodeURIComponent(toISO)}&outcomes[]=89&perPage=500&page=${page}`;
    const resp = await httpGet(url, { Authorization: `Bearer ${token}` });
    const data = JSON.parse(resp.body);
    if (!data.data || data.data.length === 0) break;
    allCalls.push(...data.data);
    if (allCalls.length >= (data.count || 0)) break;
    page++;
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

  // Extract customer phone based on call direction
  function customerPhoneFromCall(c) {
    const dir = (c.direction || "").toLowerCase();
    const raw = dir === "inbound" ? (c.from || "") : (c.to || "");
    return raw.replace(/\D/g, "").slice(-10);
  }

  let added = 0;
  for (const call of allCalls) {
    const callId = call.id || call.callId || "";
    if (existingIds.has(callId)) continue;

    const phone = customerPhoneFromCall(call);
    if (phone.length !== 10) continue;

    const campaignName = call.campaign?.name || "";
    let listKey = null;
    if (campaignName.toLowerCase().includes("respond")) listKey = "RT";
    else {
      const m = campaignName.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
      if (m) listKey = (m[1] + m[2] + m[3]).toUpperCase();
    }
    if (!listKey) continue;

    const agent = AGENT_SHORT[call.agent?.name || ""] || call.agent?.name || "Unknown";
    const date = call.startedAt ? call.startedAt.slice(0, 10) : targetDate;
    const dSec = call.endedAt && call.startedAt
      ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
      : 0;
    const cost = call.price || 0;

    seed.transfers.push({ callId, phone, listKey, agent, date, dSec, cost });
    existingIds.add(callId);
    added++;
  }

  // Update dailyCosts and agentDailyCosts from ALL calls (not just transfers)
  if (!seed.dailyCosts) seed.dailyCosts = {};
  if (!seed.agentDailyCosts) seed.agentDailyCosts = {};

  try {
    // Fetch ALL calls for the date (paginated)
    let allDialCalls = [];
    let pg = 1;
    while (true) {
      const url = `${AIM_REST}/calls?startedAt[]=${encodeURIComponent(fromISO)}&startedAt[]=${encodeURIComponent(toISO)}&perPage=500&page=${pg}`;
      const resp = await httpGet(url, { Authorization: `Bearer ${token}` });
      const data = JSON.parse(resp.body);
      if (!data.data || data.data.length === 0) break;
      allDialCalls.push(...data.data);
      if (allDialCalls.length >= (data.count || 0)) break;
      pg++;
    }
    console.log(`[AIM] Fetched ${allDialCalls.length} total calls for ${targetDate}`);

    // Accumulate per-list and per-agent minutes/cost
    const listMin = {}, listCost = {}, agentMin = {}, agentCost = {};
    for (const call of allDialCalls) {
      const campaignName = call.campaign?.name || "";
      let listKey = null;
      if (campaignName.toLowerCase().includes("respond")) listKey = "RT";
      else {
        const m = campaignName.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
        if (m) listKey = (m[1] + m[2] + m[3]).toUpperCase();
      }
      if (!listKey) continue;

      const agent = AGENT_SHORT[call.agent?.name || ""] || call.agent?.name || "Unknown";
      const dSec = call.endedAt && call.startedAt
        ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
        : 0;
      const cost = call.price || 0;

      listMin[listKey] = (listMin[listKey] || 0) + dSec / 60;
      listCost[listKey] = (listCost[listKey] || 0) + cost;
      agentMin[agent] = (agentMin[agent] || 0) + dSec / 60;
      agentCost[agent] = (agentCost[agent] || 0) + cost;

      // Track most recent agent for each phone (ALL calls, not just transfers)
      const phone = customerPhoneFromCall(call);
      const callDate = call.startedAt || "";
      if (phone.length === 10 && agent && agent !== "Unknown") {
        const existing = seed.phoneToAgentAll?.[phone];
        if (!existing || callDate > existing.date) {
          if (!seed.phoneToAgentAll) seed.phoneToAgentAll = {};
          seed.phoneToAgentAll[phone] = { agent, date: callDate };
        }
      }
    }

    // Write per-list dailyCosts
    for (const [li, min] of Object.entries(listMin)) {
      if (!seed.dailyCosts[li]) seed.dailyCosts[li] = {};
      seed.dailyCosts[li][targetDate] = {
        min: Math.round(min),
        cost: Math.round((listCost[li] || 0) * 100) / 100,
      };
    }

    // Write per-agent agentDailyCosts
    for (const [agent, min] of Object.entries(agentMin)) {
      if (!seed.agentDailyCosts[agent]) seed.agentDailyCosts[agent] = {};
      seed.agentDailyCosts[agent][targetDate] = {
        min: Math.round(min),
        cost: Math.round((agentCost[agent] || 0) * 100) / 100,
      };
    }
  } catch (e) {
    console.warn("[AIM] dailyCosts update failed:", e.message);
  }

  seed.count = seed.transfers.length;
  const tmpPath = seedPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(seed));
  fs.renameSync(tmpPath, seedPath);
  console.log(`[AIM] Added ${added} transfers for ${targetDate} (total: ${seed.count})`);
}

// ─── 3CX Seed Update ───────────────────────────────────────────────────────
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

function extractViewState(html, field) {
  let m = html.match(new RegExp(`id="${field}"[^>]*value="([^"]*)"`, "i"));
  if (m) return m[1];
  m = html.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

async function update3cxSeed(targetDate) {
  const domain = process.env.TCX_DOMAIN || "gpgsc.innicom.com";
  const username = process.env.TCX_USERNAME || "1911";
  const password = process.env.TCX_PASSWORD;
  if (!password) { console.warn("[3CX] No TCX_PASSWORD, skipping"); return; }

  const seedPath = path.join(DATA_DIR, "tcx_seed.json");
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

  const existingIds = new Set(seed.rows.map((r) => r[0]));

  // Login to 3CX
  const loginPage = await httpGet(`https://${domain}/LoginPage.aspx`);
  const viewState = extractViewState(loginPage.body, "__VIEWSTATE");
  const viewStateGen = extractViewState(loginPage.body, "__VIEWSTATEGENERATOR");
  const eventVal = extractViewState(loginPage.body, "__EVENTVALIDATION");

  if (!viewState) { console.error("[3CX] Could not extract ViewState"); return; }

  const loginBody = new URLSearchParams({
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGen,
    __EVENTVALIDATION: eventVal,
    txtUsername: username,
    txtPassword: password,
    x: "42", y: "6",
  }).toString();

  const loginResp = await httpPost(`https://${domain}/LoginPage.aspx`, loginBody, {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "text/html",
  });

  if (!loginResp.cookies.includes(".ASPXAUTH")) {
    console.error("[3CX] Login failed — no auth cookie"); return;
  }

  // Format date for 3CX (MM/DD/YYYY)
  const [y, m, d] = targetDate.split("-");
  const fromFmt = `${m}/${d}/${y}`;
  const toFmt = fromFmt;

  const reportUrl =
    `https://${domain}/app0422/RunReportDefinitionToFile.ashx` +
    `?Output=Excel&U_ID=19978` +
    `&RD_ID=c80b90ab-0a2d-4413-b242-38e4046571f1` +
    `&Criteria=Date1%3D${encodeURIComponent(fromFmt)}%7C%7C%7C` +
    `Date2%3D${encodeURIComponent(toFmt)}%7C%7C%7C` +
    `Extensions%3D%7C%7C%7CQueues%3D%7C%7C%7C` +
    `PageNumber%3D1%7C%7C%7CPageCnt%3D10000%7C%7C%7C` +
    `SortColumn%3D%7C%7C%7CSortAorD%3D`;

  const csvResp = await httpGet(reportUrl, { Cookie: loginResp.cookies });
  const lines = csvResp.body.split("\n");

  // Find header row
  let headerIdx = 3;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].toLowerCase().includes("callid")) { headerIdx = i; break; }
  }

  const headers = parseCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase());
  const find = (...names) => {
    for (const n of names) { const i = headers.findIndex((h) => h === n); if (i >= 0) return i; }
    for (const n of names) { const i = headers.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
    return -1;
  };

  const CI = find("callid") >= 0 ? find("callid") : 0;
  const STI = find("start time") >= 0 ? find("start time") : 1;
  const PHI = find("originated by") >= 0 ? find("originated by") : 8;
  const DNI = find("destination name") >= 0 ? find("destination name") : 11;
  const SSI = find("status") >= 0 ? find("status") : 12;
  const TTI = find("talk time (sec)") >= 0 ? find("talk time (sec)") : 14;
  const QI = find("queue name") >= 0 ? find("queue name") : 19;
  const IOI = find("in/out") >= 0 ? find("in/out") : find("direction") >= 0 ? find("direction") : 20;

  const SALES_QUEUES = ["mail 1", "mail 2", "mail 3", "mail 4", "mail 5", "mail 6", "home 1", "home 2", "home 4", "home 5"];

  let added = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < 13) continue;

    const callId = (c[CI] || "").trim();
    if (!callId || existingIds.has(callId)) continue;

    const phone = normalizePhone(c[PHI] || "");
    if (!phone || phone.length !== 10) continue;

    const queueName = (c[QI] || "").trim();
    const isSalesQueue = SALES_QUEUES.some((q) => queueName.toLowerCase().includes(q));
    if (!isSalesQueue) continue; // Only store sales queue calls

    const startTime = (c[STI] || "").trim();
    const destName = (c[DNI] || "").trim();
    const status = (c[SSI] || "").trim().toLowerCase();
    const talkSec = parseFloat(c[TTI] || "0") || 0;
    const inOut = (c[IOI] || "").trim();

    seed.rows.push([callId, startTime, phone, destName, status, talkSec, queueName, inOut]);
    existingIds.add(callId);
    added++;
  }

  seed.count = seed.rows.length;
  const tmpPath = seedPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(seed));
  fs.renameSync(tmpPath, seedPath);
  console.log(`[3CX] Added ${added} calls for ${targetDate} (total: ${seed.count})`);

  // Rebuild tcx_gate.json from the updated seed
  rebuildTcxGate(seed);
}

function rebuildTcxGate(seed) {
  const mail4Phones = new Set();
  const phoneLastQueue = {};
  let maxDate = "";

  for (const row of seed.rows) {
    const [callId, startTime, phone, destName, status, talkSec, queueName, inOut] = row;
    if (phone.length !== 10 || (inOut || "").toLowerCase() !== "inbound") continue;

    const qLower = (queueName || "").toLowerCase();
    if (qLower.includes("mail 4")) mail4Phones.add(phone);

    const dateStr = parseDate(startTime);
    if (dateStr) {
      const existing = phoneLastQueue[phone];
      if (!existing || dateStr > existing.date) {
        phoneLastQueue[phone] = { queue: qLower, date: dateStr };
      }
      if (dateStr > maxDate) maxDate = dateStr;
    }
  }

  // Only keep phoneLastQueue for mail4Phones
  const filteredPLQ = {};
  for (const phone of mail4Phones) {
    if (phoneLastQueue[phone]) filteredPLQ[phone] = phoneLastQueue[phone];
  }

  // Pre-compute opened calls by date
  const openedByDate = {};
  for (const row of seed.rows) {
    const [callId, startTime, phone, destName, status, talkSec, queueName] = row;
    if (status !== "answered") continue;
    if (!destName || destName.toUpperCase().startsWith("AI F")) continue;
    if (talkSec <= 0) continue;
    if (!(queueName || "").toLowerCase().includes("mail 4")) continue;
    const dt = parseDate(startTime);
    if (!dt) continue;
    if (!openedByDate[dt]) openedByDate[dt] = [];
    openedByDate[dt].push(phone);
  }

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
  console.log(`[3CX] Rebuilt tcx_gate.json (${mail4Phones.size} mail4, ${Object.keys(filteredPLQ).length} queues)`);
}

// ─── Moxy Seed Update ──────────────────────────────────────────────────────
async function updateMoxySeed(targetDate) {
  const seedPath = path.join(DATA_DIR, "moxy_seed.json");
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

  const existingIds = new Set((seed.deals || []).map((d) => String(d.customerId)).filter(Boolean));

  // Fetch deals for the target date (toDate is exclusive, so +1 day)
  const nextDay = (() => {
    const d = new Date(targetDate + "T12:00:00Z");
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const url = `${MOXY_BASE}/api/GetDealLog?fromDate=${targetDate}&toDate=${nextDay}&dealType=Both`;
  const resp = await httpGet(url, { Authorization: `Bearer ${MOXY_BEARER}` });

  if (resp.status !== 200) {
    console.error(`[Moxy] API returned ${resp.status}`); return;
  }

  const deals = JSON.parse(resp.body);
  let added = 0;

  for (const d of deals) {
    const cid = String(d.customerId || d.customerID || d.customerNo || "");
    if (!cid || existingIds.has(cid)) continue;

    const hp = (d.homePhone || "").replace(/\D/g, "");
    const cp = (d.cellphone || d.cellPhone || "").replace(/\D/g, "");

    seed.deals.push({
      customerId: cid,
      soldDate: String(d.soldDate || ""),
      firstName: String(d.firstName || ""),
      lastName: String(d.lastName || ""),
      homePhone: hp.length === 11 && hp.startsWith("1") ? hp.slice(1) : hp,
      mobilePhone: cp.length === 11 && cp.startsWith("1") ? cp.slice(1) : cp,
      salesperson: String(d.closer || d.salesRep || ""),
      dealStatus: String(d.dealStatus || d.status || ""),
      promoCode: String(d.promoCode || ""),
      campaign: String(d.campaign || ""),
      source: String(d.source || ""),
      contractNo: String(d.contractNo || ""),
      cancelReason: String(d.cancelReason || ""),
      make: String(d.make || ""),
      model: String(d.model || ""),
      state: String(d.state || ""),
      admin: String(d.admin || ""),
    });
    existingIds.add(cid);
    added++;
  }

  const tmpPath = seedPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(seed));
  fs.renameSync(tmpPath, seedPath);
  console.log(`[Moxy] Added ${added} deals for ${targetDate} (total: ${seed.deals.length})`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const targetDate = getTargetDate();
  console.log(`\n=== Seed Update: ${targetDate} ===\n`);

  const results = await Promise.allSettled([
    updateAimSeed(targetDate),
    update3cxSeed(targetDate),
    updateMoxySeed(targetDate),
  ]);

  for (const r of results) {
    if (r.status === "rejected") console.error("Error:", r.reason);
  }

  console.log("\n=== Done ===\n");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
