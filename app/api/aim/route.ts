import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

// ─── Config ────────────────────────────────────────────────────────────────────
const AIM_BASE = "https://dash.aimnow.ai";
const DATA_DIR = path.join(process.cwd(), "data");

const KNOWN_LISTS: Record<string, number> = {
  RT:         0,
  JL021926LP: 8000,
  BL021926BO: 8000,
  JH022326MN: 8000,
  JL021926CR: 8000,
  DG021726SC: 5000,
  JL022526RS: 6000,
};

const AGENT_SHORT: Record<string, string> = {
  "Transfer Outbound Agent with Moxy":                              "Moxy OG",
  "Transfer Activation Outbound Agent with Moxy":                   "Activation",
  "Female Transfer Outbound Agent with Moxy version 3":             "Female v3",
  "Transfer Outbound Agent with Moxy version 2":                    "Moxy v2",
  "Male Transfer Outbound Agent with Moxy version 3":               "Male v3",
  "Overflow Agent with Spanish Transfer":                           "Overflow ES",
  "Outbound Jr. Closer to TO Agent with Moxy Tools":                "Jr Closer",
};
const shortAgent = (name: string) => AGENT_SHORT[name] || name;

const detectListKey = (text: string): string | null => {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const match10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (match10) return (match10[1] + match10[2] + match10[3]).toUpperCase();
  const match8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (match8) return (match8[1] + match8[2]).toUpperCase();
  return null;
};

// ─── Seed file types ───────────────────────────────────────────────────────────
interface SeedTransfer {
  phone:   string;
  listKey: string;
  agent:   string;
  date:    string;   // YYYY-MM-DD
  dSec:    number;
  cost:    number;
}

interface SeedFile {
  generatedAt: string;
  count:       number;
  transfers:   SeedTransfer[];
  listCosts?:  Record<string, { min: number; cost: number; calls: number }>;
  dailyCosts?: Record<string, Record<string, { min: number; cost: number }>>;
}

// ─── Aggregation structure ────────────────────────────────────────────────────
interface ListData {
  phonesByDay:  Map<string, Set<string>>;   // date → unique phones (for transfer count)
  tPhones:      Set<string>;                // all-time unique phones (sales cross-ref)
  phoneToAgent: Map<string, string>;
  min:          number;
  cost:         number;
  listCost:     number;
}

function makeListData(listKey: string): ListData {
  return {
    phonesByDay:  new Map(),
    tPhones:      new Set(),
    phoneToAgent: new Map(),
    min:          0,
    cost:         0,
    listCost:     KNOWN_LISTS[listKey] ?? 0,
  };
}

function mergeTransfer(
  byList: Record<string, ListData>,
  byAgent: Record<string, { t: number; min: number; cost: number }>,
  listKey: string,
  phone:   string,
  agent:   string,
  date:    string,
  dSec:    number,
  cost:    number,
) {
  if (!byList[listKey]) byList[listKey] = makeListData(listKey);

  const entry = byList[listKey];
  entry.min  += dSec / 60;
  entry.cost += cost;

  if (!entry.phonesByDay.has(date)) entry.phonesByDay.set(date, new Set());
  entry.phonesByDay.get(date)!.add(phone);
  entry.tPhones.add(phone);
  if (!entry.phoneToAgent.has(phone)) entry.phoneToAgent.set(phone, agent);

  if (!byAgent[agent]) byAgent[agent] = { t: 0, min: 0, cost: 0 };
  byAgent[agent].min  += dSec / 60;
  byAgent[agent].cost += cost;
  byAgent[agent].t++;
}

// ─── Seed loader ───────────────────────────────────────────────────────────────
function loadSeed(): SeedFile | null {
  const seedPath = path.join(DATA_DIR, "aim_transfers_seed.json");
  try {
    if (!fs.existsSync(seedPath)) return null;
    return JSON.parse(fs.readFileSync(seedPath, "utf8")) as SeedFile;
  } catch {
    return null;
  }
}

// ─── REST API helper with bearer token auth ─────────────────────────────────
const AIM_REST = 'https://dash.aimnow.ai/api';

async function aimFetch(path: string, params: Record<string, string | string[]>): Promise<any> {
  const token = process.env.AIM_BEARER_TOKEN;
  if (!token) throw new Error('AIM_BEARER_TOKEN not set');

  const url = new URL(`${AIM_REST}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, item);
    } else {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`AIM API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Main route ───────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const startParam = searchParams.get("start");
    const endParam   = searchParams.get("end");

    const fromDate = startParam ?? "2026-02-25";
    const toDate   = endParam   ?? new Date().toISOString().slice(0, 10);

    // ── 1. Load seed for historical transfers ────────────────────────────────
    const seed = loadSeed();
    const seedMaxDate = seed
      ? seed.transfers.reduce((max, t) => t.date > max ? t.date : max, "")
      : "";

    const byList:  Record<string, ListData> = {};
    const byAgent: Record<string, { t: number; min: number; cost: number }> = {};

    for (const li of Object.keys(KNOWN_LISTS)) byList[li] = makeListData(li);

    let seedCount = 0;
    if (seed && seedMaxDate) {
      const effectiveEnd = toDate <= seedMaxDate ? toDate : seedMaxDate;
      for (const t of seed.transfers) {
        if (t.date < fromDate || t.date > effectiveEnd) continue;
        mergeTransfer(byList, byAgent, t.listKey, t.phone, t.agent, t.date, t.dSec, t.cost);
        seedCount++;
      }

      // Load aggregate cost/minutes from dailyCosts (new format)
      // Sums dailyCosts entries within the requested date range
      if (seed.dailyCosts && fromDate <= seedMaxDate) {
        for (const [li, dateCosts] of Object.entries(seed.dailyCosts)) {
          if (!byList[li]) continue;
          let totalMin = 0, totalCost = 0;
          const effectiveEnd2 = toDate <= seedMaxDate ? toDate : seedMaxDate;
          for (const [date, stats] of Object.entries(dateCosts)) {
            if (date >= fromDate && date <= effectiveEnd2) {
              totalMin += stats.min;
              totalCost += stats.cost;
            }
          }
          byList[li].min = Math.round(totalMin);
          byList[li].cost = Math.round(totalCost * 100) / 100;
        }
      }
      // Fallback to old listCosts format if dailyCosts not present
      else if (seed.listCosts && fromDate <= seedMaxDate) {
        for (const [li, stats] of Object.entries(seed.listCosts)) {
          if (byList[li]) {
            byList[li].min  = stats.min;
            byList[li].cost = stats.cost;
          }
        }
      }
    }

    // ── 2. Live AIM API for dates after the seed ─────────────────────────────
    let liveCount = 0;
    let liveError: string | null = null;

    // Call live API if the requested range extends beyond the seed
    const liveNeeded = !seed || !seedMaxDate || toDate > seedMaxDate;
    if (liveNeeded) {
      // Live API covers from the day after seed cutoff (or fromDate if no seed)
      const liveFromDate = seed && seedMaxDate
        ? (new Date(new Date(seedMaxDate).getTime() + 86400000).toISOString().slice(0, 10))
        : fromDate;

      // Only call live API if the live range is within the requested range
      if (liveFromDate <= toDate) {
        try {
          const liveFromISO = new Date(liveFromDate + "T06:00:00.000Z").toISOString();
          const liveToDate  = toDate;
          const liveToISO   = (() => {
            const d = new Date(liveToDate + "T06:00:00.000Z");
            d.setDate(d.getDate() + 1);
            d.setSeconds(d.getSeconds() - 1);
            return d.toISOString();
          })();

          // Fetch transfer phones with outcome filter (outcomes[] = 89 for transferred)
          const callsResp = await aimFetch('/calls', {
            'startedAt[]': [liveFromISO, liveToISO],
            'outcomes[]': '89',
            'perPage': '500',
            'page': '1',
          });

          if (callsResp && callsResp.data) {
            const allCalls = [...(callsResp.data ?? [])];
            const totalCount: number = callsResp.count ?? 0;

            // Paginate if needed (perPage=500, max calls)
            const totalPages = Math.ceil(totalCount / 500);
            if (totalPages > 1) {
              const pagePromises = [];
              for (let p = 2; p <= totalPages; p++) {
                pagePromises.push(aimFetch('/calls', {
                  'startedAt[]': [liveFromISO, liveToISO],
                  'outcomes[]': '89',
                  'perPage': '500',
                  'page': String(p),
                }));
              }
              const remainingPages = await Promise.all(pagePromises);
              for (const page of remainingPages) {
                if (page?.data) allCalls.push(...page.data);
              }
            }

            for (const call of allCalls) {
              const campaignName = call.campaign?.name ?? "";
              const list = detectListKey(campaignName);
              if (!list || !Object.prototype.hasOwnProperty.call(KNOWN_LISTS, list)) continue;

              const phone       = (call.to ?? "").replace(/\D/g, "").slice(-10);
              const agent       = shortAgent(call.agent?.name ?? "Unknown");
              const callDate    = call.startedAt ? call.startedAt.slice(0, 10) : "unknown";
              const durationSec = call.endedAt && call.startedAt
                ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000
                : 0;
              const cost = call.price ?? 0;

              if (!phone || phone.length !== 10) continue;

              mergeTransfer(byList, byAgent, list, phone, agent, callDate, durationSec, cost);
              liveCount++;
            }
          }
        } catch (e) {
          liveError = String(e);
          console.error("[AIM route] live API error:", e);
        }
      }
    }

    // ── 3. Serialize output (same shape as before) ────────────────────────────
    const byListOut: Record<string, {
      t:            number;
      phones:       string[];
      phoneToAgent: Record<string, string>;
      min:          number;
      cost:         number;
      listCost:     number;
    }> = {};

    for (const [li, v] of Object.entries(byList)) {
      const tCount = Array.from(v.phonesByDay.values())
        .reduce((sum, daySet) => sum + daySet.size, 0);

      byListOut[li] = {
        t:            tCount,
        phones:       Array.from(v.tPhones),
        phoneToAgent: Object.fromEntries(v.phoneToAgent),
        min:          Math.round(v.min),
        cost:         Math.round(v.cost * 100) / 100,
        listCost:     v.listCost,
      };
    }

    return NextResponse.json({
      ok:          true,
      dateRange:   { from: fromDate, to: toDate },
      seedCount,
      liveCount,
      ...(liveError ? { liveError } : {}),
      byList:      byListOut,
      byAgent,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[AIM route]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
