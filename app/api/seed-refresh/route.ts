import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import https from "https";

// ─── Constants ────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), "data");
const AIM_REST = "https://dash.aimnow.ai/api";
const MOXY_BASE = "https://MoxyAPI.moxyws.com";
const CT_TZ = "America/Chicago";

const SALES_QUEUES = [
  "mail 1", "mail 2", "mail 3", "mail 4", "mail 5", "mail 6",
  "home 1", "home 2", "home 4", "home 5",
];

const AGENT_SHORT: Record<string, string> = {
  "Transfer Outbound Agent with Moxy": "Moxy OG",
  "Transfer Activation Outbound Agent with Moxy": "Activation",
  "Female Transfer Outbound Agent with Moxy version 3": "Female v3",
  "Transfer Outbound Agent with Moxy version 2": "Moxy v2",
  "Male Transfer Outbound Agent with Moxy version 3": "Male v3",
  "Overflow Agent with Spanish Transfer": "Overflow ES",
  "Outbound Jr. Closer to TO Agent with Moxy Tools": "Jr Closer",
};
const shortAgent = (name: string) => AGENT_SHORT[name] || name;

const KNOWN_LISTS = ["RT", "JL021926LP", "BL021926BO", "JH022326MN", "JL021926CR", "DG021726SC", "JL022526RS"];

// ─── Time helpers ─────────────────────────────────────────────────────────────

function centralParts(): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(parts.year),
    month: parseInt(parts.month),
    day: parseInt(parts.day),
    hour: parseInt(parts.hour === "24" ? "0" : parts.hour),
    minute: parseInt(parts.minute),
    dow: dowMap[parts.weekday] ?? 0,
  };
}

function todayCentral(): string {
  const p = centralParts();
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function yesterdayCentral(): string {
  const p = centralParts();
  const d = new Date(p.year, p.month - 1, p.day);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWithinBusinessHours(): boolean {
  const p = centralParts();
  // Mon-Sat (1-6), 7:30am - 7:00pm CT
  if (p.dow === 0) return false; // Sunday
  if (p.dow > 6) return false;
  const timeMinutes = p.hour * 60 + p.minute;
  if (timeMinutes < 7 * 60 + 30) return false;  // before 7:30am
  if (timeMinutes >= 19 * 60) return false;      // after 7:00pm
  return true;
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

function parseDate(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/"/g, "").trim();
  if (!s) return null;
  const datePart = s.split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}/.test(datePart)) return datePart.slice(0, 10);
  const slashMatch = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) return `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
  const isoT = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoT) return isoT[1];
  return null;
}

function detectListKey(text: string): string | null {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const match10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (match10) return (match10[1] + match10[2] + match10[3]).toUpperCase();
  const match8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (match8) return (match8[1] + match8[2]).toUpperCase();
  return null;
}

function normalizePhone(raw: string): string {
  const d = raw.replace(/^=/, "").replace(/^"/, "").replace(/"$/, "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : d.slice(-10);
}

function customerPhone(call: any): string {
  const dir = (call.direction ?? "").toLowerCase();
  const raw = dir === "inbound" ? (call.from ?? "") : (call.to ?? "");
  return raw.replace(/\D/g, "").slice(-10);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; cookies: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", headers: { Accept: "text/html,application/xhtml+xml,*/*", ...headers }, rejectUnauthorized: false },
      (res) => {
        let d = "";
        const cookies = (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d, cookies }));
      }
    );
    req.on("error", reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<{ body: string; cookies: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() }, rejectUnauthorized: false },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          const cookies = (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
          resolve({ body: data, cookies });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

function extractViewState(html: string, field: string): string {
  const m =
    html.match(new RegExp(`id="${field}"[^>]*value="([^"]*)"`, "i")) ??
    html.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`, "i"));
  return m?.[1] ?? "";
}

// ─── AIM API helper ───────────────────────────────────────────────────────────

async function aimFetchAllCalls(params: Record<string, string | string[]>): Promise<any[]> {
  const token = process.env.AIM_BEARER_TOKEN;
  if (!token) throw new Error("AIM_BEARER_TOKEN not set");

  const buildUrl = (extraParams: Record<string, string>) => {
    const url = new URL(`${AIM_REST}/calls`);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) { for (const item of v) url.searchParams.append(k, item); }
      else url.searchParams.set(k, v);
    }
    for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
    return url.toString();
  };

  const firstResp = await fetch(buildUrl({ perPage: "500", page: "1" }), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!firstResp.ok) throw new Error(`AIM API ${firstResp.status}: ${await firstResp.text()}`);
  const firstPage = await firstResp.json();
  if (!firstPage?.data) return [];

  const results = [...firstPage.data];
  const totalPages = Math.ceil((firstPage.count ?? 0) / 500);

  if (totalPages > 1) {
    const pages = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) =>
        fetch(buildUrl({ perPage: "500", page: String(i + 2) }), {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        }).then((r) => r.json())
      )
    );
    for (const p of pages) { if (p?.data) results.push(...p.data); }
  }
  return results;
}

// ─── CSV parsing for 3CX ─────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

// ─── Atomic file write ────────────────────────────────────────────────────────

function atomicWriteJson(filePath: string, data: any): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

// ─── AIM Seed Refresh ─────────────────────────────────────────────────────────

async function refreshAimSeed(dates: string[]): Promise<{ addedTransfers: number; updatedDays: string[] }> {
  const token = process.env.AIM_BEARER_TOKEN;
  if (!token) throw new Error("AIM_BEARER_TOKEN not set");

  const seedPath = path.join(DATA_DIR, "aim_seed.json");
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

  // Build existing callId set for transfer dedup
  const existingTransferIds = new Set<string>();
  for (const t of (seed.transfers ?? [])) {
    if (t.callId) existingTransferIds.add(t.callId);
  }

  if (!seed.dailyCosts) seed.dailyCosts = {};
  if (!seed.agentDailyCosts) seed.agentDailyCosts = {};
  if (!seed.phoneToAgentAll) seed.phoneToAgentAll = {};

  let addedTransfers = 0;
  const updatedDays: string[] = [];

  for (const targetDate of dates) {
    console.log(`[seed-refresh/AIM] Fetching ${targetDate}...`);
    const fromISO = `${targetDate}T06:00:00.000Z`;
    const toISO = (() => {
      const d = new Date(targetDate + "T06:00:00.000Z");
      d.setDate(d.getDate() + 1);
      d.setSeconds(d.getSeconds() - 1);
      return d.toISOString();
    })();

    // Fetch transfer calls AND all calls in parallel
    const [transferCalls, allDialCalls] = await Promise.all([
      aimFetchAllCalls({ "startedAt[]": [fromISO, toISO], "outcomes[]": "89" }),
      aimFetchAllCalls({ "startedAt[]": [fromISO, toISO] }),
    ]);

    console.log(`[seed-refresh/AIM] ${targetDate}: ${transferCalls.length} transfers, ${allDialCalls.length} all calls`);

    // ── Transfers: dedup by callId, APPEND only new ones ──
    let dayAdded = 0;
    for (const call of transferCalls) {
      const callId = call.id || call.callId || "";
      if (!callId || existingTransferIds.has(callId)) continue;

      const phone = customerPhone(call);
      if (phone.length !== 10) continue;

      const campaignName = call.campaign?.name ?? "";
      const listKey = detectListKey(campaignName);
      if (!listKey || !KNOWN_LISTS.includes(listKey)) continue;

      const agent = shortAgent(call.agent?.name ?? "Unknown");
      const date = call.startedAt ? call.startedAt.slice(0, 10) : targetDate;
      const dSec = call.endedAt && call.startedAt
        ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
        : 0;
      const cost = call.price ?? 0;

      seed.transfers.push({ callId, phone, listKey, agent, date, dSec, cost });
      existingTransferIds.add(callId);
      dayAdded++;
    }
    addedTransfers += dayAdded;

    // ── dailyCosts / agentDailyCosts: REPLACE entire day ──
    const listMin: Record<string, number> = {};
    const listCost: Record<string, number> = {};
    const agentMin: Record<string, number> = {};
    const agentCost: Record<string, number> = {};

    for (const call of allDialCalls) {
      const campaignName = call.campaign?.name ?? "";
      const listKey = detectListKey(campaignName);
      if (!listKey || !KNOWN_LISTS.includes(listKey)) continue;

      const agent = shortAgent(call.agent?.name ?? "Unknown");
      const durationSec = call.endedAt && call.startedAt
        ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
        : 0;
      const cost = call.price ?? 0;

      listMin[listKey] = (listMin[listKey] ?? 0) + durationSec / 60;
      listCost[listKey] = (listCost[listKey] ?? 0) + cost;
      agentMin[agent] = (agentMin[agent] ?? 0) + durationSec / 60;
      agentCost[agent] = (agentCost[agent] ?? 0) + cost;

      // Track phone→agent for deal attribution (ALL calls, not just transfers)
      const phone = customerPhone(call);
      const callDate = call.startedAt ?? "";
      if (phone.length === 10 && agent && agent !== "Unknown") {
        const existing = seed.phoneToAgentAll[phone];
        if (!existing || callDate > existing.date) {
          seed.phoneToAgentAll[phone] = { agent, date: callDate };
        }
      }
    }

    // REPLACE (not accumulate) dailyCosts for this date
    for (const [li, min] of Object.entries(listMin)) {
      if (!seed.dailyCosts[li]) seed.dailyCosts[li] = {};
      seed.dailyCosts[li][targetDate] = {
        min: Math.round(min),
        cost: Math.round((listCost[li] ?? 0) * 100) / 100,
      };
    }

    // REPLACE (not accumulate) agentDailyCosts for this date
    for (const [agent, min] of Object.entries(agentMin)) {
      if (!seed.agentDailyCosts[agent]) seed.agentDailyCosts[agent] = {};
      seed.agentDailyCosts[agent][targetDate] = {
        min: Math.round(min),
        cost: Math.round((agentCost[agent] ?? 0) * 100) / 100,
      };
    }

    updatedDays.push(targetDate);
    console.log(`[seed-refresh/AIM] ${targetDate}: +${dayAdded} transfers, dailyCosts replaced for ${Object.keys(listMin).length} lists, ${Object.keys(agentMin).length} agents`);
  }

  seed.count = seed.transfers.length;
  seed.generatedAt = new Date().toISOString();
  atomicWriteJson(seedPath, seed);
  console.log(`[seed-refresh/AIM] Wrote aim_seed.json (${seed.transfers.length} transfers total)`);

  return { addedTransfers, updatedDays };
}

// ─── 3CX Seed Refresh ────────────────────────────────────────────────────────

async function refresh3cxSeed(dates: string[]): Promise<{ addedCalls: number }> {
  const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
  const username = process.env.TCX_USERNAME ?? "1911";
  const password = process.env.TCX_PASSWORD;
  if (!password) throw new Error("TCX_PASSWORD not set");

  const seedPath = path.join(DATA_DIR, "tcx_seed.json");
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

  // Build callId set for dedup
  const existingIds = new Set<string>();
  for (const row of (seed.rows ?? [])) {
    const callId = row[0];
    if (callId) existingIds.add(String(callId));
  }

  // Login to 3CX (single session for all date fetches)
  console.log(`[seed-refresh/3CX] Logging in to ${domain}...`);
  const loginPageHtml = (await httpsGet(`https://${domain}/LoginPage.aspx`)).body;
  const viewState = extractViewState(loginPageHtml, "__VIEWSTATE");
  const viewStateGen = extractViewState(loginPageHtml, "__VIEWSTATEGENERATOR");
  const eventVal = extractViewState(loginPageHtml, "__EVENTVALIDATION");
  if (!viewState) throw new Error("Could not extract ViewState from 3CX login page");

  const loginBody = new URLSearchParams({
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGen,
    __EVENTVALIDATION: eventVal,
    txtUsername: username,
    txtPassword: password,
    x: "42", y: "6",
  }).toString();

  const loginResp = await httpsPost(`https://${domain}/LoginPage.aspx`, loginBody, {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "text/html",
  });

  if (!loginResp.cookies.includes(".ASPXAUTH")) {
    throw new Error("3CX login failed — no auth cookie");
  }
  console.log(`[seed-refresh/3CX] Login successful`);

  let totalAdded = 0;

  for (const targetDate of dates) {
    console.log(`[seed-refresh/3CX] Fetching ${targetDate}...`);
    const [y, m, d] = targetDate.split("-");
    const dateFmt = `${m}/${d}/${y}`;

    const reportUrl =
      `https://${domain}/app0422/RunReportDefinitionToFile.ashx` +
      `?Output=Excel&U_ID=19978` +
      `&RD_ID=c80b90ab-0a2d-4413-b242-38e4046571f1` +
      `&Criteria=Date1%3D${encodeURIComponent(dateFmt)}%7C%7C%7C` +
      `Date2%3D${encodeURIComponent(dateFmt)}%7C%7C%7C` +
      `Extensions%3D%7C%7C%7CQueues%3D%7C%7C%7C` +
      `PageNumber%3D1%7C%7C%7CPageCnt%3D10000%7C%7C%7C` +
      `SortColumn%3D%7C%7C%7CSortAorD%3D`;

    const csvResp = await httpsGet(reportUrl, { Cookie: loginResp.cookies });
    const lines = csvResp.body.split("\n");

    // Find header row
    let headerIdx = 3;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (lines[i].toLowerCase().includes("callid")) { headerIdx = i; break; }
    }

    // Auto-detect Status column
    let SSI = -1;
    for (let probe = headerIdx + 1; probe < Math.min(headerIdx + 100, lines.length); probe++) {
      const pc = parseCsvLine(lines[probe]?.trim() ?? "");
      for (let j = 10; j < 16; j++) {
        const v = (pc[j] || "").trim().toLowerCase();
        if (v === "answered" || v === "unanswered") { SSI = j; break; }
      }
      if (SSI >= 0) break;
    }
    if (SSI < 0) SSI = 12;

    const CI = 0;
    const STI = 1;
    const IOI = 3;
    const PHI = 8;
    const DNI = SSI - 1;
    const TTI = SSI + 2;
    const QI = SSI + 7;

    let dayAdded = 0;
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
      if (!isSalesQueue) continue;

      const startTime = (c[STI] || "").trim();
      const destName = (c[DNI] || "").trim();
      const status = (c[SSI] || "").trim().toLowerCase();
      const talkSec = parseFloat(c[TTI] || "0") || 0;
      const inOut = (c[IOI] || "").trim();

      seed.rows.push([callId, startTime, phone, destName, status, talkSec, queueName, inOut]);
      existingIds.add(callId);
      dayAdded++;
    }

    totalAdded += dayAdded;
    console.log(`[seed-refresh/3CX] ${targetDate}: +${dayAdded} calls (${lines.length} CSV lines)`);
  }

  seed.count = seed.rows.length;
  seed.generatedAt = new Date().toISOString();
  atomicWriteJson(seedPath, seed);
  console.log(`[seed-refresh/3CX] Wrote tcx_seed.json (${seed.rows.length} rows total)`);

  // Rebuild tcx_gate.json from the full seed
  rebuildTcxGate(seed);

  return { addedCalls: totalAdded };
}

// ─── Rebuild tcx_gate.json ────────────────────────────────────────────────────

function rebuildTcxGate(seed: any): void {
  const mail4Phones = new Set<string>();
  const phoneLastQueue: Record<string, { queue: string; date: string }> = {};
  let maxDate = "";

  for (const row of (seed.rows ?? [])) {
    const [, startTime, phone, , , , queueName, inOut] = row;
    if (!phone || String(phone).length !== 10 || String(inOut || "").toLowerCase() !== "inbound") continue;

    const qLower = String(queueName || "").toLowerCase();
    if (qLower.includes("mail 4")) mail4Phones.add(String(phone));

    const dateStr = parseDate(startTime);
    if (dateStr) {
      const existing = phoneLastQueue[String(phone)];
      if (!existing || dateStr > existing.date) {
        phoneLastQueue[String(phone)] = { queue: qLower, date: dateStr };
      }
      if (dateStr > maxDate) maxDate = dateStr;
    }
  }

  // Only keep phoneLastQueue for mail4Phones
  const filteredPLQ: Record<string, { queue: string; date: string }> = {};
  for (const phone of mail4Phones) {
    if (phoneLastQueue[phone]) filteredPLQ[phone] = phoneLastQueue[phone];
  }

  // Pre-compute opened calls by date
  const openedByDate: Record<string, string[]> = {};
  for (const row of (seed.rows ?? [])) {
    const [, startTime, phone, destName, status, talkSec, queueName] = row;
    if (String(status) !== "answered") continue;
    if (!destName || String(destName).toUpperCase().startsWith("AI F")) continue;
    if (Number(talkSec) <= 0) continue;
    if (!String(queueName || "").toLowerCase().includes("mail 4")) continue;
    const dt = parseDate(startTime);
    if (!dt) continue;
    if (!openedByDate[dt]) openedByDate[dt] = [];
    openedByDate[dt].push(String(phone));
  }

  const gatePath = path.join(DATA_DIR, "tcx_gate.json");
  const gateData = {
    generatedAt: new Date().toISOString(),
    maxDate,
    mail4Phones: Array.from(mail4Phones),
    phoneLastQueue: filteredPLQ,
    openedByDate,
  };
  atomicWriteJson(gatePath, gateData);
  const gateSize = fs.statSync(gatePath).size;
  console.log(`[seed-refresh/3CX] Rebuilt tcx_gate.json (${(gateSize / 1024).toFixed(0)}KB — ${mail4Phones.size} mail4, ${Object.keys(filteredPLQ).length} queues, ${Object.keys(openedByDate).length} dates)`);
}

// ─── Moxy Seed Refresh ───────────────────────────────────────────────────────

async function refreshMoxySeed(dates: string[]): Promise<{ addedDeals: number }> {
  const moxyKey = process.env.MOXY_API_KEY ?? "a242ccb0-738e-4e4f-a418-facf89297904";

  const seedPath = path.join(DATA_DIR, "moxy_seed.json");
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

  // Build dedup set from both customerId AND contractNo
  const existingIds = new Set<string>();
  for (const d of (seed.deals ?? [])) {
    const cid = String(d.customerId ?? "").trim();
    const cno = String(d.contractNo ?? "").trim();
    if (cid) existingIds.add("cid:" + cid);
    if (cno) existingIds.add("cno:" + cno);
  }

  // Determine fetch range: min date to max date + 1 day
  const sortedDates = [...dates].sort();
  const fromDate = sortedDates[0];
  const toDate = addDays(sortedDates[sortedDates.length - 1], 1); // exclusive

  console.log(`[seed-refresh/Moxy] Fetching deals ${fromDate} to ${toDate}...`);

  const url = `${MOXY_BASE}/api/GetDealLog?fromDate=${fromDate}&toDate=${toDate}&dealType=Both`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${moxyKey}` },
    cache: "no-store",
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Moxy API ${resp.status}: ${errText}`);
  }

  const deals: Record<string, unknown>[] = await resp.json();
  console.log(`[seed-refresh/Moxy] API returned ${deals.length} deals`);

  let addedDeals = 0;
  for (const d of deals) {
    const cid = String((d as any).customerId ?? (d as any).customerID ?? (d as any).customerNo ?? "").trim();
    const cno = String((d as any).contractNo ?? "").trim();

    // DEDUP: skip if customerId OR contractNo already exists
    if ((cid && existingIds.has("cid:" + cid)) || (cno && existingIds.has("cno:" + cno))) continue;
    if (!cid && !cno) continue; // no identifier at all

    const hp = String((d as any).homePhone ?? "").replace(/\D/g, "");
    const cp = String((d as any).cellphone ?? (d as any).cellPhone ?? (d as any).mobilePhone ?? "").replace(/\D/g, "");

    seed.deals.push({
      customerId: cid,
      soldDate: String((d as any).soldDate ?? ""),
      firstName: String((d as any).firstName ?? ""),
      lastName: String((d as any).lastName ?? ""),
      homePhone: hp.length === 11 && hp.startsWith("1") ? hp.slice(1) : hp,
      mobilePhone: cp.length === 11 && cp.startsWith("1") ? cp.slice(1) : cp,
      salesperson: String((d as any).closer ?? (d as any).salesRep ?? (d as any).salesperson ?? ""),
      dealStatus: String((d as any).dealStatus ?? (d as any).status ?? ""),
      promoCode: String((d as any).promoCode ?? ""),
      campaign: String((d as any).campaign ?? (d as any).campaignName ?? ""),
      source: String((d as any).source ?? ""),
      contractNo: cno,
      cancelReason: String((d as any).cancelReason ?? ""),
      make: String((d as any).make ?? ""),
      model: String((d as any).model ?? ""),
      state: String((d as any).state ?? ""),
      admin: String((d as any).admin ?? ""),
    });

    if (cid) existingIds.add("cid:" + cid);
    if (cno) existingIds.add("cno:" + cno);
    addedDeals++;
  }

  seed.count = seed.deals.length;
  seed.generatedAt = new Date().toISOString();
  atomicWriteJson(seedPath, seed);
  console.log(`[seed-refresh/Moxy] Wrote moxy_seed.json (+${addedDeals} deals, ${seed.deals.length} total)`);

  return { addedDeals };
}

// ─── Main Route Handler ───────────────────────────────────────────────────────

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET() {
  const startTime = Date.now();
  const p = centralParts();
  const ctNow = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} CT (dow=${p.dow})`;

  console.log(`[seed-refresh] Triggered at ${ctNow}`);

  // Gate: only run during business hours (Mon-Sat, 7:30am-7:00pm CT)
  if (!isWithinBusinessHours()) {
    console.log(`[seed-refresh] Outside business hours, skipping`);
    return NextResponse.json({ ok: true, skipped: true, reason: "outside business hours", ctNow });
  }

  try {
    const today = todayCentral();
    const yesterday = yesterdayCentral();

    // Determine which dates to fetch.
    // Read seed max dates to decide if we need yesterday too.
    let aimSeedMaxDate = "";
    try {
      const aimSeed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "aim_seed.json"), "utf8"));
      for (const t of (aimSeed.transfers ?? [])) {
        if (t.date && t.date > aimSeedMaxDate) aimSeedMaxDate = t.date;
      }
    } catch { /* empty seed */ }

    // If seed's max date is before yesterday, we need to catch up yesterday + today
    // Otherwise just today (dailyCosts get REPLACED so today is always fresh)
    const datesToFetch = aimSeedMaxDate < yesterday
      ? [yesterday, today]
      : [today];

    console.log(`[seed-refresh] Seed max date: ${aimSeedMaxDate || "(empty)"}, fetching: ${datesToFetch.join(", ")}`);

    // Run all three seed refreshes
    const results = await Promise.allSettled([
      refreshAimSeed(datesToFetch),
      refresh3cxSeed(datesToFetch),
      refreshMoxySeed(datesToFetch),
    ]);

    const aimResult = results[0].status === "fulfilled" ? results[0].value : { error: String((results[0] as PromiseRejectedResult).reason) };
    const tcxResult = results[1].status === "fulfilled" ? results[1].value : { error: String((results[1] as PromiseRejectedResult).reason) };
    const moxyResult = results[2].status === "fulfilled" ? results[2].value : { error: String((results[2] as PromiseRejectedResult).reason) };

    for (const r of results) {
      if (r.status === "rejected") console.error("[seed-refresh] Error:", r.reason);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[seed-refresh] Complete in ${elapsed}s — AIM: ${JSON.stringify(aimResult)}, 3CX: ${JSON.stringify(tcxResult)}, Moxy: ${JSON.stringify(moxyResult)}`);

    return NextResponse.json({
      ok: true,
      ctNow,
      datesToFetch,
      elapsed: `${elapsed}s`,
      aim: aimResult,
      tcx: tcxResult,
      moxy: moxyResult,
    });
  } catch (err) {
    console.error("[seed-refresh] Fatal error:", err);
    return NextResponse.json({ ok: false, error: String(err), ctNow }, { status: 500 });
  }
}
