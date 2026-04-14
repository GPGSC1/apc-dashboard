import { NextResponse } from "next/server";
import https from "https";
import { query } from "../../../lib/db/connection";

// ─── Constants ────────────────────────────────────────────────────────────────
const AIM_REST = "https://dash.aimnow.ai/api";
const MOXY_BASE = "https://MoxyAPI.moxyws.com";
const CT_TZ = "America/Chicago";

const TRACKED_QUEUES = [
  "mail 1", "mail 2", "mail 3", "mail 4", "mail 5", "mail 6",
  "home 1", "home 2", "home 3", "home 4", "home 5",
  "spanish", "to",
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
  // Mon-Sat (1-6), 7:05am - 7:05pm CT
  if (p.dow === 0) return false; // Sunday
  if (p.dow > 6) return false;
  const timeMinutes = p.hour * 60 + p.minute;
  if (timeMinutes < 7 * 60 + 5) return false;   // before 7:05am
  if (timeMinutes >= 19 * 60 + 5) return false;  // after 7:05pm
  return true;
}

function isCatchupHour(): boolean {
  const p = centralParts();
  // 4:00 AM CT, Mon-Sat
  if (p.dow === 0) return false; // Sunday
  return p.hour === 4 && p.minute < 10; // 4:00-4:09 AM window
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

// Parse full timestamp from 3CX: "4/6/2026 2:35:12 PM" -> "2026-04-06 14:35:12"
function parseTimestamp(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/"/g, "").trim();
  if (!s) return null;
  // Try "M/D/YYYY h:mm:ss AM/PM" format
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
  if (m) {
    let hour = parseInt(m[4]);
    const ampm = (m[7] || "").toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")} ${String(hour).padStart(2, "0")}:${m[5]}:${m[6]}`;
  }
  // Try ISO format "2026-04-06T14:35:12"
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (iso) return `${iso[1]} ${iso[2]}`;
  // Fallback: just date at midnight
  const d = parseDate(s);
  if (d) return `${d} 00:00:00`;
  return null;
}

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

async function refresh3cx(dates: string[], cleanReimport = false): Promise<{ addedCalls: number }> {
  // Ensure dest_name column exists (one-time migration)
  await query(`ALTER TABLE queue_calls ADD COLUMN IF NOT EXISTS dest_name TEXT DEFAULT ''`).catch(() => {});
  // Create to_transfers table for internal transfer tracking (T.O. + Spanish queues)
  await query(`CREATE TABLE IF NOT EXISTS to_transfers (
    call_id TEXT PRIMARY KEY,
    call_date DATE NOT NULL,
    dest_name TEXT NOT NULL,
    originating_ext TEXT DEFAULT '',
    originating_name TEXT DEFAULT '',
    status TEXT DEFAULT '',
    talk_time_sec INTEGER DEFAULT 0,
    queue TEXT DEFAULT ''
  )`).catch(() => {});
  await query(`ALTER TABLE to_transfers ADD COLUMN IF NOT EXISTS queue TEXT DEFAULT ''`).catch(() => {});
  // Create cs_outbound_calls table for CS collections "Last Called" tracking
  // Migrate: drop old table with (phone, call_date) PK and recreate with call_time TIMESTAMP
  await query(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'cs_outbound_calls' AND column_name = 'call_date'
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cs_outbound_calls' AND column_name = 'call_time')
    ) THEN
      DROP TABLE cs_outbound_calls;
    END IF;
  END $$`).catch(() => {});
  await query(`CREATE TABLE IF NOT EXISTS cs_outbound_calls (
    phone VARCHAR(10) NOT NULL,
    call_time TIMESTAMP NOT NULL,
    agent_name VARCHAR(100) DEFAULT '',
    PRIMARY KEY (phone, call_time)
  )`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_cs_outbound_phone ON cs_outbound_calls(phone)`).catch(() => {});

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

  // Clean reimport: delete old queue_calls for these dates so stale Last-Queue records are removed
  if (cleanReimport) {
    for (const d of dates) {
      await query(`DELETE FROM queue_calls WHERE call_date = $1`, [d]);
      console.log(`[seed-refresh/3CX] Cleaned queue_calls for ${d}`);
    }
  }

  let totalOutboundInserted = 0;
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
    const queueCallDetailRows: string[][] = [];
    const toTransferRows: (string | number)[][] = [];
    const outboundCallRows: string[][] = [];

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

      const startTime = (c[STI] || "").trim();
      const inOut = (c[IOI] || "").trim();

      // Capture ALL outbound calls for CS "Last Called" (before queue filter)
      // For outbound: Destination (col 10) has the dialed phone, Originated By (col 8) has the agent extension
      if (inOut.toLowerCase() === "outbound") {
        const obPhone = normalizePhone(c[10] || "");
        if (obPhone && obPhone.length === 10) {
          const ts = parseTimestamp(startTime);
          if (ts) {
            const agentName = (c[5] || "").trim();
            outboundCallRows.push([obPhone, ts, agentName]);
          }
        }
      }

      const queueName = (c[QI] || "").trim();
      const lastQueueName = (c[QI + 2] || "").trim();
      const lastQueueFull = lastQueueName || queueName;
      const isTrackedQueue = TRACKED_QUEUES.some((q) => lastQueueFull.toLowerCase().includes(q));
      if (!isTrackedQueue) continue;
      const destName = (c[DNI] || "").trim();
      const status = (c[SSI] || "").trim().toLowerCase();
      const talkSec = parseFloat(c[TTI] || "0") || 0;
      const isInbound = inOut.toLowerCase() === "inbound";
      const qLower = lastQueueFull.toLowerCase();
      const isToQueue = qLower.includes("to");
      const isSpanishQueue = qLower.includes("spanish");

      // Capture internal transfers (T.O. + Spanish) into to_transfers table
      // These rows often have extensions in the phone field, not 10-digit numbers
      if ((isToQueue || isSpanishQueue) && destName) {
        const dateStr = parseDate(startTime);
        if (dateStr && callId) {
          const origExt = (c[4] || "").trim();
          const origName = (c[5] || "").trim();
          const transferQueue = isToQueue ? "to" : "spanish";
          toTransferRows.push([callId, dateStr, destName, origExt, origName, status, Math.round(talkSec), transferQueue]);
        }
      }

      const phone = normalizePhone(c[PHI] || "");
      if (!phone || phone.length !== 10) continue;

      // Track inbound Mail 4 phones
      if (isInbound) {
        if (qLower.includes("mail 4") && !mail4PhonesSet.has(phone)) {
          mail4PhonesSet.add(phone);
          mail4PhoneRows.push([phone]);
        }
      }

      // Store inbound call rows into queue_calls
      if (isInbound) {
        const dateStr = parseDate(startTime);
        if (dateStr) {
          const existing = phoneLastQueueMap.get(phone);
          if (!existing || dateStr > existing.date) {
            phoneLastQueueMap.set(phone, { queue: qLower, date: dateStr });
          }

          const firstExt = (c[4] || "").trim();
          const firstExtName = (c[5] || "").trim();
          const destinationRaw = (c[10] || "").trim();
          const destination = destinationRaw.replace(/\D/g, "");
          const cleanQueue = lastQueueFull.replace(/^\d+\s+/, "");
          queueCallDetailRows.push([phone, cleanQueue, dateStr, firstExt, firstExtName, inOut, status, destination, destName]);
        }
      }

      // Opened calls: answered by human closer (not AI), in mail 4
      if (
        status === "answered" &&
        destName && !destName.toUpperCase().startsWith("AI F") &&
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
    if (queueCallDetailRows.length > 0) {
      // Deduplicate by phone|queue|call_date, preferring rows with:
      // 1. non-empty dest_name (index 8), then 2. non-empty agent_name (index 4/first_ext)
      // This prevents losing agent attribution when the first CSV row has empty dest_name
      const qcBest = new Map<string, string[]>();
      for (const r of queueCallDetailRows) {
        const key = `${r[0]}|${r[1]}|${r[2]}`;
        const existing = qcBest.get(key);
        if (!existing) {
          qcBest.set(key, r);
        } else {
          // Prefer row with dest_name populated
          const existHasDestName = (existing[8] || "").trim() !== "";
          const newHasDestName = (r[8] || "").trim() !== "";
          if (!existHasDestName && newHasDestName) {
            qcBest.set(key, r);
          } else if (!existHasDestName && !newHasDestName) {
            // Neither has dest_name — prefer row with first_ext (answered)
            const existHasExt = (existing[3] || "").trim() !== "";
            const newHasExt = (r[3] || "").trim() !== "";
            if (!existHasExt && newHasExt) {
              qcBest.set(key, r);
            }
          }
        }
      }
      const uniqueQueueCallRows = [...qcBest.values()];
      await batchInsert(
        `INSERT INTO queue_calls (phone,queue,call_date,first_ext,agent_name,direction,status,destination,dest_name) VALUES __VALUES__ ON CONFLICT (phone,queue,call_date) DO UPDATE SET first_ext=CASE WHEN EXCLUDED.first_ext!='' THEN EXCLUDED.first_ext ELSE queue_calls.first_ext END, agent_name=CASE WHEN EXCLUDED.first_ext!='' THEN EXCLUDED.agent_name ELSE queue_calls.agent_name END, status=CASE WHEN EXCLUDED.first_ext!='' THEN EXCLUDED.status ELSE queue_calls.status END, destination=CASE WHEN EXCLUDED.destination!='' THEN EXCLUDED.destination ELSE queue_calls.destination END, dest_name=CASE WHEN EXCLUDED.dest_name!='' THEN EXCLUDED.dest_name ELSE queue_calls.dest_name END`,
        9, uniqueQueueCallRows, 200
      );
    }

    // Batch insert to_transfers (T.O. transfer calls)
    if (toTransferRows.length > 0) {
      if (cleanReimport) {
        for (const d of dates) {
          await query(`DELETE FROM to_transfers WHERE call_date = $1`, [d]);
        }
      }
      await batchInsert(
        `INSERT INTO to_transfers (call_id,call_date,dest_name,originating_ext,originating_name,status,talk_time_sec,queue) VALUES __VALUES__ ON CONFLICT (call_id) DO UPDATE SET dest_name=EXCLUDED.dest_name, status=EXCLUDED.status, talk_time_sec=EXCLUDED.talk_time_sec, queue=EXCLUDED.queue`,
        8, toTransferRows, 200
      );
      console.log(`[seed-refresh/3CX] Inserted ${toTransferRows.length} T.O. transfer rows`);
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

    // Batch insert outbound calls for CS "Last Called"
    if (outboundCallRows.length > 0) {
      const obSeen = new Set<string>();
      const uniqueOB = outboundCallRows.filter((r) => {
        const key = `${r[0]}|${r[1]}`;
        if (obSeen.has(key)) return false;
        obSeen.add(key);
        return true;
      });
      await batchInsert(
        `INSERT INTO cs_outbound_calls (phone,call_time,agent_name) VALUES __VALUES__ ON CONFLICT (phone,call_time) DO NOTHING`,
        3, uniqueOB, 500
      );
    }

    totalAdded += dayAdded;
    totalOutboundInserted += outboundCallRows.length;
    console.log(`[seed-refresh/3CX] ${targetDate}: ${dayAdded} inbound, ${outboundCallRows.length} outbound`);
  }

  // Update metadata
  await query(
    `INSERT INTO seed_metadata (source, max_date, updated_at) VALUES ('tcx', $1, NOW()) ON CONFLICT (source) DO UPDATE SET max_date=GREATEST(seed_metadata.max_date, $1), updated_at=NOW()`,
    [dates[dates.length - 1]]
  );

  console.log(`[seed-refresh/3CX] Done: ${totalAdded} inbound, ${totalOutboundInserted} outbound`);
  return { addedCalls: totalAdded };
}

// ─── Moxy: Direct to Postgres ─────────────────────────────────────────────────

async function refreshMoxy(dates: string[]): Promise<{ addedDeals: number; backedOut?: number }> {
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
    const cid = String(da.vchCampaignId ?? da.customerId ?? da.customerID ?? da.customerNo ?? "").trim();
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
      0,  // admin column (legacy REAL type — kept as 0, admin name is not useful)
      String(da.owner ?? da.closer ?? da.salesRep ?? ""),
      // Financial fields for Owner Dash funding projections
      parseFloat(String(da.custCost ?? "0")) || 0,
      parseFloat(String(da.dealerCost ?? "0")) || 0,
      parseFloat(String(da.downPmt ?? "0")) || 0,
      parseInt(String(da.term ?? "0")) || 0,
      String(da.finSentName ?? ""),
    ]);
  }

  // One-time migration: add financial columns if they don't exist
  await query(`
    DO $$ BEGIN
      ALTER TABLE moxy_deals ADD COLUMN IF NOT EXISTS cust_cost NUMERIC DEFAULT 0;
      ALTER TABLE moxy_deals ADD COLUMN IF NOT EXISTS dealer_cost NUMERIC DEFAULT 0;
      ALTER TABLE moxy_deals ADD COLUMN IF NOT EXISTS down_payment NUMERIC DEFAULT 0;
      ALTER TABLE moxy_deals ADD COLUMN IF NOT EXISTS finance_term INTEGER DEFAULT 0;
      ALTER TABLE moxy_deals ADD COLUMN IF NOT EXISTS finance_company TEXT DEFAULT '';
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `);

  let addedDeals = 0;
  // Split into deals with contract_no and deals without
  const withContract = dealRows.filter(r => r[1] && String(r[1]).trim() !== "");
  const withoutContract = dealRows.filter(r => !r[1] || String(r[1]).trim() === "");

  if (withContract.length > 0) {
    addedDeals += await batchInsert(
      `INSERT INTO moxy_deals (customer_id,contract_no,sold_date,first_name,last_name,home_phone,mobile_phone,salesperson,deal_status,promo_code,campaign,source,cancel_reason,make,model,state,admin,owner,cust_cost,dealer_cost,down_payment,finance_term,finance_company)
       VALUES __VALUES__
       ON CONFLICT (contract_no) WHERE contract_no IS NOT NULL AND contract_no != '' DO UPDATE SET deal_status = EXCLUDED.deal_status, salesperson = EXCLUDED.salesperson, cancel_reason = EXCLUDED.cancel_reason, customer_id = EXCLUDED.customer_id, owner = EXCLUDED.owner, cust_cost = EXCLUDED.cust_cost, dealer_cost = EXCLUDED.dealer_cost, down_payment = EXCLUDED.down_payment, finance_term = EXCLUDED.finance_term, finance_company = EXCLUDED.finance_company`,
      23, withContract, 100
    );
  }
  if (withoutContract.length > 0) {
    addedDeals += await batchInsert(
      `INSERT INTO moxy_deals (customer_id,contract_no,sold_date,first_name,last_name,home_phone,mobile_phone,salesperson,deal_status,promo_code,campaign,source,cancel_reason,make,model,state,admin,owner,cust_cost,dealer_cost,down_payment,finance_term,finance_company)
       VALUES __VALUES__
       ON CONFLICT (customer_id) WHERE (contract_no IS NULL OR contract_no = '') AND customer_id IS NOT NULL AND customer_id != '' DO UPDATE SET deal_status = EXCLUDED.deal_status, salesperson = EXCLUDED.salesperson, cancel_reason = EXCLUDED.cancel_reason, owner = EXCLUDED.owner, cust_cost = EXCLUDED.cust_cost, dealer_cost = EXCLUDED.dealer_cost, down_payment = EXCLUDED.down_payment, finance_term = EXCLUDED.finance_term, finance_company = EXCLUDED.finance_company`,
      23, withoutContract, 100
    );
  }

  console.log(`[seed-refresh/Moxy] Inserted ${addedDeals} new deals (${dealRows.length} total from API)`);

  // ── Backout detection: Moxy REMOVES backed-out deals from the API response.
  // Any deal in our DB for the fetched dates that is NOT in the API response has been backed out.
  const apiContractNos = new Set(dealRows.map(r => String(r[1]).trim()).filter(Boolean));
  const apiCustomerIds = new Set(dealRows.map(r => String(r[0]).trim()).filter(Boolean));

  const sortedDates2 = [...dates].sort();
  const dbDeals = await query(
    `SELECT contract_no, customer_id FROM moxy_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status NOT IN ('Back Out', 'VOID')`,
    [sortedDates2[0], sortedDates2[sortedDates2.length - 1]]
  );

  let backedOut = 0;
  for (const row of dbDeals.rows) {
    const cno = (row.contract_no ?? "").trim();
    const cid = (row.customer_id ?? "").trim();
    // If this deal is NOT in the API response, it was backed out
    const inApi = (cno && apiContractNos.has(cno)) || (cid && apiCustomerIds.has(cid));
    if (!inApi) {
      if (cno) {
        await query(`UPDATE moxy_deals SET deal_status = 'Back Out' WHERE contract_no = $1`, [cno]);
      } else if (cid) {
        await query(`UPDATE moxy_deals SET deal_status = 'Back Out' WHERE customer_id = $1 AND (contract_no IS NULL OR contract_no = '')`, [cid]);
      }
      backedOut++;
    }
  }
  if (backedOut > 0) console.log(`[seed-refresh/Moxy] Detected ${backedOut} backouts (removed from API)`);

  // Update metadata
  await query(
    `INSERT INTO seed_metadata (source, max_date, updated_at) VALUES ('moxy', $1, NOW()) ON CONFLICT (source) DO UPDATE SET max_date=GREATEST(seed_metadata.max_date, $1), updated_at=NOW()`,
    [dates[dates.length - 1]]
  );

  return { addedDeals, backedOut };
}

// ─── Moxy Home: Direct to Postgres ───────────────────────────────────────────

async function refreshMoxyHome(dates: string[]): Promise<{ addedDeals: number; backedOut?: number }> {
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
      0,  // admin column (legacy TEXT type — kept as 0, admin name not useful)
      String(da.owner ?? da.closer ?? da.salesRep ?? ""),
      // Financial fields for Owner Dash funding projections
      parseFloat(String(da.custCost ?? "0")) || 0,
      parseFloat(String(da.dealerCost ?? "0")) || 0,
      parseFloat(String(da.downPmt ?? "0")) || 0,
      parseInt(String(da.term ?? "0")) || 0,
      String(da.finSentName ?? ""),
    ]);
  }

  // One-time migration: add financial columns if they don't exist
  await query(`
    DO $$ BEGIN
      ALTER TABLE moxy_home_deals ADD COLUMN IF NOT EXISTS cust_cost NUMERIC DEFAULT 0;
      ALTER TABLE moxy_home_deals ADD COLUMN IF NOT EXISTS dealer_cost NUMERIC DEFAULT 0;
      ALTER TABLE moxy_home_deals ADD COLUMN IF NOT EXISTS down_payment NUMERIC DEFAULT 0;
      ALTER TABLE moxy_home_deals ADD COLUMN IF NOT EXISTS finance_term INTEGER DEFAULT 0;
      ALTER TABLE moxy_home_deals ADD COLUMN IF NOT EXISTS finance_company TEXT DEFAULT '';
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `);

  let addedDeals = 0;
  if (dealRows.length > 0) {
    addedDeals = await batchInsert(
      `INSERT INTO moxy_home_deals (customer_id,contract_no,sold_date,first_name,last_name,home_phone,mobile_phone,salesperson,deal_status,promo_code,campaign,source,cancel_reason,state,admin,owner,cust_cost,dealer_cost,down_payment,finance_term,finance_company)
       VALUES __VALUES__
       ON CONFLICT (customer_id, contract_no) DO UPDATE SET deal_status = EXCLUDED.deal_status, salesperson = EXCLUDED.salesperson, cancel_reason = EXCLUDED.cancel_reason, owner = EXCLUDED.owner, cust_cost = EXCLUDED.cust_cost, dealer_cost = EXCLUDED.dealer_cost, down_payment = EXCLUDED.down_payment, finance_term = EXCLUDED.finance_term, finance_company = EXCLUDED.finance_company`,
      21, dealRows, 100
    );
  }

  console.log(`[seed-refresh/MoxyHome] Inserted ${addedDeals} new deals (${dealRows.length} total from API)`);

  // ── Backout detection for Home deals
  const homeApiContractNos = new Set(dealRows.map(r => String(r[1]).trim()).filter(Boolean));
  const homeApiCustomerIds = new Set(dealRows.map(r => String(r[0]).trim()).filter(Boolean));

  const sortedHomeD = [...dates].sort();
  const dbHomeDeals = await query(
    `SELECT contract_no, customer_id FROM moxy_home_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status NOT IN ('Back Out', 'VOID')`,
    [sortedHomeD[0], sortedHomeD[sortedHomeD.length - 1]]
  );

  let homeBackedOut = 0;
  for (const row of dbHomeDeals.rows) {
    const cno = (row.contract_no ?? "").trim();
    const cid = (row.customer_id ?? "").trim();
    const inApi = (cno && homeApiContractNos.has(cno)) || (cid && homeApiCustomerIds.has(cid));
    if (!inApi) {
      if (cno) {
        await query(`UPDATE moxy_home_deals SET deal_status = 'Back Out' WHERE contract_no = $1`, [cno]);
      } else if (cid) {
        await query(`UPDATE moxy_home_deals SET deal_status = 'Back Out' WHERE customer_id = $1 AND (contract_no IS NULL OR contract_no = '')`, [cid]);
      }
      homeBackedOut++;
    }
  }
  if (homeBackedOut > 0) console.log(`[seed-refresh/MoxyHome] Detected ${homeBackedOut} backouts (removed from API)`);

  await query(
    `INSERT INTO seed_metadata (source, max_date, updated_at) VALUES ('moxy_home', $1, NOW()) ON CONFLICT (source) DO UPDATE SET max_date=GREATEST(seed_metadata.max_date, $1), updated_at=NOW()`,
    [dates[dates.length - 1]]
  );

  return { addedDeals, backedOut: homeBackedOut };
}

// ─── Main Route Handler ───────────────────────────────────────────────────────

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const startTime = Date.now();
  const p = centralParts();
  const ctNow = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} CT (dow=${p.dow})`;

  // Allow manual date override via ?dates=2026-03-24,2026-03-25
  const url = new URL(req.url);
  const forceDates = url.searchParams.get("dates");
  const mode = url.searchParams.get("mode"); // "catchup" = 4am full previous day
  const tcxClean = url.searchParams.get("tcx_clean") === "true"; // delete+reimport queue_calls
  const sourceFilter = url.searchParams.get("source"); // "tcx", "aim", "moxy", "moxy_home" — run only one source

  console.log(`[seed-refresh] Triggered at ${ctNow}${forceDates ? ` (forced: ${forceDates})` : ""}${mode ? ` (mode: ${mode})` : ""}`);

  // Gate: allow if manual, catchup (4am), or within business hours (7:05am-7:05pm CT)
  if (!forceDates && mode !== "catchup" && !isCatchupHour() && !isWithinBusinessHours()) {
    console.log(`[seed-refresh] Outside business hours, skipping`);
    return NextResponse.json({ ok: true, skipped: true, reason: "outside business hours", ctNow });
  }

  try {
    const today = todayCentral();
    const yesterday = yesterdayCentral();

    // Determine which dates to fetch based on mode:
    // - catchup (4am): yesterday ONLY (full previous day sync)
    // - first refresh of day (7:05-7:14am): month start through today
    // - regular (every 5 min during business hours): today ONLY
    // - manual: whatever dates are specified
    const isFirstRefreshOfDay = p.hour === 7 && p.minute < 15;
    const monthStart = `${p.year}-${String(p.month).padStart(2, "0")}-01`;

    let datesToFetch: string[];
    if (forceDates) {
      datesToFetch = forceDates.split(",").map((d: string) => d.trim());
    } else if (mode === "catchup" || isCatchupHour()) {
      // 4am catchup: full previous day only
      datesToFetch = [yesterday];
    } else if (isFirstRefreshOfDay) {
      // First business hours refresh: month start through today (catches retroactive entries)
      datesToFetch = [monthStart, today];
    } else {
      // Regular 5-min refresh: today only
      datesToFetch = [today];
    }

    console.log(`[seed-refresh] Fetching: ${datesToFetch.join(", ")}`);

    // Run source refreshes (all four, or filtered to one)
    const runAim = !sourceFilter || sourceFilter === "aim";
    const runTcx = !sourceFilter || sourceFilter === "tcx";
    const runMoxy = !sourceFilter || sourceFilter === "moxy";
    const runMoxyHome = !sourceFilter || sourceFilter === "moxy_home";

    const results = await Promise.allSettled([
      runAim ? refreshAim(datesToFetch) : Promise.resolve({ skipped: true }),
      runTcx ? refresh3cx(datesToFetch, tcxClean) : Promise.resolve({ skipped: true }),
      runMoxy ? refreshMoxy(datesToFetch) : Promise.resolve({ skipped: true }),
      runMoxyHome ? refreshMoxyHome(datesToFetch) : Promise.resolve({ skipped: true }),
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

    // Sync dispositions from Google Sheets (CS collections)
    let sheetSyncResult: Record<string, unknown> = { skipped: true };
    try {
      if (process.env.GOOGLE_SERVICE_ACCOUNT) {
        const { syncDisposFromSheet } = await import("../../../lib/cs/sheets-sync");
        sheetSyncResult = await syncDisposFromSheet();
        console.log(`[seed-refresh] Sheet sync: ${JSON.stringify(sheetSyncResult)}`);
      }
    } catch (e) {
      sheetSyncResult = { error: String(e) };
      console.error("[seed-refresh] Sheet sync error:", e);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[seed-refresh] Complete in ${elapsed}s`);

    return NextResponse.json({
      ok: true,
      ctNow,
      datesToFetch,
      elapsed: `${elapsed}s`,
      aim: aimResult,
      tcx: tcxResult,
      moxy: moxyResult,
      moxyHome: moxyHomeResult,
      sheetSync: sheetSyncResult,
    });
  } catch (err) {
    console.error("[seed-refresh] Fatal error:", err);
    return NextResponse.json({ ok: false, error: String(err), ctNow }, { status: 500 });
  }
}
