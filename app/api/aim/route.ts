import { NextResponse } from "next/server";

const AIM_BASE = "https://dash.aimnow.ai";

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
          outcomes: [89], // 89 = transferred
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`AIM calls/list failed: ${res.status}`);
  const data = await res.json();
  return data?.json?.body ?? data?.body ?? null;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const startISO = searchParams.get("start")
      ? new Date(searchParams.get("start")! + "T06:00:00.000Z").toISOString()
      : "2026-02-25T06:00:00.000Z";
    const endISO = searchParams.get("end")
      ? (() => {
          const d = new Date(searchParams.get("end")! + "T06:00:00.000Z");
          d.setDate(d.getDate() + 1);
          d.setSeconds(d.getSeconds() - 1);
          return d.toISOString();
        })()
      : new Date().toISOString();

    const cookie    = await getSessionCookie();
    const firstPage = await fetchCallsPage(cookie, startISO, endISO, 1, 100);
    if (!firstPage) throw new Error("Empty response from AIM");

    const totalCount: number = firstPage.count ?? 0;
    const allCalls = [...(firstPage.data ?? [])];

    const totalPages = Math.min(Math.ceil(totalCount / 100), 20);
    const pagePromises = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(fetchCallsPage(cookie, startISO, endISO, p, 100));
    }
    const remainingPages = await Promise.all(pagePromises);
    for (const page of remainingPages) {
      if (page?.data) allCalls.push(...page.data);
    }

    // ── AGGREGATE ────────────────────────────────────────────────────────────
    const byList: Record<string, {
      // Per-day unique phones → sum across days = transfer count (matches manual)
      phonesByDay: Map<string, Set<string>>;
      tPhones: Set<string>;            // all-time unique phones (for cross-ref)
      phoneToAgent: Map<string, string>;
      min: number;
      cost: number;
      listCost: number;
    }> = {};

    const byAgent: Record<string, { t: number; min: number; cost: number }> = {};

    const ensure = (li: string) => {
      if (!byList[li]) byList[li] = {
        phonesByDay:  new Map(),
        tPhones:      new Set(),
        phoneToAgent: new Map(),
        min:          0,
        cost:         0,
        listCost:     KNOWN_LISTS[li] ?? 0,
      };
    };

    for (const li of Object.keys(KNOWN_LISTS)) ensure(li);

    for (const call of allCalls) {
      const campaignName = call.campaign?.name ?? "";
      const list = detectListKey(campaignName);
      if (!list || !KNOWN_LISTS.hasOwnProperty(list)) continue;

      const phone       = (call.to ?? "").replace(/\D/g, "").slice(-10);
      const agent       = shortAgent(call.agent?.name ?? "Unknown");
      const isTransfer  = call.outcomes?.some((o: { label: string }) => o.label === "transferred");
      const callDate    = call.startedAt ? call.startedAt.slice(0, 10) : "unknown";
      const durationMin = call.endedAt && call.startedAt
        ? (new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 60000
        : 0;
      const cost = call.price ?? 0;

      ensure(list);
      byList[list].min  += durationMin;
      byList[list].cost += cost;

      if (isTransfer && phone.length === 10) {
        // Track per-day unique phones for accurate transfer counting
        if (!byList[list].phonesByDay.has(callDate)) {
          byList[list].phonesByDay.set(callDate, new Set());
        }
        byList[list].phonesByDay.get(callDate)!.add(phone);

        // All-time unique phones for cross-referencing sales/opened
        byList[list].tPhones.add(phone);
        if (!byList[list].phoneToAgent.has(phone)) {
          byList[list].phoneToAgent.set(phone, agent);
        }
      }

      if (!byAgent[agent]) byAgent[agent] = { t: 0, min: 0, cost: 0 };
      byAgent[agent].min  += durationMin;
      byAgent[agent].cost += cost;
      if (isTransfer) byAgent[agent].t++;
    }

    // ── SERIALIZE ─────────────────────────────────────────────────────────────
    const byListOut: Record<string, {
      t: number;           // sum of per-day unique phone counts (matches manual)
      phones: string[];    // all-time unique phones for cross-ref
      phoneToAgent: Record<string, string>;
      min: number;
      cost: number;
      listCost: number;
    }> = {};

    for (const [li, v] of Object.entries(byList)) {
      // Sum per-day unique counts — matches manual methodology
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
      ok:                true,
      dateRange:         { start: startISO, end: endISO },
      totalCallsFetched: allCalls.length,
      byList:            byListOut,
      byAgent,
      lastUpdated:       new Date().toISOString(),
    });

  } catch (err) {
    console.error("[AIM API]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
