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

    // Skip non-list files (AIM exports, sales, opened)
    if (lower.includes("call") || lower.includes("aim") ||
        lower.includes("sale") || lower.includes("open") ||
        lower.includes("xfr"))  continue;

    // Determine list key from filename
    const base = file.replace(/\.csv$/i, "").toUpperCase();
    const listKey = DEFAULT_LISTS[base] !== undefined ? base : null;
    if (!listKey) continue;

    try {
      const text    = fs.readFileSync(path.join(DATA_DIR, file), "latin1");
      const lines   = text.split(/\r?\n/);
      if (lines.length < 2) continue;

      const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
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

// ── LOAD LIST COSTS ───────────────────────────────────────────────────────────
function loadListCosts(): Record<string, number> {
  const costFile = path.join(DATA_DIR, "list_costs.json");
  if (fs.existsSync(costFile)) {
    try { return JSON.parse(fs.readFileSync(costFile, "utf8")); } catch {}
  }
  return DEFAULT_LISTS;
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

    // ── 1. LOAD DATA LIST FILES ───────────────────────────────────────────────
    const { phoneToList, loadedFiles } = loadListFiles();

    // ── 2. LOAD OPENED FROM KV (ITD dedup, filter by date range) ─────────────
    // opened = phones that first appeared in 3CX opened set within date range
    // Trigger 3CX refresh to update KV
    let openedSet: Record<string, { date: string }> = {};
    try {
      const callsResp = await fetch(`${origin}/api/calls?from=${fromDate}&to=${toDate}`);
      if (callsResp.ok) {
        const callsData = await callsResp.json();
        // calls route returns opened phones filtered to date range
        for (const { phone, date } of (callsData.opened ?? [])) {
          if (date >= fromDate && date <= toDate) {
            openedSet[phone] = { date };
          }
        }
      }
    } catch (e) {
      console.error("[data] 3CX fetch failed:", e);
      // Fallback: load directly from KV
      if (redis) {
        try {
          const raw = await redis.get<Record<string, { date: string }>>("3cx:opened");
          if (raw) {
            for (const [phone, v] of Object.entries(raw)) {
              if (v.date >= fromDate && v.date <= toDate) openedSet[phone] = v;
            }
          }
        } catch {}
      }
    }

    // ── 3. LOAD AIM MINUTES/COST FROM KV ────────────────────────────────────
    type DailyAIM = Record<string, Record<string, { min: number; cost: number }>>;
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

    // ── 4. FETCH MOXY SALES ──────────────────────────────────────────────────
    type SaleRow = {
      soldDate: string | null; lastName: string; firstName: string;
      promoCode: string; homePhone: string; mobilePhone: string;
      dealStatus: string; salesperson: string;
    };
    let salesRows: SaleRow[] = [];
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
            homePhone:   cleanPhone(s.homePhone ?? ""),
            mobilePhone: cleanPhone(s.cellPhone ?? ""),
            dealStatus:  s.status    ?? "",
            salesperson: s.salesRep  ?? "",
          }))
          .filter((s: SaleRow) => s.soldDate && s.soldDate >= CAMPAIGN_START && s.soldDate >= fromDate && s.soldDate <= toDate);
      }
    } catch (e) {
      console.error("[data] Moxy fetch failed:", e);
    }

    // ── 5. COMPUTE METRICS ───────────────────────────────────────────────────
    const allListKeys = new Set(Object.keys(DEFAULT_LISTS));

    const byList: Record<string, { t: number; o: number; s: number; min: number; cost: number; listCost: number }> = {};
    const ensure = (li: string) => {
      if (!byList[li]) byList[li] = { t: 0, o: 0, s: 0, min: 0, cost: 0, listCost: listCosts[li] ?? 0 };
    };
    for (const li of allListKeys) ensure(li);

    // OPENED — count phones in openedSet that belong to each list
    for (const phone of Object.keys(openedSet)) {
      const li = phoneToList.get(phone);
      if (li) { ensure(li); byList[li].o++; }
    }

    // MINUTES & COST — from AIM KV aggregates
    for (const [li, stats] of Object.entries(aimByList)) {
      ensure(li);
      byList[li].min  += stats.min;
      byList[li].cost += stats.cost;
    }

    // SALES — phone must be in openedSet AND in data list files, not Fishbein
    const nonListSales: (SaleRow & { matchedPhone?: string })[] = [];
    const seenSales = new Set<string>();

    for (const s of salesRows) {
      const key = `${s.homePhone}|${s.mobilePhone}`;
      if (seenSales.has(key)) continue;
      seenSales.add(key);

      const notFishbein = !s.salesperson?.toLowerCase().includes("fishbein");
      if (!notFishbein) continue;

      const phones = [s.homePhone, s.mobilePhone].filter(p => p && p.length === 10);

      // Phone must be in opened set AND in a data list
      const matchedPhone = phones.find(p => openedSet[p] && phoneToList.has(p));

      if (!matchedPhone) {
        nonListSales.push({ ...s });
        continue;
      }

      const li = phoneToList.get(matchedPhone)!;
      ensure(li);
      byList[li].s++;
    }

    // Round minutes and cost
    for (const v of Object.values(byList)) {
      v.min  = Math.round(v.min);
      v.cost = Math.round(v.cost * 100) / 100;
    }

    const allLists  = Array.from(allListKeys);
    const totalSales = Object.values(byList).reduce((a, r) => a + r.s, 0);

    return NextResponse.json({
      byList,
      nonListSales,
      totalSales,
      listCosts,
      allLists,
      loadedFiles,
      lastUpdated: new Date().toISOString(),
      hasData:     Object.keys(openedSet).length > 0 || Object.keys(aimByList).length > 0,
      apiSources: {
        openedCount:     Object.keys(openedSet).length,
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
