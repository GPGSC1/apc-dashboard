import { NextResponse } from "next/server";
import https from "https";
import { query } from "../../../lib/db/connection";

// ─── Constants ────────────────────────────────────────────────────────────────
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ─── Batch insert helper ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function batchInsert(
  sql: string,
  colCount: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[][],
  batchSize = 200
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vals: any[] = [];
    const placeholders = batch.map((row, j) => {
      const off = j * colCount;
      vals.push(...row);
      return `(${Array.from({ length: colCount }, (_, k) => `$${off + k + 1}`).join(",")})`;
    }).join(",");
    if (placeholders) {
      const result = await query(sql.replace("__VALUES__", placeholders), vals);
      inserted += result.rowCount ?? batch.length;
    }
  }
  return inserted;
}

// ─── AIM: Direct to Postgres ──────────────────────────────────────────────────

async function refreshAim(dates: string[]): Promise<{ addedTransfers: number; updatedDays: string[] }> {
  const token = process.env.AIM_BEARER_TOKEN;
  if (!token) throw new Error("AIM_BEARER_TOKEN not set");

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

    // ── Transfers: INSERT ON CONFLICT DO NOTHING ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transferRows: any[][] = [];
    for (const call of transferCalls) {
      const callId = call.id || call.callId || "";
      if (!callId) continue;

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

      transferRows.push([callId, phone, listKey, agent, date, dSec, cost]);
    }

    if (transferRows.length > 0) {
      const inserted = await batchInsert(
        `INSERT INTO aim_transfers (call_id,phone,list_key,agent,call_date,duration_sec,cost) VALUES __VALUES__ ON CONFLICT DO NOTHING`,
        7, transferRows, 200
      );
      addedTransfers += inserted;
    }

    // ── dailyCosts / agentDailyCosts: compute from all calls, UPSERT ──
    const listMin: Record<string, number> = {};
    const listCost: Record<string, number> = {};
    const agentMin: Record<string, number> = {};
    const agentCost: Record<string, number> = {};
    // phone→agent tracking
    const phoneAgentMap: Map<string, { agent: string; date: string }> = new Map();
    // phone history tracking
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const phoneHistoryRows: any[][] = [];

    for (const call of allDialCalls) {
      const agent = shortAgent(call.agent?.name ?? "Unknown");
      const phone = customerPhone(call);
      const callDate = call.startedAt ?? "";

      // Phone→agent mapping: track ALL calls regardless of campaign
      // This ensures inbound callbacks and non-tracked campaigns still
      // get agent attribution for deal counting
      if (phone.length === 10 && agent && agent !== "Unknown") {
        const existing = phoneAgentMap.get(phone);
        if (!existing || callDate > existing.date) {
          phoneAgentMap.set(phone, { agent, date: callDate });
        }
      }

      // List-specific metrics: only for known campaign lists
      const campaignName = call.campaign?.name ?? "";
      const listKey = detectListKey(campaignName);
      if (!listKey || !KNOWN_LISTS.includes(listKey)) continue;

      const durationSec = call.endedAt && call.startedAt
        ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
        : 0;
      const cost = call.price ?? 0;

      listMin[listKey] = (listMin[listKey] ?? 0) + durationSec / 60;
      listCost[listKey] = (listCost[listKey] ?? 0) + cost;
      agentMin[agent] = (agentMin[agent] ?? 0) + durationSec / 60;
      agentCost[agent] = (agentCost[agent] ?? 0) + cost;

      // Track phone history for list tiebreaker
      if (phone.length === 10) {
        const dateOnly = callDate.slice(0, 10) || targetDate;
        phoneHistoryRows.push([phone, listKey, dateOnly]);
      }
    }

    // UPSERT aim_daily_costs for this date
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dailyCostRows: any[][] = [];
    for (const [li, min] of Object.entries(listMin)) {
      dailyCostRows.push([li, targetDate, Math.round(min), Math.round((listCost[li] ?? 0) * 100) / 100]);
    }
    if (dailyCostRows.length > 0) {
      await batchInsert(
        `INSERT INTO aim_daily_costs (list_key,call_date,minutes,cost) VALUES __VALUES__ ON CONFLICT (list_key,call_date) DO UPDATE SET minutes=EXCLUDED.minutes, cost=EXCLUDED.cost`,
        4, dailyCostRows, 200
      );
    }

    // UPSERT aim_agent_daily_costs for this date
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentCostRows: any[][] = [];
    for (const [agent, min] of Object.entries(agentMin)) {
      agentCostRows.push([agent, targetDate, Math.round(min), Math.round((agentCost[agent] ?? 0) * 100) / 100]);
    }
    if (agentCostRows.length > 0) {
      await batchInsert(
        `INSERT INTO aim_agent_daily_costs (agent,call_date,minutes,cost) VALUES __VALUES__ ON CONFLICT (agent,call_date) DO UPDATE SET minutes=EXCLUDED.minutes, cost=EXCLUDED.cost`,
        4, agentCostRows, 200
      );
    }

    // UPSERT aim_phone_agent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const phoneAgentRows: any[][] = [];
    for (const [phone, entry] of phoneAgentMap) {
      phoneAgentRows.push([phone, entry.agent, entry.date.slice(0, 10) || targetDate]);
    }
    if (phoneAgentRows.length > 0) {
      await batchInsert(
        `INSERT INTO aim_phone_agent (phone,agent,last_call_date) VALUES __VALUES__ ON CONFLICT (phone) DO UPDATE SET agent=EXCLUDED.agent, last_call_date=EXCLUDED.last_call_date WHERE EXCLUDED.last_call_date >= aim_phone_agent.last_call_date`,
        3, phoneAgentRows, 200
      );
    }

    // INSERT aim_phone_history ON CONFLICT DO NOTHING
    if (phoneHistoryRows.length > 0) {
      // Deduplicate in-memory first (same phone+list+date)
      const seen = new Set<string>();
      const uniqueRows = phoneHistoryRows.filter((r) => {
        const key = `${r[0]}|${r[1]}|${r[2]}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await batchInsert(
        `INSERT INTO aim_phone_history (phone,list_key,call_date) VALUES __VALUES__ ON CONFLICT DO NOTHING`,
        3, uniqueRows, 300
      );
    }

    updatedDays.push(targetDate);
    console.log(`[seed-refresh/AIM] ${targetDate}: ${transferRows.length} transfer rows, ${Object.keys(listMin).length} lists, ${Object.keys(agentMin).length} agents, ${phoneAgentMap.size} phone-agent, ${phoneHistoryRows.length} history`);
  }

  // Update metadata
  await query(
    `INSERT INTO seed_metadata (source, max_date, updated_at) VALUES ('aim', $1, NOW()) ON CONFLICT (source) DO UPDATE SET max_date=GREATEST(seed_metadata.max_date, $1), updated_at=NOW()`,
    [dates[dates.length - 1]]
  );

  return { addedTransfers, updatedDays };
}

// ─── 3CX: Direct to Postgres ─────────────────────────────────────────────────

async function refresh3cx(dates: string[]): Promise<{ addedCalls: number }> {
  const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
  const username = process.env.TCX_USERNAME ?? "1911";
  const password = process.env.TCX_PASSWORD;
  if (!password) throw new Error("TCX_PASSWORD not set");

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

    // Collect rows for batch inserts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mail4PhoneRows: any[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const phoneLastQueueRows: any[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openedCallRows: any[][] = [];

    const mail4PhonesSet = new Set<string>();
    const phoneLastQueueMap = new Map<string, { queue: string; date: string }>();

    let dayAdded = 0;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const c = parseCsvLine(line);
      if (c.length < 13) continue;

      const callId = (c[CI] || "").trim();
      if (!callId) continue;

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

      // Track inbound Mail 4 phones
      if (inOut.toLowerCase() === "inbound") {
        const qLower = queueName.toLowerCase();
        if (qLower.includes("mail 4") && !mail4PhonesSet.has(phone)) {
          mail4PhonesSet.add(phone);
          mail4PhoneRows.push([phone]);
        }

        // Track phone last queue (keep most recent)
        const dateStr = parseDate(startTime);
        if (dateStr) {
          const existing = phoneLastQueueMap.get(phone);
          if (!existing || dateStr > existing.date) {
            phoneLastQueueMap.set(phone, { queue: qLower, date: dateStr });
          }
        }
      }

      // Opened calls: answered, not AI, talk>0, mail 4
      if (
        status === "answered" &&
        destName && !destName.toUpperCase().startsWith("AI F") &&
        talkSec > 0 &&
        queueName.toLowerCase().includes("mail 4")
      ) {
        const dt = parseDate(startTime);
        if (dt) {
          openedCallRows.push([dt, phone]);
        }
      }

      dayAdded++;
    }

    // Batch insert queue_calls (all inbound queue visits for sales dashboard)
    const queueCallRows: string[][] = [];
    const qcSeen = new Set<string>();
    for (const [phone, entry] of phoneLastQueueMap) {
      const key = `${phone}|${entry.queue}|${entry.date}`;
      if (!qcSeen.has(key)) {
        qcSeen.add(key);
        queueCallRows.push([phone, entry.queue, entry.date]);
      }
    }
    if (queueCallRows.length > 0) {
      await batchInsert(
        `INSERT INTO queue_calls (phone,queue,call_date) VALUES __VALUES__ ON CONFLICT DO NOTHING`,
        3, queueCallRows, 200
      );
    }

    // Batch insert mail4_phones
    if (mail4PhoneRows.length > 0) {
      await batchInsert(
        `INSERT INTO mail4_phones (phone) VALUES __VALUES__ ON CONFLICT DO NOTHING`,
        1, mail4PhoneRows, 500
      );
    }

    // Build phone_last_queue rows from map
    for (const [phone, entry] of phoneLastQueueMap) {
      phoneLastQueueRows.push([phone, entry.queue, entry.date]);
    }
    if (phoneLastQueueRows.length > 0) {
      await batchInsert(
        `INSERT INTO phone_last_queue (phone,queue,call_date) VALUES __VALUES__ ON CONFLICT (phone) DO UPDATE SET queue=EXCLUDED.queue, call_date=EXCLUDED.call_date WHERE EXCLUDED.call_date >= phone_last_queue.call_date`,
        3, phoneLastQueueRows, 200
      );
    }

    // Deduplicate opened calls in-memory before insert
    if (openedCallRows.length > 0) {
      const seen = new Set<string>();
      const uniqueOpened = openedCallRows.filter((r) => {
        const key = `${r[0]}|${r[1]}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await batchInsert(
        `INSERT INTO opened_calls (call_date,phone) VALUES __VALUES__ ON CONFLICT DO NOTHING`,
        2, uniqueOpened, 300
      );
    }

    totalAdded += dayAdded;
    console.log(`[seed-refresh/3CX] ${targetDate}: ${dayAdded} calls parsed, ${mail4PhoneRows.length} mail4, ${phoneLastQueueRows.length} queues, ${openedCallRows.length} opened`);
  }

  // Update metadata
  await query(
    `INSERT INTO seed_metadata (source, max_date, updated_at) VALUES ('tcx', $1, NOW()) ON CONFLICT (source) DO UPDATE SET max_date=GREATEST(seed_metadata.max_date, $1), updated_at=NOW()`,
    [dates[dates.length - 1]]
  );

  return { addedCalls: totalAdded };
}

// ─── Moxy: Direct to Postgres ─────────────────────────────────────────────────

async function refreshMoxy(dates: string[]): Promise<{ addedDeals: number }> {
  const moxyKey = process.env.MOXY_API_KEY ?? "a242ccb0-738e-4e4f-a418-facf89297904";

  // Ensure unique constraint exists (idempotent)
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_moxy_deals_unique ON moxy_deals(contract_no) WHERE contract_no IS NOT NULL AND contract_no != ''`);

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dealRows: any[][] = [];
  for (const d of deals) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const da = d as any;
    const cid = String(da.customerId ?? da.customerID ?? da.customerNo ?? "").trim();
    const cno = String(da.contractNo ?? "").trim();
    if (!cid && !cno) continue; // no identifier at all

    const hp = String(da.homePhone ?? "").replace(/\D/g, "");
    const cp = String(da.cellphone ?? da.cellPhone ?? da.mobilePhone ?? "").replace(/\D/g, "");

    dealRows.push([
      cid,
      cno,
      parseDate(String(da.soldDate ?? "")),
      String(da.firstName ?? ""),
      String(da.lastName ?? ""),
      hp.length === 11 && hp.startsWith("1") ? hp.slice(1) : hp,
      cp.length === 11 && cp.startsWith("1") ? cp.slice(1) : cp,
      String(da.closer ?? da.salesRep ?? da.salesperson ?? ""),
      String(da.dealStatus ?? da.status ?? ""),
      String(da.promoCode ?? ""),
      String(da.campaign ?? da.campaignName ?? ""),
      String(da.source ?? ""),
      String(da.cancelReason ?? ""),
      String(da.make ?? ""),
      String(da.model ?? ""),
      String(da.state ?? ""),
      parseFloat(String(da.admin ?? "0")) || 0,
    ]);
  }

  let addedDeals = 0;
  if (dealRows.length > 0) {
    addedDeals = await batchInsert(
      `INSERT INTO moxy_deals (customer_id,contract_no,sold_date,first_name,last_name,home_phone,mobile_phone,salesperson,deal_status,promo_code,campaign,source,cancel_reason,make,model,state,admin)
       VALUES __VALUES__
       ON CONFLICT (contract_no) WHERE contract_no IS NOT NULL AND contract_no != '' DO NOTHING`,
      17, dealRows, 100
    );
  }

  console.log(`[seed-refresh/Moxy] Inserted ${addedDeals} new deals (${dealRows.length} total from API)`);

  // Update metadata
  await query(
    `INSERT INTO seed_metadata (source, max_date, updated_at) VALUES ('moxy', $1, NOW()) ON CONFLICT (source) DO UPDATE SET max_date=GREATEST(seed_metadata.max_date, $1), updated_at=NOW()`,
    [dates[dates.length - 1]]
  );

  return { addedDeals };
}

// ─── Moxy Home: Direct to Postgres ───────────────────────────────────────────

async function refreshMoxyHome(dates: string[]): Promise<{ addedDeals: number }> {
  const moxyHomeKey = process.env.MOXY_HOME_KEY ?? "3f7c2b0a-9e4d-4f6e-b1a8-8c9a6e2d7b54";

  await query(`CREATE TABLE IF NOT EXISTS moxy_home_deals (
    customer_id TEXT, contract_no TEXT, sold_date DATE, first_name TEXT, last_name TEXT,
    home_phone TEXT, mobile_phone TEXT, salesperson TEXT, deal_status TEXT, promo_code TEXT,
    campaign TEXT, source TEXT, cancel_reason TEXT, state TEXT, admin TEXT, division TEXT DEFAULT 'home',
    UNIQUE(customer_id, contract_no)
  )`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_moxy_home_unique ON moxy_home_deals(contract_no) WHERE contract_no IS NOT NULL AND contract_no != ''`);

  const sortedDates = [...dates].sort();
  const fromDate = sortedDates[0];
  const toDate = addDays(sortedDates[sortedDates.length - 1], 1);

  console.log(`[seed-refresh/MoxyHome] Fetching deals ${fromDate} to ${toDate}...`);

  const url = `${MOXY_BASE}/api/GetDealLog?fromDate=${fromDate}&toDate=${toDate}&dealType=Both`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${moxyHomeKey}` },
    cache: "no-store",
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Moxy Home API ${resp.status}: ${errText}`);
  }

  const deals: Record<string, unknown>[] = await resp.json();
  console.log(`[seed-refresh/MoxyHome] API returned ${deals.length} deals`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dealRows: any[][] = [];
  for (const d of deals) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const da = d as any;
    const cid = String(da.vchCampaignId ?? da.customerId ?? da.customerID ?? "").trim();
    const cno = String(da.contractNo ?? "").trim();
    if (!cid && !cno) continue;

    const hp = String(da.homePhone ?? "").replace(/\D/g, "");
    const cp = String(da.cellphone ?? da.cellPhone ?? da.mobilePhone ?? "").replace(/\D/g, "");

    dealRows.push([
      cid,
      cno,
      parseDate(String(da.soldDate ?? "")),
      String(da.firstName ?? ""),
      String(da.lastName ?? ""),
      hp.length === 11 && hp.startsWith("1") ? hp.slice(1) : hp,
      cp.length === 11 && cp.startsWith("1") ? cp.slice(1) : cp,
      String(da.closer ?? da.salesRep ?? da.salesperson ?? ""),
      String(da.dealStatus ?? da.status ?? ""),
      String(da.promoCode ?? ""),
      String(da.campaign ?? da.campaignName ?? da.listCode ?? ""),
      String(da.source ?? ""),
      String(da.cancelReason ?? ""),
      String(da.state ?? ""),
      parseFloat(String(da.admin ?? "0")) || 0,
    ]);
  }

  let addedDeals = 0;
  if (dealRows.length > 0) {
    addedDeals = await batchInsert(
      `INSERT INTO moxy_home_deals (customer_id,contract_no,sold_date,first_name,last_name,home_phone,mobile_phone,salesperson,deal_status,promo_code,campaign,source,cancel_reason,state,admin)
       VALUES __VALUES__
       ON CONFLICT (contract_no) WHERE contract_no IS NOT NULL AND contract_no != '' DO NOTHING`,
      15, dealRows, 100
    );
  }

  console.log(`[seed-refresh/MoxyHome] Inserted ${addedDeals} new deals (${dealRows.length} total from API)`);

  await query(
    `INSERT INTO seed_metadata (source, max_date, updated_at) VALUES ('moxy_home', $1, NOW()) ON CONFLICT (source) DO UPDATE SET max_date=GREATEST(seed_metadata.max_date, $1), updated_at=NOW()`,
    [dates[dates.length - 1]]
  );

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
    // Check Postgres seed_metadata to decide if we need yesterday too.
    let aimMaxDate = "";
    try {
      const metaResult = await query(`SELECT max_date FROM seed_metadata WHERE source = 'aim'`);
      if (metaResult.rows.length > 0 && metaResult.rows[0].max_date) {
        aimMaxDate = metaResult.rows[0].max_date instanceof Date
          ? metaResult.rows[0].max_date.toISOString().slice(0, 10)
          : String(metaResult.rows[0].max_date).slice(0, 10);
      }
    } catch { /* no metadata yet */ }

    // If max date is before yesterday, we need to catch up yesterday + today
    // Otherwise just today (dailyCosts get REPLACED so today is always fresh)
    const datesToFetch = aimMaxDate < yesterday
      ? [yesterday, today]
      : [today];

    console.log(`[seed-refresh] DB max date: ${aimMaxDate || "(empty)"}, fetching: ${datesToFetch.join(", ")}`);

    // Run all four source refreshes
    const results = await Promise.allSettled([
      refreshAim(datesToFetch),
      refresh3cx(datesToFetch),
      refreshMoxy(datesToFetch),
      refreshMoxyHome(datesToFetch),
    ]);

    const aimResult = results[0].status === "fulfilled" ? results[0].value : { error: String((results[0] as PromiseRejectedResult).reason) };
    const tcxResult = results[1].status === "fulfilled" ? results[1].value : { error: String((results[1] as PromiseRejectedResult).reason) };
    const moxyResult = results[2].status === "fulfilled" ? results[2].value : { error: String((results[2] as PromiseRejectedResult).reason) };
    const moxyHomeResult = results[3].status === "fulfilled" ? results[3].value : { error: String((results[3] as PromiseRejectedResult).reason) };

    for (const r of results) {
      if (r.status === "rejected") console.error("[seed-refresh] Error:", r.reason);
    }

    // Update overall refresh metadata
    await query(
      `INSERT INTO seed_metadata (source, max_date, updated_at) VALUES ('refresh', $1, NOW()) ON CONFLICT (source) DO UPDATE SET max_date=$1, updated_at=NOW()`,
      [datesToFetch[datesToFetch.length - 1]]
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[seed-refresh] Complete in ${elapsed}s — AIM: ${JSON.stringify(aimResult)}, 3CX: ${JSON.stringify(tcxResult)}, Moxy: ${JSON.stringify(moxyResult)}, MoxyHome: ${JSON.stringify(moxyHomeResult)}`);

    return NextResponse.json({
      ok: true,
      ctNow,
      datesToFetch,
      elapsed: `${elapsed}s`,
      aim: aimResult,
      tcx: tcxResult,
      moxy: moxyResult,
      moxyHome: moxyHomeResult,
    });
  } catch (err) {
    console.error("[seed-refresh] Fatal error:", err);
    return NextResponse.json({ ok: false, error: String(err), ctNow }, { status: 500 });
  }
}
