import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR       = path.join(process.cwd(), "data");
const CAMPAIGN_START = "2026-02-25";

const DEFAULT_LISTS: Record<string, number> = {
  RT: 0, JL021926LP: 8000, BL021926BO: 8000,
  JH022326MN: 8000, JL021926CR: 8000, DG021726SC: 5000, JL022526RS: 6000,
};

// ── UTILITIES ─────────────────────────────────────────────────────────────────
const cleanPhone = (p: unknown): string => {
  const s = String(p || "").replace(/^=/, "").replace(/^"/, "").replace(/"$/, "");
  return s.replace(/\D/g, "").slice(-10);
};

const toISO = (s: string): string | null => {
  if (!s) return null;
  const d = new Date(s.replace(/"/g, "").trim());
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// ── CSV PARSER ────────────────────────────────────────────────────────────────
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

// ── LOAD DATA LIST FILES → phone → list map ───────────────────────────────────
function loadListFiles(): { phoneToList: Map<string, string>; loadedFiles: string[] } {
  const phoneToList = new Map<string, string>();
  const loadedFiles: string[] = [];

  if (!fs.existsSync(DATA_DIR)) return { phoneToList, loadedFiles };

  for (const file of fs.readdirSync(DATA_DIR)) {
    const lower = file.toLowerCase();
    if (lower === ".gitkeep") continue;
    if (!lower.endsWith(".csv")) continue;

    if (lower.includes("call") || lower.includes("aim") ||
        lower.includes("sale") || lower.includes("open") ||
        lower.includes("xfr"))  continue;

    const base    = file.replace(/\.csv$/i, "").toUpperCase();
    const listKey = DEFAULT_LISTS[base] !== undefined ? base : null;
    if (!listKey) continue;

    try {
      const text    = fs.readFileSync(path.join(DATA_DIR, file), "latin1");
      const lines   = text.split(/\r?\n/);
      if (lines.length < 2) continue;

      const headers  = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
      const phoneIdxs = headers
        .map((h, i) => ({ h, i }))
        .filter(({ h }) => h.includes("phone") || h.includes("number") || h.includes("cell") || h.includes("mobile"))
        .map(({ i }) => i);

      const cols = phoneIdxs.length > 0 ? phoneIdxs : headers.map((_, i) => i);

      for (let i = 1; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l) continue;
        const c = parseCsvLine(l);
        for (const idx of cols) {
          const p = cleanPhone(c[idx] || "");
          if (p.length === 10 && !phoneToList.has(p)) phoneToList.set(p, listKey);
        }
      }
      loadedFiles.push(file);
    } catch (e) {
      console.error(`[data] failed to load ${file}:`, e);
    }
  }
  return { phoneToList, loadedFiles };
}

// ── LOAD PHONE→LIST MAP FROM KV ───────────────────────────────────────────────
async function loadPhoneToList(redis: Redis | null): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!redis) return map;
  try {
    const chunks = await redis.get<number>("list:phoneMapChunks");
    if (chunks && chunks > 1) {
      for (let i = 0; i < chunks; i++) {
        const chunk = await redis.get<Record<string, string>>(`list:phoneMap:${i}`);
        if (chunk) for (const [phone, list] of Object.entries(chunk)) map.set(phone, list);
      }
    } else {
      const raw = await redis.get<Record<string, string>>("list:phoneMap");
      if (raw) for (const [phone, list] of Object.entries(raw)) map.set(phone, list);
    }
  } catch (e) {
    console.error("[data] list:phoneMap read failed:", e);
  }
  return map;
}
function loadListCosts(): Record<string, number> {
  const costFile = path.join(DATA_DIR, "list_costs.json");
  if (fs.existsSync(costFile)) {
    try { return JSON.parse(fs.readFileSync(costFile, "utf8")); } catch {}
  }
  return DEFAULT_LISTS;
}

// ── STALENESS CHECK ───────────────────────────────────────────────────────────
// Returns ISO string or null for each source's last-pulled timestamp
async function getStaleness(redis: Redis | null): Promise<{
  cx:   string | null;
  aim:  string | null;
  moxy: string | null;
}> {
  if (!redis) return { cx: null, aim: null, moxy: null };
  try {
    const [cx, aim, moxy] = await Promise.all([
      redis.get<string>("3cx:lastPulled"),
      redis.get<string>("aim:lastPulled"),
      redis.get<string>("moxy:lastSeeded"),
    ]);
    return {
      cx:   cx   ?? null,
      aim:  aim  ?? null,
      moxy: moxy ?? null,
    };
  } catch {
    return { cx: null, aim: null, moxy: null };
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams, origin } = new URL(request.url);
    const dateStart = searchParams.get("start");
    const dateEnd   = searchParams.get("end");
    const today     = new Date().toISOString().slice(0, 10);
    const fromDate  = dateStart ?? CAMPAIGN_START;
    const toDate    = dateEnd   ?? today;

    const listCosts = loadListCosts();
    const redis     = getRedis();

    // ── 1. LOAD PHONE→LIST MAP FROM KV ───────────────────────────────────────
    const phoneToList = await loadPhoneToList(redis);
    // Fall back to filesystem if KV map not seeded yet
    let loadedFiles: string[] = [];
    if (phoneToList.size === 0) {
      const { phoneToList: fsMap, loadedFiles: fsFiles } = loadListFiles();
      for (const [phone, list] of fsMap) phoneToList.set(phone, list);
      loadedFiles = fsFiles;
    } else {
      loadedFiles = Object.keys(DEFAULT_LISTS); // all lists loaded from KV
    }

    // ── 2. LOAD CALLS FROM 3CX KV (filter by date range) ─────────────────────
    // openedSet: phone → true (for sales attribution gate — did this phone ever touch 8043?)
    // callsList: array of { phone, date } for counting calls per list
    let openedPhones: Set<string> = new Set();
    let callsList: { phone: string; date: string }[] = [];
    try {
      const callsResp = await fetch(`${origin}/api/calls?from=${fromDate}&to=${toDate}`);
      if (callsResp.ok) {
        const callsData = await callsResp.json();
        for (const { phone, date } of (callsData.opened ?? [])) {
          if (date >= fromDate && date <= toDate) {
            callsList.push({ phone, date });
            openedPhones.add(phone);
          }
        }
      }
    } catch (e) {
      console.error("[data] 3CX fetch failed:", e);
      // Fallback: read directly from KV
      if (redis) {
        try {
          const [rawCalls, rawPhones] = await Promise.all([
            redis.get<Record<string, { phone: string; date: string }>>("3cx:calls"),
            redis.get<string[]>("3cx:phones"),
          ]);
          if (rawCalls) {
            for (const v of Object.values(rawCalls)) {
              if (v.date >= fromDate && v.date <= toDate) {
                callsList.push({ phone: v.phone, date: v.date });
                openedPhones.add(v.phone);
              }
            }
          }
          if (rawPhones) for (const p of rawPhones) openedPhones.add(p);
        } catch {}
      }
    }

    // Also load ITD phones for sales attribution (phones seen outside date range still count)
    if (redis) {
      try {
        const allPhones = await redis.get<string[]>("3cx:phones");
        if (allPhones) for (const p of allPhones) openedPhones.add(p);
      } catch {}
    }

    // ── 3. LOAD AIM MINUTES/COST FROM KV ────────────────────────────────────
    let aimByList: Record<string, { min: number; cost: number }> = {};
    try {
      const aimResp = await fetch(`${origin}/api/aim?start=${fromDate}&end=${toDate}`);
      if (aimResp.ok) {
        const aimData = await aimResp.json();
        if (aimData.ok && aimData.byList) {
          for (const [li, stats] of Object.entries(aimData.byList as Record<string, { min: number; cost: number }>)) {
            aimByList[li] = { min: stats.min, cost: stats.cost };
          }
        }
      }
    } catch (e) {
      console.error("[data] AIM fetch failed:", e);
    }

    // ── 3b. LOAD AIM BY AGENT FROM KV ────────────────────────────────────────
    type AgentListStats = Record<string, { min: number; cost: number; transfers: number }>;
    let aimByAgent: Record<string, AgentListStats> = {};
    if (redis) {
      try {
        const raw = await redis.get<Record<string, AgentListStats>>("aim:byagent");
        if (raw) aimByAgent = raw;
      } catch (e) {
        console.error("[data] aim:byagent read failed:", e);
      }
    }

    // ── 4. REFRESH MOXY THEN READ FROM KV ────────────────────────────────────
    // Trigger incremental moxy refresh (writes to moxy:sales KV)
    try {
      await fetch(`${origin}/api/moxy`);
    } catch (e) {
      console.error("[data] Moxy refresh failed:", e);
    }

    type SaleRow = {
      soldDate:    string | null;
      lastName:    string;
      firstName:   string;
      promoCode:   string;
      homePhone:   string;
      cellPhone:   string;
      contractNo:  string;
      customerID:  string;
      dealStatus:  string;
      salesperson: string;
    };

    let salesRows: SaleRow[] = [];

    if (redis) {
      try {
        const kvSales = await redis.get<Record<string, {
          soldDate:   string;
          lastName:   string;
          firstName:  string;
          promoCode:  string;
          homePhone:  string;
          cellPhone:  string;
          contractNo: string;
          customerID: string;
          dealStatus: string;
          salesRep:   string;
          salesperson?: string;
        }>>("moxy:sales");

        if (kvSales) {
          salesRows = Object.values(kvSales)
            .filter(s => s.dealStatus === "Sold")
            .map(s => ({
              soldDate:    toISO(s.soldDate ?? ""),
              lastName:    s.lastName    ?? "",
              firstName:   s.firstName   ?? "",
              promoCode:   s.promoCode   ?? "",
              homePhone:   cleanPhone(s.homePhone  ?? ""),
              cellPhone:   cleanPhone(s.cellPhone  ?? ""),
              contractNo:  s.contractNo  ?? "",
              customerID:  s.customerID  ?? "",
              dealStatus:  s.dealStatus  ?? "",
              salesperson: s.salesperson ?? s.salesRep ?? "",
            }))
            .filter(s =>
              s.soldDate &&
              s.soldDate >= CAMPAIGN_START &&
              s.soldDate >= fromDate &&
              s.soldDate <= toDate
            );
        }
      } catch (e) {
        console.error("[data] Moxy KV read failed:", e);
      }
    } else {
      console.warn("[data] Redis not available — skipping Moxy KV read");
    }

    // ── 5. COMPUTE METRICS ───────────────────────────────────────────────────
    const allListKeys = new Set(Object.keys(DEFAULT_LISTS));

    const byList: Record<string, { t: number; o: number; s: number; min: number; cost: number; listCost: number }> = {};
    const ensure = (li: string) => {
      if (!byList[li]) byList[li] = { t: 0, o: 0, s: 0, min: 0, cost: 0, listCost: listCosts[li] ?? 0 };
    };
    for (const li of allListKeys) ensure(li);

    // CALLS — count every qualifying call per list
    for (const { phone } of callsList) {
      const li = phoneToList.get(phone);
      if (li) { ensure(li); byList[li].o++; }
    }

    // MINUTES, COST & TRANSFERS from AIM
    for (const [li, stats] of Object.entries(aimByList)) {
      ensure(li);
      byList[li].min  += stats.min;
      byList[li].cost += stats.cost;
    }

    // TRANSFERS — sum from aimByAgent across all agents for each list
    for (const agentData of Object.values(aimByAgent)) {
      for (const [li, stats] of Object.entries(agentData)) {
        ensure(li);
        byList[li].t += (stats as any).transfers ?? 0;
      }
    }

    // SALES — phone must be in openedSet AND in a list file; not Fishbein
    // New REST API has clean phone data: try homePhone first, then cellPhone
    const seenSales = new Set<string>();

    for (const s of salesRows) {
      const key = s.customerID || s.contractNo || s.homePhone || s.cellPhone;
      if (seenSales.has(key)) continue;
      seenSales.add(key);

      if (s.salesperson?.toLowerCase().includes("fishbein")) continue;

      // Try homePhone first, then cellPhone — check against ITD phone set for attribution
      const candidates = [s.homePhone, s.cellPhone].filter(p => p && p.length === 10);
      const matchedPhone = candidates.find(p => openedPhones.has(p) && phoneToList.has(p));
      if (!matchedPhone) continue;

      const li = phoneToList.get(matchedPhone)!;
      ensure(li);
      byList[li].s++;
    }

    // Round
    for (const v of Object.values(byList)) {
      v.min  = Math.round(v.min);
      v.cost = Math.round(v.cost * 100) / 100;
    }

    // ── 6. STALENESS ─────────────────────────────────────────────────────────
    const staleness = await getStaleness(redis);

    const allLists   = Array.from(allListKeys);
    const totalSales = Object.values(byList).reduce((a, r) => a + r.s, 0);

    return NextResponse.json({
      byList,
      totalSales,
      listCosts,
      allLists,
      loadedFiles,
      lastUpdated: new Date().toISOString(),
      hasData:     loadedFiles.length > 0,
      staleness,
      aimByAgent,
      apiSources: {
        openedCount:     callsList.length,
        salesCount:      salesRows.length,
        listFilesLoaded: loadedFiles.length,
        dateRange:       { from: fromDate, to: toDate },
      },
    });

  } catch (err) {
    console.error("[data/route]", err);
    return NextResponse.json({ error: String(err), hasData: false }, { status: 500 });
  }
}
