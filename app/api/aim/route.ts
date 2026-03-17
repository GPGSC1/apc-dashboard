import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const AIM_BASE       = "https://dash.aimnow.ai";
const CAMPAIGN_START = "2026-02-25";

const KNOWN_LISTS: Record<string, number> = {
  RT: 0, JL021926LP: 8000, BL021926BO: 8000,
  JH022326MN: 8000, JL021926CR: 8000, DG021726SC: 5000, JL022526RS: 6000,
};

const detectListKey = (text: string): string | null => {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const m10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (m10) return (m10[1] + m10[2] + m10[3]).toUpperCase();
  const m8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (m8) return (m8[1] + m8[2]).toUpperCase();
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
const shortAgent = (n: string) => AGENT_SHORT[n] || n;

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

type DayStats = Record<string, { min: number; cost: number }>;
type DailyAIM = Record<string, DayStats>;

// Load only the days needed for the requested date range
async function loadDailyRange(redis: Redis, fromDate: string, toDate: string): Promise<DailyAIM> {
  try {
    const dayIndex = await redis.get<string[]>("aim:dayindex");
    if (!dayIndex) return {};

    const daysInRange = dayIndex.filter(d => d >= fromDate && d <= toDate);
    if (daysInRange.length === 0) return {};

    const results = await Promise.all(
      daysInRange.map(d => redis.get<DayStats>(`aim:day:${d}`))
    );

    const daily: DailyAIM = {};
    daysInRange.forEach((d, i) => {
      if (results[i]) daily[d] = results[i]!;
    });
    return daily;
  } catch { return {}; }
}

// Load all days (for incremental merge)
async function loadAllDaily(redis: Redis): Promise<DailyAIM> {
  try {
    const dayIndex = await redis.get<string[]>("aim:dayindex");
    if (!dayIndex || dayIndex.length === 0) return {};

    const results = await Promise.all(
      dayIndex.map(d => redis.get<DayStats>(`aim:day:${d}`))
    );

    const daily: DailyAIM = {};
    dayIndex.forEach((d, i) => {
      if (results[i]) daily[d] = results[i]!;
    });
    return daily;
  } catch { return {}; }
}

// Save only the days that were modified
async function saveChangedDays(redis: Redis, changedDays: DailyAIM, lastPulled: string) {
  try {
    // Get existing day index
    const existing = await redis.get<string[]>("aim:dayindex") ?? [];
    const existingSet = new Set(existing);
    const newDays = Object.keys(changedDays).filter(d => !existingSet.has(d));

    // Write each changed day as its own key
    await Promise.all(
      Object.entries(changedDays).map(([date, stats]) =>
        redis.set(`aim:day:${date}`, stats)
      )
    );

    // Update day index if new days were added
    if (newDays.length > 0) {
      const allDays = [...existing, ...newDays].sort();
      await redis.set("aim:dayindex", allDays);
    }

    await redis.set("aim:lastPulled", lastPulled);
  } catch (e) { console.error("[AIM KV] save failed:", e); }
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
  if (!tokenMatch) throw new Error("No session token in AIM login response");
  return `__Secure-better-auth.session_token=${tokenMatch[1]}`;
}

async function fetchPage(cookie: string, startISO: string, endISO: string, page: number) {
  const res = await fetch(`${AIM_BASE}/rpc/calls/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ json: { query: { page, perPage: 100, startedAt: [startISO, endISO], outcomes: [89] } } }),
  });
  if (!res.ok) throw new Error(`AIM calls/list failed: ${res.status}`);
  const data = await res.json();
  return data?.json?.body ?? data?.body ?? null;
}

// ── MERGE NEW CALLS INTO DAILY ────────────────────────────────────────────────
function mergeCalls(
  daily: DailyAIM,
  changedDays: DailyAIM,
  calls: { campaignName: string; date: string; min: number; cost: number }[]
) {
  for (const call of calls) {
    const list = detectListKey(call.campaignName);
    if (!list || !Object.prototype.hasOwnProperty.call(KNOWN_LISTS, list)) continue;
    if (!daily[call.date])          daily[call.date]          = {};
    if (!daily[call.date][list])    daily[call.date][list]    = { min: 0, cost: 0 };
    if (!changedDays[call.date])    changedDays[call.date]    = daily[call.date];
    daily[call.date][list].min  += call.min;
    daily[call.date][list].cost += call.cost;
  }
}

// ── AGGREGATE DAILY → byList for date range ───────────────────────────────────
function aggregateRange(daily: DailyAIM, fromDate: string, toDate: string) {
  const byList: Record<string, { min: number; cost: number; listCost: number }> = {};
  for (const li of Object.keys(KNOWN_LISTS)) {
    byList[li] = { min: 0, cost: 0, listCost: KNOWN_LISTS[li] };
  }
  for (const [date, lists] of Object.entries(daily)) {
    if (date < fromDate || date > toDate) continue;
    for (const [li, stats] of Object.entries(lists)) {
      if (!byList[li]) byList[li] = { min: 0, cost: 0, listCost: KNOWN_LISTS[li] ?? 0 };
      byList[li].min  += stats.min;
      byList[li].cost += stats.cost;
    }
  }
  for (const v of Object.values(byList)) {
    v.min  = Math.round(v.min);
    v.cost = Math.round(v.cost * 100) / 100;
  }
  return byList;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const fromDate = searchParams.get("start") ?? CAMPAIGN_START;
    const toDate   = searchParams.get("end")   ?? new Date().toISOString().slice(0, 10);

    const redis = getRedis();
    if (!redis) {
      return NextResponse.json({ ok: false, error: "KV not configured" }, { status: 500 });
    }

    // Determine pull window
    let lastPulled: string | null = null;
    try { lastPulled = await redis.get<string>("aim:lastPulled"); } catch {}
    const sinceDate = lastPulled
      ? new Date(lastPulled).toISOString().slice(0, 10)
      : CAMPAIGN_START;
    const nowISO   = new Date().toISOString();
    const sinceISO = new Date(sinceDate + "T06:00:00.000Z").toISOString();

    // Incremental pull from AIM — only load all days if we have new data to merge
    try {
      const cookie    = await getSessionCookie();
      const firstPage = await fetchPage(cookie, sinceISO, nowISO, 1);
      if (firstPage && (firstPage.count ?? 0) > 0) {
        const totalPages = Math.ceil((firstPage.count ?? 0) / 100);
        const allRaw = [...(firstPage.data ?? [])];
        const pagePromises = [];
        for (let p = 2; p <= totalPages; p++) pagePromises.push(fetchPage(cookie, sinceISO, nowISO, p));
        const rest = await Promise.all(pagePromises);
        for (const pg of rest) { if (pg?.data) allRaw.push(...pg.data); }

        const newCalls = allRaw.map((call: Record<string, unknown>) => ({
          campaignName: (call.campaign as { name?: string })?.name ?? "",
          date:         (call.startedAt as string)?.slice(0, 10) ?? "unknown",
          min:          call.endedAt && call.startedAt
            ? (new Date(call.endedAt as string).getTime() - new Date(call.startedAt as string).getTime()) / 60000
            : 0,
          cost:         (call.price as number) ?? 0,
          agent:        shortAgent((call.agent as { name?: string })?.name ?? "Unknown"),
        }));

        // Load all existing days for merge, track which ones change
        const daily       = await loadAllDaily(redis);
        const changedDays: DailyAIM = {};
        mergeCalls(daily, changedDays, newCalls);
        if (Object.keys(changedDays).length > 0) {
          await saveChangedDays(redis, changedDays, nowISO);
        }

        // Aggregate from merged data
        const byList = aggregateRange(daily, fromDate, toDate);
        return NextResponse.json({
          ok: true, source: "kv+live", dateRange: { start: fromDate, end: toDate },
          byList, lastUpdated: nowISO,
        });
      }
    } catch (e) {
      console.error("[AIM] incremental pull failed:", e);
    }

    // No new data — read only the days needed for the date range
    const daily  = await loadDailyRange(redis, fromDate, toDate);
    const byList = aggregateRange(daily, fromDate, toDate);

    return NextResponse.json({
      ok: true, source: "kv", dateRange: { start: fromDate, end: toDate },
      byList, lastUpdated: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[AIM route]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
