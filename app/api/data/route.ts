import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

const DATA_DIR = path.join(process.cwd(), "data");

// ── AGENT SHORT NAMES ────────────────────────────────────────
const AGENT_SHORT: Record<string, string> = {
  "Transfer Outbound Agent with Moxy": "Moxy OG",
  "Transfer Activation Outbound Agent with Moxy": "Activation",
  "Female Transfer Outbound Agent with Moxy version 3": "Female v3",
  "Transfer Outbound Agent with Moxy version 2": "Moxy v2",
  "Male Transfer Outbound Agent with Moxy version 3": "Male v3",
  "Overflow Agent with Spanish Transfer": "Overflow ES",
  "Outbound Jr. Closer to TO Agent with Moxy Tools": "Jr Closer",
};

// JR manual pre-campaign sales (2/25 before campaign started)
const JR_SALES = [
  { list: "JL021926LP", phone: "7139069790", name: "Mohammed Omar" },
  { list: "JL021926LP", phone: "4235441118", name: "Ronald Dupree" },
  { list: "BL021926BO", phone: "3475936779", name: "Muhammad Salman" },
  { list: "DG021726SC", phone: "5043140900", name: "Carnelius Johnson" },
];

const BL_HARDCODE_PHONE = "5125854726";
const BL_HARDCODE_LIST = "BL021926BO";

// Default list costs — keyed by 10-char code (2 alpha + 6 digits + 2 alpha)
const DEFAULT_COSTS: Record<string, number> = {
  RT: 0,
  JL021926LP: 8000,
  BL021926BO: 8000,
  JH022326MN: 8000,
  JL021926CR: 8000,
  DG021726SC: 5000,
  JL022526RS: 6000,
};

// ── UTILITIES ────────────────────────────────────────────────
const cleanPhone = (p: unknown): string => {
  let s = String(p || "");
  s = s.replace(/^=/, "").replace(/^"/, "").replace(/"$/, "");
  return s.replace(/\D/g, "").slice(-10);
};

const shortAgent = (name: string): string => AGENT_SHORT[name] || name;

const toISO = (s: string): string | null => {
  if (!s) return null;
  const d = new Date(s.replace(/"/g, "").trim());
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const excelToISO = (s: number): string | null => {
  if (isNaN(s)) return null;
  return new Date(Math.round((s - 25569) * 86400000)).toISOString().slice(0, 10);
};

// ── LIST KEY DETECTION ───────────────────────────────────────
// Standard key = 10 chars: 2 alpha + 6 digits + 2 alpha (e.g. "JL021926LP")
// RT is the only exception (free responder list)
const detectListKey = (text: string): string | null => {
  if (!text) return null;
  if (text.toLowerCase().includes("responder")) return "RT";
  // Match full 10-char pattern first: 2 alpha + 6 digits + 2 alpha
  const match10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (match10) return (match10[1] + match10[2] + match10[3]).toUpperCase();
  // Fall back to 8-char if no type suffix found
  const match8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (match8) return (match8[1] + match8[2]).toUpperCase();
  return null;
};

// ── CSV PARSER ───────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
  const r: string[] = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { r.push(cur); cur = ""; }
    else cur += ch;
  }
  r.push(cur);
  return r;
}

// ── PARSE OPENED REPORT (3CX Call Summary) ───────────────────
// Ground truth: which leads actually reached a rep
function parseOpened(text: string) {
  const lines = text.split(/\r?\n/);
  const rows: { phone: string; destName: string; status: string; date: string | null }[] = [];
  let dataStart = 4;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].toLowerCase().includes("callid")) { dataStart = i + 1; break; }
  }
  const headers = parseCsvLine(lines[dataStart - 1] || "").map(h => h.trim().toLowerCase());
  const stIdx = headers.findIndex(h => h === "start time") >= 0 ? headers.findIndex(h => h === "start time") : 1;
  const phoneIdx = headers.findIndex(h => h === "originated by") >= 0 ? headers.findIndex(h => h === "originated by") : 8;
  const dnIdx = headers.findIndex(h => h === "destination name") >= 0 ? headers.findIndex(h => h === "destination name") : 11;
  const sIdx = headers.findIndex(h => h === "status") >= 0 ? headers.findIndex(h => h === "status") : 12;
  for (let i = dataStart; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);
    if (c.length < 5) continue;
    const phone = cleanPhone(c[phoneIdx] || "");
    const destName = (c[dnIdx] || "").trim();
    const status = (c[sIdx] || "").trim().toLowerCase();
    const date = toISO(c[stIdx] || "");
    if (phone && phone.length === 10) rows.push({ phone, destName, status, date });
  }
  return rows;
}

// ── PARSE AIM CALLS REPORT ───────────────────────────────────
// Single report replacing both transfer.csv and minutes report
// Uses Phone Number col (15) for lead phone — most reliable source
// Filters Outcomes = "transferred" for transfer counting
// All rows used for minutes/cost totals
interface CallRow {
  callId: string;
  phone: string;
  agent: string;
  duration: number;       // total call minutes
  transferDuration: number; // time actually spent with rep
  cost: number;
  date: string | null;
  campaign: string;
  list: string | null;
  isTransfer: boolean;
}

function parseCallsReport(text: string): CallRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());

  const gi = (name: string) => headers.findIndex(h => h === name);
  const aI = gi("agent name");
  const durI = gi("duration (seconds)");
  const tDurI = gi("transfer call duration");
  const cI = gi("cost");
  const sI = gi("started at");
  const campI = gi("campaign name");
  const outI = gi("outcomes");
  const callIdI = gi("call id");
  const phoneI = gi("phone number"); // col 15 — pre-matched lead phone

  const rows: CallRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);

    const callId = (c[callIdI >= 0 ? callIdI : 12] || "").trim();
    if (!callId) continue;

    // Use Phone Number col (15) as primary — most reliable
    // Fall back to To/From direction logic if empty
    let phone = cleanPhone(c[phoneI >= 0 ? phoneI : 15] || "");
    if (!phone || phone.length !== 10) {
      const dir = (c[4] || "").trim().toLowerCase();
      const fromP = cleanPhone(c[2] || "");
      const toP = cleanPhone(c[3] || "");
      phone = dir === "outbound" ? toP : fromP;
    }
    if (!phone || phone.length !== 10) continue;

    const agFull = (c[aI >= 0 ? aI : 1] || "").trim();
    const agent = shortAgent(agFull);
    const dur = (parseFloat(c[durI >= 0 ? durI : 6]) || 0) / 60;
    const tDur = (parseFloat(c[tDurI >= 0 ? tDurI : 7]) || 0) / 60;
    const cost = parseFloat(c[cI >= 0 ? cI : 8]) || 0;
    const campaign = (c[campI >= 0 ? campI : 13] || "").trim();
    const date = toISO((c[sI >= 0 ? sI : 11] || "").trim());
    const outcome = (c[outI >= 0 ? outI : 10] || "").trim().toLowerCase();
    const isTransfer = outcome === "transferred";
    const list = detectListKey(campaign);

    rows.push({ callId, phone, agent, duration: dur, transferDuration: tDur, cost, date, campaign, list, isTransfer });
  }
  return rows;
}

// ── PARSE SALES REPORT ───────────────────────────────────────
function parseSales(buf: Buffer) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][];
  const res: {
    soldDate: string | null; lastName: string; firstName: string;
    promoCode: string; homePhone: string; mobilePhone: string;
    dealStatus: string; salesperson: string;
  }[] = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 11) continue;
    const soldDate = typeof r[0] === "number" ? excelToISO(r[0]) : toISO(String(r[0]));
    if (soldDate?.includes("-09-27")) continue;
    if (String(r[30] || "").trim() !== "Sold") continue;
    res.push({
      soldDate,
      lastName: String(r[1] || "").trim(),
      firstName: String(r[2] || "").trim(),
      promoCode: String(r[7] || "").trim(),
      homePhone: cleanPhone(r[9]),
      mobilePhone: cleanPhone(r[10]),
      dealStatus: String(r[30] || "").trim(),
      salesperson: String(r[43] || "").trim(),
    });
  }
  return res;
}

// ── PARSE LIST FILE ───────────────────────────────────────────
function parseListFile(text: string): Set<string> {
  const phones = new Set<string>();
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return phones;
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const phoneColIndices = headers
    .map((h, i) => ({ lower: h.toLowerCase(), i }))
    .filter(({ lower }) => lower.includes("phone"))
    .map(({ i }) => i);
  if (phoneColIndices.length === 0) return phones;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);
    for (const idx of phoneColIndices) {
      const p = cleanPhone(c[idx] || "");
      if (p.length === 10) phones.add(p);
    }
  }
  return phones;
}

// ── LOAD LIST COSTS ───────────────────────────────────────────
function loadListCosts(): Record<string, number> {
  const costFile = path.join(DATA_DIR, "list_costs.json");
  if (fs.existsSync(costFile)) {
    try { return JSON.parse(fs.readFileSync(costFile, "utf8")); } catch { /* fall */ }
  }
  return DEFAULT_COSTS;
}

// ── ATTRIBUTION ENGINE ───────────────────────────────────────
function computeMetrics(
  opened: ReturnType<typeof parseOpened>,
  calls: CallRow[],
  sales: ReturnType<typeof parseSales>,
  listPhones: Record<string, Set<string>>,
  listCosts: Record<string, number>,
  dateFilter: { start: string | null; end: string | null }
) {
  const { start, end } = dateFilter;
  const inRange = (date: string | null) => {
    if (!date) return true;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  };

  const fOpened = opened.filter(r => inRange(r.date));
  const fCalls = calls.filter(r => inRange(r.date));
  const fSales = sales.filter(r => inRange(r.soldDate));

  // Ground truth: phones that actually reached a rep (from 3CX)
  const openedSet = new Set<string>();
  for (const r of fOpened)
    if (r.status === "answered" && r.destName) openedSet.add(r.phone);

  // Build phone → list mapping
  // Priority: 1) hardcoded, 2) list files, 3) campaign name from calls
  const p2list = new Map<string, string>();
  const p2agent = new Map<string, string>();
  const p2agList = new Map<string, { agent: string; list: string }>();

  p2list.set(BL_HARDCODE_PHONE, BL_HARDCODE_LIST);

  for (const [listKey, phones] of Object.entries(listPhones)) {
    for (const phone of phones) {
      if (!p2list.has(phone)) p2list.set(phone, listKey);
    }
  }

  for (const c of fCalls) {
    if (!c.phone) continue;
    if (c.list && !p2list.has(c.phone)) p2list.set(c.phone, c.list);
    if (c.agent && !p2agent.has(c.phone)) p2agent.set(c.phone, c.agent);
    const list = p2list.get(c.phone) || c.list;
    if (list && c.agent && !p2agList.has(c.phone))
      p2agList.set(c.phone, { agent: c.agent, list });
  }

  // Collect all known list keys
  const allListKeys = new Set<string>(["RT"]);
  for (const k of Object.keys(listPhones)) allListKeys.add(k);
  for (const c of fCalls) if (c.list) allListKeys.add(c.list);

  // Transfer counts: unique phones per list (transferred calls only)
  const txByList: Record<string, Set<string>> = {};
  for (const c of fCalls) {
    if (!c.isTransfer) continue;
    const li = p2list.get(c.phone) || c.list || "Unknown";
    if (!txByList[li]) txByList[li] = new Set();
    txByList[li].add(c.phone);
  }

  // Sales attribution
  const seen = new Set<string>();
  const aiSales: (ReturnType<typeof parseSales>[0] & {
    list: string; agent: string | null; isJR?: boolean;
  })[] = [];
  const nonListSales: (ReturnType<typeof parseSales>[0] & { onOpened: boolean })[] = [];

  for (const s of fSales) {
    const key = `${s.homePhone}|${s.mobilePhone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const phones = [s.homePhone, s.mobilePhone].filter(p => p && p.length === 10);
    const onOpened = phones.some(p => openedSet.has(p));
    const list = phones.includes(BL_HARDCODE_PHONE) ? BL_HARDCODE_LIST
      : (p2list.get(s.homePhone) || p2list.get(s.mobilePhone) || null);
    const isAPI = s.promoCode?.toUpperCase().includes("API");
    const notJ = !s.salesperson?.toLowerCase().includes("fishbien");
    if (isAPI && notJ && !list) { nonListSales.push({ ...s, onOpened }); continue; }
    if (onOpened) {
      const agent = p2agent.get(s.homePhone) || p2agent.get(s.mobilePhone) || null;
      aiSales.push({ ...s, list: list || "Unknown", agent });
    }
  }

  // JR manual sales
  if (inRange("2026-02-25")) {
    for (const jr of JR_SALES) {
      if (!aiSales.some(s => s.homePhone === jr.phone || s.mobilePhone === jr.phone)) {
        aiSales.push({
          soldDate: "2026-02-25",
          lastName: jr.name.split(" ").slice(1).join(" "),
          firstName: jr.name.split(" ")[0],
          promoCode: "", homePhone: jr.phone, mobilePhone: "",
          dealStatus: "Sold", salesperson: "",
          list: jr.list, agent: null, isJR: true,
        });
      }
    }
  }

  // Build byList aggregates
  const byList: Record<string, { t: number; o: number; s: number; min: number; cost: number; listCost: number }> = {};
  const ensure = (li: string) => {
    if (!byList[li]) byList[li] = { t: 0, o: 0, s: 0, min: 0, cost: 0, listCost: listCosts[li] || 0 };
  };
  for (const li of allListKeys) ensure(li as string);
  ensure("Unknown");

  // Transfers (unique phones)
  for (const [li, phones] of Object.entries(txByList)) { ensure(li); byList[li].t += phones.size; }

  // Opened (from 3CX ground truth)
  for (const r of fOpened) {
    if (r.status !== "answered" || !r.destName) continue;
    const li = p2list.get(r.phone) || "Unknown";
    ensure(li); byList[li].o++;
  }

  // Sales
  for (const s of aiSales) { const li = s.list || "Unknown"; ensure(li); byList[li].s++; }

  // Minutes + cost (ALL calls, not just transfers)
  for (const c of fCalls) {
    const li = p2list.get(c.phone) || c.list || "Unknown";
    ensure(li);
    byList[li].min += c.duration;
    byList[li].cost += c.cost;
  }

  // Clean up empty Unknown
  if (byList["Unknown"]?.t === 0 && byList["Unknown"]?.s === 0 && byList["Unknown"]?.o === 0)
    delete byList["Unknown"];

  // byAgent
  const byAgent: Record<string, { calls: number; min: number; cost: number; t: number; deals: number }> = {};
  for (const c of fCalls) {
    if (!byAgent[c.agent]) byAgent[c.agent] = { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
    byAgent[c.agent].calls++;
    byAgent[c.agent].min += c.duration;
    byAgent[c.agent].cost += c.cost;
    if (c.isTransfer) byAgent[c.agent].t++;
  }
  for (const s of aiSales) if (s.agent && byAgent[s.agent]) byAgent[s.agent].deals++;

  // Agent × List matrix
  const allAgents = Object.keys(byAgent);
  const allLists = Object.keys(byList).filter(l => l !== "Unknown");
  const matrix: Record<string, Record<string, { t: number; o: number; d: number }>> = {};
  for (const a of allAgents) { matrix[a] = {}; for (const li of allLists) matrix[a][li] = { t: 0, o: 0, d: 0 }; }

  for (const c of fCalls) {
    if (!c.isTransfer) continue;
    const li = p2list.get(c.phone) || c.list;
    if (li && matrix[c.agent]?.[li]) matrix[c.agent][li].t++;
  }
  for (const r of fOpened) {
    if (r.status !== "answered" || !r.destName) continue;
    const al = p2agList.get(r.phone);
    if (!al || !matrix[al.agent]?.[al.list]) continue;
    matrix[al.agent][al.list].o++;
  }
  for (const s of aiSales) {
    for (const ph of [s.homePhone, s.mobilePhone].filter(Boolean)) {
      const al = p2agList.get(ph);
      if (!al || !matrix[al.agent]?.[al.list]) continue;
      matrix[al.agent][al.list].d++; break;
    }
  }

  return { byList, byAgent, matrix, nonListSales, totalSales: aiSales.length, listCosts, allLists, allAgents };
}

// ── ROUTE HANDLER ────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dateStart = searchParams.get("start");
    const dateEnd = searchParams.get("end");

    if (!fs.existsSync(DATA_DIR)) {
      return NextResponse.json({ error: "No data folder found.", hasData: false, byList: {}, byAgent: {}, matrix: {}, nonListSales: [], totalSales: 0, listCosts: {}, allLists: [], allAgents: [], loadedFiles: [] });
    }

    const files = fs.readdirSync(DATA_DIR);
    let openedRows: ReturnType<typeof parseOpened> = [];
    let salesRows: ReturnType<typeof parseSales> = [];
    const listPhones: Record<string, Set<string>> = {};
    const loadedFiles: string[] = [];

    // Collect all AIM call export files — deduplicate by Call id across files
    const allCallRowsMap = new Map<string, CallRow>();

    for (const file of files) {
      const lower = file.toLowerCase();
      const full = path.join(DATA_DIR, file);

      if (lower === "opened.csv") {
        openedRows = parseOpened(fs.readFileSync(full, "utf8"));
        loadedFiles.push(file);
      } else if (lower === "sales.xls" || lower === "sales.xlsx") {
        salesRows = parseSales(fs.readFileSync(full));
        loadedFiles.push(file);
      } else if (lower.endsWith(".csv") && lower !== ".gitkeep" && lower !== "opened.csv") {
        // Determine if this is a list file or a calls export
        const listKey = detectListKey(file.replace(/\.csv$/i, ""));
        const text = fs.readFileSync(full, "utf8");
        const firstLine = text.split(/\r?\n/)[0] || "";

        if (firstLine.toLowerCase().includes("agent id") || firstLine.toLowerCase().includes("agent name")) {
          // This is an AIM calls export — parse and deduplicate by Call id
          const callRows = parseCallsReport(text);
          for (const row of callRows) {
            if (!allCallRowsMap.has(row.callId)) {
              allCallRowsMap.set(row.callId, row);
            }
          }
          loadedFiles.push(file);
        } else if (listKey) {
          // This is a list file
          listPhones[listKey] = parseListFile(text);
          loadedFiles.push(file);
        }
      }
    }

    const allCallRows = Array.from(allCallRowsMap.values());
    const listCosts = loadListCosts();
    const metrics = computeMetrics(openedRows, allCallRows, salesRows, listPhones, listCosts, { start: dateStart, end: dateEnd });

    const allDates = [
      ...openedRows.map(r => r.date),
      ...allCallRows.map(r => r.date),
    ].filter(Boolean) as string[];
    const minDate = allDates.length ? allDates.reduce((a, b) => a < b ? a : b) : null;
    const maxDate = allDates.length ? allDates.reduce((a, b) => a > b ? a : b) : null;

    return NextResponse.json({
      ...metrics,
      loadedFiles,
      lastUpdated: new Date().toISOString(),
      hasData: loadedFiles.length > 0,
      dataDateRange: { min: minDate, max: maxDate },
      totalCallRows: allCallRows.length,
      dedupedCallFiles: loadedFiles.filter(f => !f.toLowerCase().startsWith("opened") && !f.toLowerCase().startsWith("sales") && f.endsWith(".csv")).length,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err), hasData: false }, { status: 500 });
  }
}
