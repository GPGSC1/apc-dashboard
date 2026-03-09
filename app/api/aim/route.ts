import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const AIM_BASE = "https://dash.aimnow.ai";
const CAMPAIGN_START = "2026-02-25T06:00:00.000Z";

const KNOWN_LISTS: Record<string, number> = {
  RT:         0,
  JL021926LP: 8000,
  BL021926BO: 8000,
  JH022326MN: 8000,
  JL021926CR: 8000,
  DG021726SC: 5000,
  JL022526RS: 6000,
};

const detectListKey = (text: string): string | null => {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const match10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (match10) return (match10[1] + match10[2] + match10[3]).toUpperCase();
  const match8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (match8) return (match8[1] + match8[2]).toUpperCase();
  return null;
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
const shortAgent = (name: string) => AGENT_SHORT[name] || name;

// ── KV CACHED CALL RECORD ─────────────────────────────────────────────────────
interface CachedCall {
  id: string;
  campaignName: string;
  phone: string;
  agent: string;
  date: string;       // YYYY-MM-DD
  startedAt: string;  // ISO
  min: number;
  cost: number;
  isTransfer: boolean;
}

// ── REDIS CLIENT ──────────────────────────────────────────────────────────────
function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const KV_CALLS_KEY      = "aim:calls";
const KV_LAST_PULL_KEY  = "aim:lastPulled";

async function loadCachedCalls(redis: Redis): Promise<Map<string, CachedCall>> {
  try {
    const raw = await redis.get<CachedCall[]>(KV_CALLS_KEY);
    if (!raw || !Array.isArray(raw)) return new Map();
    return new Map(raw.map(c => [c.id, c]));
  } catch {
    return new Map();
  }
}

async function saveCachedCalls(redis: Redis, calls: Map<string, CachedCall>): Promise<void> {
  try {
    await redis.set(KV_CALLS_KEY, Array.from(calls.values()));
    await redis.set(KV_LAST_PULL_KEY, new Date().toISOString());
  } catch (e) {
    console.error("[AIM KV] save failed:", e);
  }
}

// ── AIM AUTH ──────────────────────────────────────────────────────────────────
async function getSessionCookie(): Promise<string> {
  const email    = process.env.AIM_EMAIL;
  const password = process.env.AIM_PASSWORD;
  if (!email || !password) throw new Error("AIM_EMAIL or AIM_PASSWORD not set");

  const res = await fetch(`${AIM_BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true, callbackURL: "/" }),
  });
  if (!res.ok) throw new Error(`AIM login failed: ${res.status}`);

  const setCookie  = res.headers.get("set-cookie") || "";
  const tokenMatch = setCookie.match(/__Secure-better-auth\.session_token=([^;]+)/);
  if (!tokenMatch) throw new Error("No session token in login response");
  return `__Secure-better-auth.session_token=${tokenMatch[1]}`;
}

async function fetchCallsPage(
  cookie: string, startISO: string, endISO: string, page: number, perPage = 100
) {
  const res = await fetch(`${AIM_BASE}/rpc/calls/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      json: {
        query: {
          page, perPage,
          startedAt: [startISO, endISO],
          outcomes: [89],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`AIM calls/list failed: ${res.status}`);
  const data = await res.json();
  return data?.json?.body ?? data?.body ?? null;
}

async function fetchAllNewCalls(
  cookie: string, sinceISO: string, endISO: string
): Promise<CachedCall[]> {
  const firstPage = await fetchCallsPage(cookie, sinceISO, endISO, 1, 100);
  if (!firstPage) return [];

  const totalCount: number = firstPage.count ?? 0;
  const rawCalls = [...(firstPage.data ?? [])];

  // Fetch remaining pages (no cap — fetch ALL new calls)
  const totalPages = Math.ceil(totalCount / 100);
  const pagePromises = [];
  for (let p = 2; p <= totalPages; p++) {
    pagePromises.push(fetchCallsPage(cookie, sinceISO, endISO, p, 100));
  }
  const remainingPages = await Promise.all(pagePromises);
  for (const page of remainingPages) {
    if (page?.data) rawCalls.push(...page.data);
  }

  // Convert to minimal CachedCall records
  return rawCalls
    .filter(call => call.id)
    .map(call => ({
      id:           String(call.id),
      campaignName: call.campaign?.name ?? "",
      phone:        (call.to ?? "").replace(/\D/g, "").slice(-10),
      agent:        shortAgent(call.agent?.name ?? "Unknown"),
      date:         call.startedAt ? call.startedAt.slice(0, 10) : "unknown",
      startedAt:    call.startedAt ?? "",
      min:          call.endedAt && call.startedAt
        ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 60000
        : 0,
      cost:         call.price ?? 0,
      isTransfer:   call.outcomes?.some((o: { label: string }) => o.label === "transferred") ?? false,
    }));
}

// ── AGGREGATE CALLS → byList / byAgent ───────────────────────────────────────
function aggregateCalls(calls: CachedCall[], fromDate: string, toDate: string) {
  const byList: Record<string, {
    phonesByDay:  Map<string, Set<string>>;
    tPhones:      Set<string>;
    phoneToAgent: Map<string, string>;
    min:  number;
    cost: number;
    listCost: number;
  }> = {};

  const byAgent: Record<string, { t: number; min: number; cost: number }> = {};

  const ensure = (li: string) => {
    if (!byList[li]) byList[li] = {
      phonesByDay:  new Map(),
      tPhones:      new Set(),
      phoneToAgent: new Map(),
      min:      0,
      cost:     0,
      listCost: KNOWN_LISTS[li] ?? 0,
    };
  };
  for (const li of Object.keys(KNOWN_LISTS)) ensure(li);

  for (const call of calls) {
    // Filter to requested date range
    if (call.date < fromDate || call.date > toDate) continue;

    const list = detectListKey(call.campaignName);
    if (!list || !Object.prototype.hasOwnProperty.call(KNOWN_LISTS, list)) continue;

    ensure(list);
    byList[list].min  += call.min;
    byList[list].cost += call.cost;

    if (call.isTransfer && call.phone.length === 10) {
      if (!byList[list].phonesByDay.has(call.date)) {
        byList[list].phonesByDay.set(call.date, new Set());
      }
      byList[list].phonesByDay.get(call.date)!.add(call.phone);
      byList[list].tPhones.add(call.phone);
      if (!byList[list].phoneToAgent.has(call.phone)) {
        byList[list].phoneToAgent.set(call.phone, call.agent);
      }
    }

    if (!byAgent[call.agent]) byAgent[call.agent] = { t: 0, min: 0, cost: 0 };
    byAgent[call.agent].min  += call.min;
    byAgent[call.agent].cost += call.cost;
    if (call.isTransfer) byAgent[call.agent].t++;
  }

  // Serialize
  const byListOut: Record<string, {
    t: number; phones: string[]; phoneToAgent: Record<string, string>;
    min: number; cost: number; listCost: number;
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

  const byAgentOut: Record<string, { t: number; min: number; cost: number }> = {};
  for (const [agent, stats] of Object.entries(byAgent)) {
    byAgentOut[agent] = {
      t:    stats.t,
      min:  Math.round(stats.min * 100) / 100,
      cost: Math.round(stats.cost * 100) / 100,
    };
  }

  return { byList: byListOut, byAgent: byAgentOut };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const fromDate = searchParams.get("start") ?? "2026-02-25";
    const toDate   = searchParams.get("end")   ?? new Date().toISOString().slice(0, 10);

    const redis = getRedis();

    // ── WITH KV: incremental pull ─────────────────────────────────────────────
    if (redis) {
      const cachedCalls = await loadCachedCalls(redis);

      // Determine pull window: from latest cached call or campaign start
      let sinceISO = CAMPAIGN_START;
      if (cachedCalls.size > 0) {
        const latestDate = Array.from(cachedCalls.values())
          .map(c => c.startedAt)
          .filter(Boolean)
          .sort()
          .pop();
        if (latestDate) sinceISO = latestDate;
      }

      const nowISO = new Date().toISOString();

      // Only pull if there's a gap to fill
      if (sinceISO < nowISO) {
        try {
          const cookie   = await getSessionCookie();
          const newCalls = await fetchAllNewCalls(cookie, sinceISO, nowISO);

          // Merge new calls into cache (deduplicate by id)
          for (const call of newCalls) {
            cachedCalls.set(call.id, call);
          }

          await saveCachedCalls(redis, cachedCalls);
        } catch (e) {
          console.error("[AIM KV] incremental pull failed:", e);
          // Continue with cached data
        }
      }

      const allCalls = Array.from(cachedCalls.values());
      const { byList, byAgent } = aggregateCalls(allCalls, fromDate, toDate);

      return NextResponse.json({
        ok:                true,
        source:            "kv-cache",
        cachedCallCount:   cachedCalls.size,
        dateRange:         { start: fromDate, end: toDate },
        byList,
        byAgent,
        lastUpdated:       new Date().toISOString(),
      });
    }

    // ── WITHOUT KV: fallback to direct API (old behavior, capped at 2000) ────
    const startISO = new Date(fromDate + "T06:00:00.000Z").toISOString();
    const endISO   = (() => {
      const d = new Date(toDate + "T06:00:00.000Z");
      d.setDate(d.getDate() + 1);
      d.setSeconds(d.getSeconds() - 1);
      return d.toISOString();
    })();

    const cookie    = await getSessionCookie();
    const firstPage = await fetchCallsPage(cookie, startISO, endISO, 1, 100);
    if (!firstPage) throw new Error("Empty response from AIM");

    const totalCount: number = firstPage.count ?? 0;
    const rawCalls = [...(firstPage.data ?? [])];
    const totalPages = Math.min(Math.ceil(totalCount / 100), 20);
    const pagePromises = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(fetchCallsPage(cookie, startISO, endISO, p, 100));
    }
    const remainingPages = await Promise.all(pagePromises);
    for (const page of remainingPages) {
      if (page?.data) rawCalls.push(...page.data);
    }

    const minimalCalls: CachedCall[] = rawCalls
      .filter(call => call.id)
      .map(call => ({
        id:           String(call.id),
        campaignName: call.campaign?.name ?? "",
        phone:        (call.to ?? "").replace(/\D/g, "").slice(-10),
        agent:        shortAgent(call.agent?.name ?? "Unknown"),
        date:         call.startedAt ? call.startedAt.slice(0, 10) : "unknown",
        startedAt:    call.startedAt ?? "",
        min:          call.endedAt && call.startedAt
          ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 60000
          : 0,
        cost:         call.price ?? 0,
        isTransfer:   call.outcomes?.some((o: { label: string }) => o.label === "transferred") ?? false,
      }));

    const { byList, byAgent } = aggregateCalls(minimalCalls, fromDate, toDate);

    return NextResponse.json({
      ok:                true,
      source:            "direct-api",
      totalCallsFetched: rawCalls.length,
      dateRange:         { start: fromDate, end: toDate },
      byList,
      byAgent,
      lastUpdated:       new Date().toISOString(),
    });

  } catch (err) {
    console.error("[AIM API]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
