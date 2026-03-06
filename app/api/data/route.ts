import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

// ── CONSTANTS ────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), "data");

const CAMPAIGN_MAP: Record<string, string> = {
  "guard responders 2024": "RT",
  "guard responders 2025 part 1": "RT",
  "guard responders 2025 part 2": "RT",
  "jl021926lpa1": "JL(LP)",
  "bl021926boa1": "BL",
  "jh022326mna1": "JH",
  "jl021926cra1": "JL(CR)",
  "dg021726sca1": "DG",
  "jl022526rsa1": "JL(RS)",
};

const AGENT_SHORT: Record<string, string> = {
  "Transfer Outbound Agent with Moxy": "Moxy OG",
  "Transfer Activation Outbound Agent with Moxy": "Activation",
  "Female Transfer Outbound Agent with Moxy version 3": "Female v3",
  "Transfer Outbound Agent with Moxy version 2": "Moxy v2",
  "Male Transfer Outbound Agent with Moxy version 3": "Male v3",
  "Overflow Agent with Spanish Transfer": "Overflow ES",
  "Outbound Jr. Closer to TO Agent with Moxy Tools": "Jr Closer",
};

const LIST_PHONE_COLS: Record<string, string[]> = {
  DG: ["Phoneday", "Phoneevening"],
  "JL(RS)": ["PhoneNumber"],
};

const LISTS = ["RT", "JL(LP)", "BL", "JH", "JL(CR)", "DG", "JL(RS)"];
const AGENTS = ["Moxy OG", "Activation", "Female v3", "Moxy v2", "Male v3"];
const LIST_COST: Record<string, number> = {
  RT: 0, "JL(LP)": 8000, BL: 8000, JH: 8000, "JL(CR)": 8000, DG: 5000, "JL(RS)": 6000,
};
const BL_PHONE = "5125854726";

const JR_SALES = [
  { list: "JL(LP)", phone: "7139069790", name: "Mohammed Omar" },
  { list: "JL(LP)", phone: "4235441118", name: "Ronald Dupree" },
  { list: "BL", phone: "3475936779", name: "Muhammad Salman" },
  { list: "DG", phone: "5043140900", name: "Carnelius Johnson" },
];

// ── UTILITIES ────────────────────────────────────────────────
const cleanPhone = (p: unknown) =>
  String(p || "").replace(/\D/g, "").slice(-10);

const shortAgent = (name: string) =>
  AGENT_SHORT[name] || (Object.values(AGENT_SHORT).includes(name) ? name : null);

const getCampList = (c: string) => {
  const lc = String(c || "").toLowerCase();
  for (const [k, v] of Object.entries(CAMPAIGN_MAP))
    if (lc.includes(k)) return v;
  return null;
};

const excelToISO = (s: number) =>
  isNaN(s) ? null : new Date(Math.round((s - 25569) * 86400000)).toISOString().slice(0, 10);

const toISO = (s: string) => {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// Detect list from filename e.g. "list_RT.csv" → "RT"
const listFromFilename = (filename: string): string | null => {
  const base = filename.toLowerCase().replace("list_", "").replace(".csv", "");
  const map: Record<string, string> = {
    rt: "RT", jllp: "JL(LP)", lp: "JL(LP)", bl: "BL",
    jh: "JH", jlcr: "JL(CR)", cr: "JL(CR)", dg: "DG",
    jlrs: "JL(RS)", rs: "JL(RS)",
  };
  return map[base] || null;
};

// ── PARSERS ──────────────────────────────────────────────────
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

function parseOpened(text: string) {
  const lines = text.split(/\r?\n/);
  const rows: { phone: string; destName: string; status: string; date: string | null }[] = [];
  for (let i = 4; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);
    if (c.length < 12) continue;
    const phone = cleanPhone(c[7]);
    const destName = (c[10] || "").trim();
    const status = (c[11] || "").trim().toLowerCase();
    const date = toISO(c[0]);
    if (phone) rows.push({ phone, destName, status, date });
  }
  return rows;
}

function parseTransfer(text: string) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const hdrs = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const gi = (n: string) => hdrs.findIndex((h) => h.includes(n));
  const aI = gi("agent"), fI = gi("from"), tI = gi("to"), dI = gi("direction"),
    durI = gi("duration"), cI = gi("cost"), sI = gi("started"), campI = gi("campaign");

  const rows: {
    phone: string; fromP: string; toP: string; dir: string;
    agent: string; duration: number; cost: number;
    date: string | null; campaign: string; list: string | null;
  }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);
    const dir = (c[dI >= 0 ? dI : 3] || "").trim().toLowerCase();
    const fromP = cleanPhone(c[fI >= 0 ? fI : 1] || "");
    const toP = cleanPhone(c[tI >= 0 ? tI : 2] || "");
    const phone = dir === "inbound" ? fromP : toP;
    if (!phone) continue;
    const agFull = (c[aI >= 0 ? aI : 0] || "").trim();
    const agent = shortAgent(agFull) || agFull;
    const dur = parseFloat(c[durI >= 0 ? durI : 4]) || 0;
    const cost = parseFloat(c[cI >= 0 ? cI : 5]) || 0;
    const campaign = (c[campI >= 0 ? campI : 7] || "").trim();
    const date = toISO((c[sI >= 0 ? sI : 6] || "").trim());
    rows.push({ phone, fromP, toP, dir, agent, duration: dur / 60, cost, date, campaign, list: getCampList(campaign) });
  }
  return rows;
}

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

function parseMinutes(buf: Buffer) {
  const wb = XLSX.read(buf, { type: "buffer", raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][];
  const res: { agent: string; duration: number; cost: number; date: string | null; list: string | null }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 5) continue;
    const agFull = String(r[0] || "").trim();
    if (!agFull) continue;
    res.push({
      agent: shortAgent(agFull) || agFull,
      duration: (parseFloat(String(r[2])) || 0) / 60,
      cost: parseFloat(String(r[4])) || 0,
      date: toISO(String(r[6] || "")),
      list: getCampList(String(r[7] || "")),
    });
  }
  return res;
}

// Parse a list CSV and return a Set of cleaned phone numbers
function parseListFile(text: string, listKey: string): Set<string> {
  const phones = new Set<string>();
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return phones;
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  
  // Determine which columns to check
  const customCols = LIST_PHONE_COLS[listKey];
  const colIndices: number[] = [];

  if (customCols) {
    for (const col of customCols) {
      const idx = headers.findIndex((h) => h.toLowerCase() === col.toLowerCase());
      if (idx >= 0) colIndices.push(idx);
    }
  } else {
    // Default: look for "Phone" or "phone" column
    const idx = headers.findIndex((h) => h.toLowerCase() === "phone");
    if (idx >= 0) colIndices.push(idx);
  }

  // Fallback: check all columns for anything that looks like a phone
  if (colIndices.length === 0) {
    headers.forEach((h, i) => {
      if (h.toLowerCase().includes("phone")) colIndices.push(i);
    });
  }

  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);
    for (const idx of colIndices) {
      const p = cleanPhone(c[idx] || "");
      if (p.length === 10) phones.add(p);
    }
  }
  return phones;
}

// ── ATTRIBUTION ENGINE ───────────────────────────────────────
function computeMetrics(
  opened: ReturnType<typeof parseOpened>,
  transfers: ReturnType<typeof parseTransfer>,
  sales: ReturnType<typeof parseSales>,
  minutes: ReturnType<typeof parseMinutes>,
  listPhones: Record<string, Set<string>>
) {
  // Build opened set
  const openedSet = new Set<string>();
  for (const r of opened)
    if (r.status === "answered" && r.destName) openedSet.add(r.phone);

  // Phone → list (from actual list files first, then transfer campaign fallback)
  const p2list = new Map<string, string>();
  const p2agent = new Map<string, string>();
  const p2agList = new Map<string, { agent: string; list: string }>();

  // Assign from list files (most accurate)
  for (const [listKey, phones] of Object.entries(listPhones)) {
    for (const phone of phones) {
      if (!p2list.has(phone)) p2list.set(phone, listKey);
    }
  }
  // Hardcoded BL override
  p2list.set(BL_PHONE, "BL");

  // Assign agent from transfer report
  for (const t of transfers) {
    if (!t.phone) continue;
    // If list not yet assigned from list files, fall back to campaign name
    if (t.list && !p2list.has(t.phone)) p2list.set(t.phone, t.list);
    if (t.agent && !p2agent.has(t.phone)) p2agent.set(t.phone, t.agent);
    if (t.list && t.agent && !p2agList.has(t.phone))
      p2agList.set(t.phone, { agent: t.agent, list: p2list.get(t.phone) || t.list });
  }

  // Transfer counts: unique phones per list per day
  const txByListDay: Record<string, Record<string, Set<string>>> = {};
  for (const t of transfers) {
    const li = p2list.get(t.phone) || t.list || "Unknown";
    const dt = t.date || "Unknown";
    if (!txByListDay[li]) txByListDay[li] = {};
    if (!txByListDay[li][dt]) txByListDay[li][dt] = new Set();
    txByListDay[li][dt].add(t.phone);
  }

  // Process sales
  const seen = new Set<string>();
  const aiSales: (ReturnType<typeof parseSales>[0] & { list: string; agent: string | null; isJR?: boolean })[] = [];
  const nonListSales: (ReturnType<typeof parseSales>[0] & { onOpened: boolean })[] = [];

  for (const s of sales) {
    const key = `${s.homePhone}|${s.mobilePhone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const onO = (s.homePhone && openedSet.has(s.homePhone)) ||
      (s.mobilePhone && openedSet.has(s.mobilePhone));
    let list = s.homePhone === BL_PHONE || s.mobilePhone === BL_PHONE
      ? "BL"
      : p2list.get(s.homePhone) || p2list.get(s.mobilePhone) || null;
    const isAPI = s.promoCode?.toUpperCase().includes("API");
    const notJ = !s.salesperson?.toLowerCase().includes("fishbien");
    if (isAPI && notJ && !list) {
      nonListSales.push({ ...s, onOpened: !!onO });
      continue;
    }
    if (onO) {
      const agent = p2agent.get(s.homePhone) || p2agent.get(s.mobilePhone) || null;
      aiSales.push({ ...s, list: list || "Unknown", agent });
    }
  }

  // JR manual sales
  for (const jr of JR_SALES) {
    if (!aiSales.some((s) => s.homePhone === jr.phone || s.mobilePhone === jr.phone))
      aiSales.push({
        soldDate: "2026-02-25",
        lastName: jr.name.split(" ").slice(1).join(" "),
        firstName: jr.name.split(" ")[0],
        promoCode: "", homePhone: jr.phone, mobilePhone: "",
        dealStatus: "Sold", salesperson: "",
        list: jr.list, agent: null, isJR: true,
      });
  }

  // Aggregate byList
  const byList: Record<string, { t: number; o: number; s: number; min: number; cost: number }> = {};
  for (const li of [...LISTS, "Unknown"]) byList[li] = { t: 0, o: 0, s: 0, min: 0, cost: 0 };

  for (const [li, dayMap] of Object.entries(txByListDay)) {
    if (!byList[li]) continue;
    for (const ph of Object.values(dayMap)) byList[li].t += ph.size;
  }
  for (const r of opened) {
    if (r.status !== "answered" || !r.destName) continue;
    const li = p2list.get(r.phone) || "Unknown";
    if (byList[li]) byList[li].o++;
  }
  for (const s of aiSales) {
    const li = s.list || "Unknown";
    if (byList[li]) byList[li].s++;
  }
  for (const m of minutes) {
    const li = m.list || "Unknown";
    if (byList[li]) { byList[li].min += m.duration; byList[li].cost += m.cost; }
  }

  // Aggregate byAgent
  const byAgent: Record<string, { calls: number; min: number; cost: number; t: number; deals: number }> = {};
  for (const a of AGENTS) byAgent[a] = { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
  for (const m of minutes) {
    if (!byAgent[m.agent]) byAgent[m.agent] = { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
    byAgent[m.agent].calls++;
    byAgent[m.agent].min += m.duration;
    byAgent[m.agent].cost += m.cost;
  }
  for (const t of transfers) {
    if (!byAgent[t.agent]) byAgent[t.agent] = { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
    byAgent[t.agent].t++;
  }
  for (const s of aiSales) if (s.agent && byAgent[s.agent]) byAgent[s.agent].deals++;

  // Agent × List matrix
  const matrix: Record<string, Record<string, { t: number; o: number; d: number }>> = {};
  for (const a of AGENTS) {
    matrix[a] = {};
    for (const li of LISTS) matrix[a][li] = { t: 0, o: 0, d: 0 };
  }
  for (const t of transfers)
    if (matrix[t.agent] && t.list && matrix[t.agent][t.list]) matrix[t.agent][t.list].t++;
  for (const r of opened) {
    if (r.status !== "answered" || !r.destName) continue;
    const al = p2agList.get(r.phone);
    if (!al) continue;
    if (matrix[al.agent] && al.list && matrix[al.agent][al.list]) matrix[al.agent][al.list].o++;
  }
  for (const s of aiSales) {
    const phones = [s.homePhone, s.mobilePhone].filter(Boolean);
    for (const ph of phones) {
      const al = p2agList.get(ph);
      if (!al) continue;
      if (matrix[al.agent] && al.list && matrix[al.agent][al.list]) {
        matrix[al.agent][al.list].d++;
        break;
      }
    }
  }

  return { byList, byAgent, matrix, nonListSales, totalSales: aiSales.length, listCost: LIST_COST };
}

// ── ROUTE HANDLER ────────────────────────────────────────────
export async function GET() {
  try {
    // Check data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      return NextResponse.json({ error: "No data folder found. Create a /data folder and add your report files." }, { status: 404 });
    }

    const files = fs.readdirSync(DATA_DIR);

    // Read each report type if present
    let openedRows: ReturnType<typeof parseOpened> = [];
    let transferRows: ReturnType<typeof parseTransfer> = [];
    let salesRows: ReturnType<typeof parseSales> = [];
    let minutesRows: ReturnType<typeof parseMinutes> = [];
    const listPhones: Record<string, Set<string>> = {};
    const loadedFiles: string[] = [];

    for (const file of files) {
      const lower = file.toLowerCase();
      const fullPath = path.join(DATA_DIR, file);

      if (lower.startsWith("opened") && lower.endsWith(".csv")) {
        openedRows = parseOpened(fs.readFileSync(fullPath, "utf8"));
        loadedFiles.push(file);
      } else if (lower.startsWith("transfer") && lower.endsWith(".csv")) {
        transferRows = parseTransfer(fs.readFileSync(fullPath, "utf8"));
        loadedFiles.push(file);
      } else if (lower.startsWith("sales") && (lower.endsWith(".xls") || lower.endsWith(".xlsx"))) {
        salesRows = parseSales(fs.readFileSync(fullPath));
        loadedFiles.push(file);
      } else if (lower.startsWith("minutes") && (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv"))) {
        minutesRows = parseMinutes(fs.readFileSync(fullPath));
        loadedFiles.push(file);
      } else if (lower.startsWith("list_") && lower.endsWith(".csv")) {
        // Auto-detect which list this is from filename
        const listKey = listFromFilename(file);
        if (listKey) {
          listPhones[listKey] = parseListFile(fs.readFileSync(fullPath, "utf8"), listKey);
          loadedFiles.push(file);
        }
      }
    }

    const metrics = computeMetrics(openedRows, transferRows, salesRows, minutesRows, listPhones);

    return NextResponse.json({
      ...metrics,
      loadedFiles,
      lastUpdated: new Date().toISOString(),
      hasData: loadedFiles.length > 0,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
