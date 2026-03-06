import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

// ── AGENT SHORT NAMES ────────────────────────────────────────────────────────
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
const BL_HARDCODE_LIST  = "BL021926BO";

// Campaign start date — never fetch 3CX data before this
const CAMPAIGN_START = "2026-02-25";

const DEFAULT_COSTS: Record<string, number> = {
  RT:         0,
  JL021926LP: 8000,
  BL021926BO: 8000,
  JH022326MN: 8000,
  JL021926CR: 8000,
  DG021726SC: 5000,
  JL022526RS: 6000,
};

// ── UTILITIES ────────────────────────────────────────────────────────────────
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

// ── LIST KEY DETECTION ───────────────────────────────────────────────────────
const detectListKey = (text: string): string | null => {
  if (!text) return null;
  if (text.toLowerCase().includes("responder")) return "RT";
  const m10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (m10) return (m10[1] + m10[2] + m10[3]).toUpperCase();
  const m8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (m8) return (m8[1] + m8[2]).toUpperCase();
  return null;
};

// ── CSV PARSER ───────────────────────────────────────────────────────────────
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

// ── PARSE XFR TRANSFER FILE ──────────────────────────────────────────────────
interface XfrRow {
  phone: string; agent: string; campaign: string;
  list: string | null; date: string | null;
}

function parseXfrFile(text: string): XfrRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const findCol = (...names: string[]) => {
    for (const name of names) {
      const idx = headers.findIndex(h => h.includes(name));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const phoneI = findCol("phone", "number", "to", "destination");
  const agentI = findCol("agent");
  const campI  = findCol("campaign");
  const dateI  = findCol("date", "started", "time", "created");
  const rows: XfrRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);
    const phone = cleanPhone(c[phoneI >= 0 ? phoneI : 2] || "");
    if (!phone || phone.length !== 10) continue;
    const agFull   = (c[agentI >= 0 ? agentI : 0] || "").trim();
    const campaign = (c[campI  >= 0 ? campI  : 3] || "").trim();
    const date     = dateI >= 0 ? toISO((c[dateI] || "").trim()) : null;
    rows.push({ phone, agent: shortAgent(agFull), campaign, list: detectListKey(campaign), date });
  }
  return rows;
}

// ── PARSE AIM CALLS REPORT ───────────────────────────────────────────────────
interface CallRow {
  callId: string; phone: string; agent: string;
  duration: number; transferDuration: number; cost: number;
  date: string | null; campaign: string; list: string | null; isTransfer: boolean;
}

function parseCallsReport(text: string): CallRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const gi = (name: string) => headers.findIndex(h => h === name);
  const aI      = gi("agent name");
  const durI    = gi("duration (seconds)");
  const tDurI   = gi("transfer call duration");
  const cI      = gi("cost");
  const sI      = gi("started at");
  const campI   = gi("campaign name");
  const outI    = gi("outcomes");
  const callIdI = gi("call id");
  const phoneI  = gi("phone number");
  const rows: CallRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);
    const callId = (c[callIdI >= 0 ? callIdI : 12] || "").trim();
    if (!callId) continue;
    let phone = cleanPhone(c[phoneI >= 0 ? phoneI : 15] || "");
    if (!phone || phone.length !== 10) {
      const dir   = (c[4] || "").trim().toLowerCase();
      const fromP = cleanPhone(c[2] || "");
      const toP   = cleanPhone(c[3] || "");
      phone = dir === "outbound" ? toP : fromP;
    }
    if (!phone || phone.length !== 10) continue;
    const campaign  = (c[campI >= 0 ? campI : 13] || "").trim();
    const agFull    = (c[aI    >= 0 ? aI    : 1]  || "").trim();
    const dur       = (parseFloat(c[durI  >= 0 ? durI  : 6]) || 0) / 60;
    const tDur      = (parseFloat(c[tDurI >= 0 ? tDurI : 7]) || 0) / 60;
    const cost      = parseFloat(c[cI    >= 0 ? cI    : 8]) || 0;
    const date      = toISO((c[sI >= 0 ? sI : 11] || "").trim());
    const outcome   = (c[outI >= 0 ? outI : 10] || "").trim().toLowerCase();
    rows.push({
      callId, phone, agent: shortAgent(agFull),
      duration: dur, transferDuration: tDur, cost, date,
      campaign, list: detectListKey(campaign),
      isTransfer: outcome === "transferred",
    });
  }
  return rows;
}

// ── PARSE LIST FILE ──────────────────────────────────────────────────────────
function parseListFile(text: string): Set<string> {
  const phones = new Set<string>();
  const lines  = text.split(/\r?\n/);
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

// ── LOAD LIST COSTS ──────────────────────────────────────────────────────────
function loadListCosts(): Record<string, number> {
  const costFile = path.join(DATA_DIR, "list_costs.json");
  if (fs.existsSync(costFile)) {
    try { return JSON.parse(fs.readFileSync(costFile, "utf8")); } catch { /* fall */ }
  }
  return DEFAULT_COSTS;
}

// ── ATTRIBUTION ENGINE ───────────────────────────────────────────────────────
function computeMetrics(
  opened: { phone: string; destName: string; status: string; date: string | null }[],
  calls: CallRow[],
  xfrRows: XfrRow[],
  sales: {
    soldDate: string | null; lastName: string; firstName: string;
    promoCode: string; homePhone: string; mobilePhone: string;
    dealStatus: string; salesperson: string;
  }[],
  listPhones: Record<string, Set<string>>,
  listCosts: Record<string, number>,
  dateFilter: { start: string | null; end: string | null },
  hasXfrFile: boolean
) {
  const { start, end } = dateFilter;
  const inRange = (date: string | null) => {
    if (!date) return true;
    if (start && date < start) return false;
    if (end   && date > end)   return false;
    return true;
  };

  const fOpened = opened.filter(r => inRange(r.date));
  const fCalls  = calls.filter(r => inRange(r.date));
  const fXfr    = xfrRows.filter(r => inRange(r.date));
  // Moxy returns ALL sales — filter to campaign start at minimum
  const fSales  = sales.filter(r => r.soldDate && r.soldDate >= CAMPAIGN_START && inRange(r.soldDate));

  // Ground truth phones that reached a rep
  const openedSet = new Set<string>();
  for (const r of fOpened)
    if (r.status === "answered" && r.destName) openedSet.add(r.phone);

  // phone → list / agent mapping
  const p2list   = new Map<string, string>();
  const p2agent  = new Map<string, string>();
  const p2agList = new Map<string, { agent: string; list: string }>();

  p2list.set(BL_HARDCODE_PHONE, BL_HARDCODE_LIST);

  for (const [listKey, phones] of Object.entries(listPhones))
    for (const phone of phones)
      if (!p2list.has(phone)) p2list.set(phone, listKey);

  for (const x of fXfr) {
    if (x.list  && !p2list.has(x.phone))  p2list.set(x.phone, x.list);
    if (x.agent && !p2agent.has(x.phone)) p2agent.set(x.phone, x.agent);
    const list = p2list.get(x.phone) || x.list;
    if (list && x.agent && !p2agList.has(x.phone))
      p2agList.set(x.phone, { agent: x.agent, list });
  }

  for (const c of fCalls) {
    if (!c.phone) continue;
    if (c.list  && !p2list.has(c.phone))  p2list.set(c.phone, c.list);
    if (c.agent && !p2agent.has(c.phone)) p2agent.set(c.phone, c.agent);
    const list = p2list.get(c.phone) || c.list;
    if (list && c.agent && !p2agList.has(c.phone))
      p2agList.set(c.phone, { agent: c.agent, list });
  }

  const allListKeys = new Set<string>(Object.keys(DEFAULT_COSTS));
  for (const k of Object.keys(listPhones)) allListKeys.add(k);

  // ── TRANSFER COUNTS ──────────────────────────────────────────────────────
  const txByList: Record<string, Set<string>> = {};
  if (hasXfrFile && fXfr.length > 0) {
    for (const x of fXfr) {
      const li = p2list.get(x.phone) || x.list;
      if (!li || !DEFAULT_COSTS.hasOwnProperty(li)) continue;
      if (!txByList[li]) txByList[li] = new Set();
      txByList[li].add(x.phone);
    }
  } else {
    for (const c of fCalls) {
      if (!c.isTransfer) continue;
      const li = p2list.get(c.phone) || c.list || "Unknown";
      if (!txByList[li]) txByList[li] = new Set();
      txByList[li].add(c.phone);
    }
  }

  // Sales attribution
  const seen = new Set<string>();
  const aiSales: (typeof fSales[0] & { list: string; agent: string | null; isJR?: boolean })[] = [];
  const nonListSales: (typeof fSales[0] & { onOpened: boolean })[] = [];

  for (const s of fSales) {
    const key = `${s.homePhone}|${s.mobilePhone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const phones   = [s.homePhone, s.mobilePhone].filter(p => p && p.length === 10);
    const onOpened = phones.some(p => openedSet.has(p));
    const list     = phones.includes(BL_HARDCODE_PHONE) ? BL_HARDCODE_LIST
      : (p2list.get(s.homePhone) || p2list.get(s.mobilePhone) || null);
    const isAPI    = s.promoCode?.toUpperCase().includes("API");
    const notJ     = !s.salesperson?.toLowerCase().includes("fishbien");
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
          soldDate: "2026-02-25", lastName: jr.name.split(" ").slice(1).join(" "),
          firstName: jr.name.split(" ")[0], promoCode: "", homePhone: jr.phone,
          mobilePhone: "", dealStatus: "Sold", salesperson: "",
          list: jr.list, agent: null, isJR: true,
        });
      }
    }
  }

  // byList aggregates
  const byList: Record<string, { t: number; o: number; s: number; min: number; cost: number; listCost: number }> = {};
  const ensure = (li: string) => {
    if (!byList[li]) byList[li] = { t: 0, o: 0, s: 0, min: 0, cost: 0, listCost: listCosts[li] || 0 };
  };
  for (const li of allListKeys) ensure(li as string);

  for (const [li, phones] of Object.entries(txByList)) { ensure(li); byList[li].t += phones.size; }

  for (const r of fOpened) {
    if (r.status !== "answered" || !r.destName) continue;
    const li = p2list.get(r.phone) || "Unknown";
    if (!DEFAULT_COSTS.hasOwnProperty(li)) continue;
    ensure(li); byList[li].o++;
  }

  for (const s of aiSales) {
    const li = s.list || "Unknown";
    if (!DEFAULT_COSTS.hasOwnProperty(li)) continue;
    ensure(li); byList[li].s++;
  }

  for (const c of fCalls) {
    const li = p2list.get(c.phone) || c.list || "Unknown";
    if (!DEFAULT_COSTS.hasOwnProperty(li)) continue;
    ensure(li);
    byList[li].min  += c.duration;
    byList[li].cost += c.cost;
  }

  // byAgent
  const byAgent: Record<string, { calls: number; min: number; cost: number; t: number; deals: number }> = {};
  for (const c of fCalls) {
    if (!byAgent[c.agent]) byAgent[c.agent] = { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
    byAgent[c.agent].calls++;
    byAgent[c.agent].min  += c.duration;
    byAgent[c.agent].cost += c.cost;
    if (c.isTransfer) byAgent[c.agent].t++;
  }

  if (hasXfrFile && fXfr.length > 0) {
    for (const a of Object.keys(byAgent)) byAgent[a].t = 0;
    for (const x of fXfr) {
      if (!x.agent) continue;
      if (!byAgent[x.agent]) byAgent[x.agent] = { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
      byAgent[x.agent].t++;
    }
  }

  for (const s of aiSales) if (s.agent && byAgent[s.agent]) byAgent[s.agent].deals++;

  // Agent × List matrix
  const allAgents = Object.keys(byAgent);
  const allLists  = Object.keys(byList);
  const matrix: Record<string, Record<string, { t: number; o: number; d: number }>> = {};
  for (const a of allAgents) {
    matrix[a] = {};
    for (const li of allLists) matrix[a][li] = { t: 0, o: 0, d: 0 };
  }

  const transferItems = hasXfrFile && fXfr.length > 0
    ? fXfr.map(x => ({ phone: x.phone, agent: x.agent, list: x.list }))
    : fCalls.filter(c => c.isTransfer).map(c => ({ phone: c.phone, agent: c.agent, list: c.list }));

  for (const item of transferItems) {
    const li = p2list.get(item.phone) || item.list;
    if (li && matrix[item.agent]?.[li]) matrix[item.agent][li].t++;
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

// ── ROUTE HANDLER ─────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams, origin } = new URL(request.url);
    const dateStart = searchParams.get("start");
    const dateEnd   = searchParams.get("end");

    // Clamp date range to campaign start — never go earlier than Feb 25
    const today    = new Date().toISOString().slice(0, 10);
    const fromDate = dateStart && dateStart > CAMPAIGN_START ? dateStart : CAMPAIGN_START;
    const toDate   = dateEnd   ?? today;

    // ── 1. FETCH 3CX CALLS for the current date range ─────────────────────
    // We pass the actual date range so the API only fetches what we need,
    // avoiding the 2000-call cap cutting off recent data on ITD queries.
    let openedRows: { phone: string; destName: string; status: string; date: string | null }[] = [];
    try {
      const callsResp = await fetch(
        `${origin}/api/calls?from=${fromDate}&to=${toDate}`
      );
      if (callsResp.ok) {
        const callsData = await callsResp.json();
        openedRows = (callsData.calls ?? []).map((c: {
          phoneNumber: string; destName: string; answered: boolean;
          status: string; startTime: string;
        }) => ({
          phone:    c.phoneNumber,
          destName: c.destName ?? "",
          status:   c.answered ? "answered" : (c.status ?? ""),
          date:     toISO(c.startTime ?? ""),
        })).filter((r: { phone: string }) => r.phone && r.phone.length === 10);
      }
    } catch (e) {
      console.error("[data/route] 3CX calls fetch failed:", e);
    }

    // ── 2. FETCH MOXY SALES ───────────────────────────────────────────────
    // Moxy returns ALL sales — date filtering happens in computeMetrics
    // which clamps to CAMPAIGN_START and the requested date range.
    let salesRows: {
      soldDate: string | null; lastName: string; firstName: string;
      promoCode: string; homePhone: string; mobilePhone: string;
      dealStatus: string; salesperson: string;
    }[] = [];
    try {
      const moxyResp = await fetch(`${origin}/api/moxy`);
      if (moxyResp.ok) {
        const moxyData = await moxyResp.json();
        salesRows = (moxyData.sales ?? [])
          .filter((s: { status: string }) => (s.status ?? "").trim() === "Sold")
          .map((s: {
            soldDate: string; lastName: string; firstName: string;
            promoCode: string; homePhone: string; cellPhone: string;
            status: string; salesRep: string;
          }) => ({
            soldDate:    toISO(s.soldDate ?? ""),
            lastName:    s.lastName  ?? "",
            firstName:   s.firstName ?? "",
            promoCode:   s.promoCode ?? "",
            homePhone:   s.homePhone  ?? "",
            mobilePhone: s.cellPhone  ?? "",
            dealStatus:  s.status     ?? "",
            salesperson: s.salesRep   ?? "",
          }));
      }
    } catch (e) {
      console.error("[data/route] Moxy sales fetch failed:", e);
    }

    // ── 3. FILE-BASED DATA (XFR, AIM calls export, list files) ───────────
    const listPhones: Record<string, Set<string>> = {};
    let xfrRows:    XfrRow[] = [];
    let hasXfrFile = false;
    const loadedFiles: string[] = [];
    const allCallRowsMap = new Map<string, CallRow>();

    if (fs.existsSync(DATA_DIR)) {
      const files = fs.readdirSync(DATA_DIR);
      for (const file of files) {
        const lower = file.toLowerCase();
        const full  = path.join(DATA_DIR, file);
        if (lower.endsWith(".csv") && lower !== ".gitkeep" && lower !== "opened.csv") {
          if (lower.startsWith("xfr")) {
            xfrRows    = parseXfrFile(fs.readFileSync(full, "utf8"));
            hasXfrFile = true;
            loadedFiles.push(file);
          } else {
            const listKey   = detectListKey(file.replace(/\.csv$/i, ""));
            const text      = fs.readFileSync(full, "utf8");
            const firstLine = text.split(/\r?\n/)[0] || "";
            if (firstLine.toLowerCase().includes("agent id") || firstLine.toLowerCase().includes("agent name")) {
              const callRows = parseCallsReport(text);
              for (const row of callRows)
                if (!allCallRowsMap.has(row.callId)) allCallRowsMap.set(row.callId, row);
              loadedFiles.push(file);
            } else if (listKey) {
              listPhones[listKey] = parseListFile(text);
              loadedFiles.push(file);
            }
          }
        }
      }
    }

    const allCallRows = Array.from(allCallRowsMap.values());
    const listCosts   = loadListCosts();

    const metrics = computeMetrics(
      openedRows, allCallRows, xfrRows, salesRows,
      listPhones, listCosts,
      { start: dateStart, end: dateEnd },
      hasXfrFile
    );

    const allDates = [
      ...openedRows.map(r => r.date),
      ...allCallRows.map(r => r.date),
    ].filter(Boolean) as string[];
    const minDate = allDates.length ? allDates.reduce((a, b) => a < b ? a : b) : null;
    const maxDate = allDates.length ? allDates.reduce((a, b) => a > b ? a : b) : null;

    return NextResponse.json({
      ...metrics,
      loadedFiles,
      lastUpdated:   new Date().toISOString(),
      hasData:       openedRows.length > 0 || salesRows.length > 0 || loadedFiles.length > 0,
      dataDateRange: { min: minDate, max: maxDate },
      totalCallRows: allCallRows.length,
      xfrRows:       xfrRows.length,
      hasXfrFile,
      apiSources: {
        openedCount: openedRows.length,
        salesCount:  salesRows.length,
        dateRange:   { from: fromDate, to: toDate },
      },
    });

  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err), hasData: false }, { status: 500 });
  }
}
