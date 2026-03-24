import { getWbSession, setWbSession } from "./kv-schema";
import { WallboardSnapshot } from "./types";

// ─── Queue filter IDs (discovered from WallboardService.svc/GetWallboardFilters)
const QUEUE_FILTERS: Record<string, string> = {
  CS: "628",          // Q: CS (queue 8004)
  Collections: "623", // Q: Collections (queue 8005)
  Home1: "640",       // Q: Home 1 (queue 8006)
  Home2: "642",       // Q: Home 2 (queue 8022)
  Home3: "644",       // Q: Home 3 (queue 8039)
  Home4: "648",       // Q: Home 4 (queue 8045)
  Home5: "650",       // Q: Home 5 (queue 8048)
  CB: "633",          // Q: CB (queue 8001)
  Mail1: "626",       // Q: Mail 1 (queue 8023)
  Mail2: "638",       // Q: Mail 2
  Mail3: "639",       // Q: Mail 3
  Mail4: "647",       // Q: Mail 4 (queue 8043)
  Mail5: "649",       // Q: Mail 5
  Mail6: "652",       // Q: Mail 6
};

const BASE_URL = "https://gpgsc.innicom.com";
const WB_APP = "/app0422";

// ─── ASP.NET form auth helpers ──────────────────────────────────────────────

function extractField(html: string, field: string): string {
  const m =
    html.match(new RegExp(`id="${field}"[^>]*value="([^"]*)"`, "i")) ??
    html.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

interface FetchResult {
  status: number;
  body: string;
  cookies: string[];
  location: string | null;
}

async function httpReq(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    cookies?: string[];
    redirect?: "follow" | "manual";
  } = {}
): Promise<FetchResult> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookies?.length) {
    headers["Cookie"] = opts.cookies.join("; ");
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
    redirect: opts.redirect ?? "manual",
  });

  const body = await res.text();
  // getSetCookie() may not work on all runtimes — fallback to raw header parsing
  let setCookies: string[] = [];
  if (typeof res.headers.getSetCookie === "function") {
    setCookies = res.headers.getSetCookie();
  }
  if (setCookies.length === 0) {
    // Fallback: parse from raw headers
    const raw = res.headers.get("set-cookie");
    if (raw) {
      // Multiple set-cookie values may be comma-separated (but cookie values can contain commas)
      // Split on patterns like ", name=" to handle this
      setCookies = raw.split(/,\s*(?=[A-Za-z_.]+=)/).filter(Boolean);
    }
  }
  const cookies = setCookies.map((c) => c.split(";")[0]);
  const location = res.headers.get("location");

  return { status: res.status, body, cookies, location };
}

// ─── Login to 3CX wallboard ────────────────────────────────────────────────

async function login(): Promise<string[]> {
  const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
  const username = process.env.TCX_USERNAME ?? "1911";
  const password = process.env.TCX_PASSWORD ?? "";

  // Step 1: GET login page to extract ASP.NET tokens
  const loginPageUrl = `https://${domain}${WB_APP}/Wallboard.aspx`;
  const r1 = await httpReq(loginPageUrl, { redirect: "manual" });

  // Follow redirect to login page
  const loginUrl = r1.location?.startsWith("http")
    ? r1.location
    : `https://${domain}${r1.location}`;
  const allCookies = [...r1.cookies];

  const r2 = await httpReq(loginUrl, { cookies: allCookies });
  allCookies.push(...r2.cookies);

  const viewState = extractField(r2.body, "__VIEWSTATE");
  const viewStateGen = extractField(r2.body, "__VIEWSTATEGENERATOR");
  const eventVal = extractField(r2.body, "__EVENTVALIDATION");

  if (!viewState) throw new Error(`3CX wallboard: could not extract ViewState from ${loginUrl} (status=${r2.status}, bodyLen=${r2.body.length}, cookies=${allCookies.length})`);

  // Step 2: POST credentials
  const formData = new URLSearchParams({
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGen,
    __EVENTVALIDATION: eventVal,
    txtUsername: username,
    txtPassword: password,
    "x": "28",
    "y": "8",
  });

  const r3 = await httpReq(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
    cookies: allCookies,
    redirect: "manual",
  });
  allCookies.push(...r3.cookies);

  // Verify we got auth cookie
  const hasAuth = allCookies.some((c) => c.includes(".ASPXAUTH"));
  console.log(`[Wallboard login] POST status=${r3.status}, location=${r3.location}, cookies=${allCookies.length}, hasAuth=${hasAuth}, cookieNames=${allCookies.map(c=>c.split('=')[0]).join(',')}`);
  if (!hasAuth) throw new Error(`3CX wallboard: login failed — no auth cookie. Status=${r3.status}, location=${r3.location}, r3cookies=${r3.cookies.length}, allCookies=${allCookies.length}, names=${allCookies.map(c=>c.split('=')[0]).join(',')}`);

  // Follow redirect to establish session
  if (r3.location) {
    const wbUrl = r3.location.startsWith("http")
      ? r3.location
      : `https://${domain}${r3.location}`;
    await httpReq(wbUrl, { cookies: allCookies });
  }

  return allCookies;
}

// ─── Get authenticated cookies (cached in KV) ──────────────────────────────

async function getAuthCookies(): Promise<string[]> {
  // Try cached session first
  const cached = await getWbSession();
  if (cached) return JSON.parse(cached);

  // Login fresh
  const cookies = await login();
  await setWbSession(JSON.stringify(cookies));
  return cookies;
}

// ─── Poll a single queue ────────────────────────────────────────────────────

async function pollQueue(
  cookies: string[],
  filterName: string,
  filterId: string
): Promise<{ name: string; waiting: number }> {
  const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
  const ts = Date.now();
  const url =
    `https://${domain}${WB_APP}/WallboardService.svc/GetWallboardData` +
    `?ts=${ts}&Filter=${filterId}&SortField=&SortAorD=`;

  const res = await httpReq(url, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
    },
    cookies,
  });

  if (res.status === 302 || res.body.includes("LoginPage")) {
    // Session expired — clear cache so next tick re-authenticates
    await setWbSession("");
    return { name: filterName, waiting: 0 };
  }

  try {
    const data = JSON.parse(res.body);
    const waiting = data?.d?.Waiting ?? 0;
    return { name: filterName, waiting };
  } catch {
    return { name: filterName, waiting: 0 };
  }
}

// ─── Poll Centerwide (all queues combined) ──────────────────────────────────

async function pollCenterwide(
  cookies: string[]
): Promise<{ waiting: number; callsWaiting: any[] }> {
  const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
  const ts = Date.now();
  // Empty filter = Centerwide view
  const url =
    `https://${domain}${WB_APP}/WallboardService.svc/GetWallboardData` +
    `?ts=${ts}&Filter=&SortField=&SortAorD=`;

  const res = await httpReq(url, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
    },
    cookies,
  });

  if (res.status === 302 || res.body.includes("LoginPage") || res.body.includes("txtUsername")) {
    await setWbSession("");
    return { waiting: 0, callsWaiting: [] };
  }

  try {
    const data = JSON.parse(res.body);
    return {
      waiting: data?.d?.Waiting ?? 0,
      callsWaiting: data?.d?.CallsWaiting ?? [],
    };
  } catch {
    // Non-JSON response = probably login page
    await setWbSession("");
    return { waiting: 0, callsWaiting: [] };
  }
}

// ─── Poll all queues in parallel ────────────────────────────────────────────

async function doPoll(cookies: string[]): Promise<{ centerwide: { waiting: number; callsWaiting: any[] }; queueResults: { name: string; waiting: number }[]; authFailed: boolean }> {
  const queueEntries = Object.entries(QUEUE_FILTERS);
  const [centerwide, ...queueResults] = await Promise.all([
    pollCenterwide(cookies),
    ...queueEntries.map(([name, id]) => pollQueue(cookies, name, id)),
  ]);
  // Detect auth failure: if centerwide returns 0 AND all queues return 0,
  // AND we got redirected to login (pollQueue sets waiting=0 on redirect)
  // We need a better signal — check if the session was cleared by pollQueue
  const sessionCleared = !(await getWbSession());
  return { centerwide, queueResults, authFailed: sessionCleared };
}

export async function pollAllQueues(): Promise<WallboardSnapshot> {
  let cookies = await getAuthCookies();

  let { centerwide, queueResults, authFailed } = await doPoll(cookies);

  // If auth failed (session was cleared by a poll detecting redirect), retry with fresh login
  if (authFailed) {
    console.log("[Wallboard] Auth failed, retrying with fresh login...");
    await setWbSession(""); // clear stale session
    cookies = await login();
    await setWbSession(JSON.stringify(cookies));
    const retry = await doPoll(cookies);
    centerwide = retry.centerwide;
    queueResults = retry.queueResults;
  }

  const byQueue: Record<string, number> = {};
  for (const q of queueResults) {
    byQueue[q.name] = q.waiting;
  }

  return {
    totalWaiting: centerwide.waiting,
    byQueue,
    timestamp: new Date().toISOString(),
  };
}
