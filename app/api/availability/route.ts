import { NextResponse } from "next/server";
import https from "https";

export const maxDuration = 30;

/* ── helpers ────────────────────────────────────────────────────────────────── */

function httpsGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        headers: { Accept: "text/html,application/xhtml+xml,*/*", ...headers },
        rejectUnauthorized: false,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: d,
            headers: res.headers as Record<string, string | string[] | undefined>,
          })
        );
      }
    );
    req.on("error", reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<{ body: string; rawSetCookie: string; status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          // Concatenate all set-cookie headers into one raw string
          const scArr = res.headers["set-cookie"] ?? [];
          const rawSetCookie = Array.isArray(scArr) ? scArr.join(", ") : String(scArr);
          resolve({ body: data, rawSetCookie, status: res.statusCode ?? 0 });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

function extractField(html: string, field: string): string {
  const m =
    html.match(new RegExp(`id="${field}"[^>]*value="([^"]*)"`, "i")) ??
    html.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`, "i"));
  return m?.[1] ?? "";
}

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "",
    inQ = false;
  for (const ch of line) {
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === "," && !inQ) {
      cols.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

/* ── 3CX login ──────────────────────────────────────────────────────────────── */

async function login3cx(domain: string, username: string, password: string): Promise<string> {
  // Step 1: GET login page for form tokens
  const loginPageResp = await httpsGet(`https://${domain}/LoginPage.aspx`);
  const html = loginPageResp.body;

  const viewState = extractField(html, "__VIEWSTATE");
  const viewStateGen = extractField(html, "__VIEWSTATEGENERATOR");
  const eventVal = extractField(html, "__EVENTVALIDATION");

  if (!viewState) throw new Error("Could not extract __VIEWSTATE from 3CX login page");

  // Step 2: POST login credentials
  const loginBody = new URLSearchParams({
    __VIEWSTATE: viewState,
    __VIEWSTATEGENERATOR: viewStateGen,
    __EVENTVALIDATION: eventVal,
    txtUsername: username,
    txtPassword: password,
    x: "28",
    y: "8",
  }).toString();

  const postResp = await httpsPost(`https://${domain}/LoginPage.aspx`, loginBody, {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "text/html",
  });

  // Step 3: Parse cookies from raw set-cookie header
  const rawSC = postResp.rawSetCookie;
  const cookieJar: Record<string, string> = {};
  for (const name of ["UserName", "E764D", "SG_ID", ".ASPXAUTH"]) {
    const idx = rawSC.indexOf(name + "=");
    if (idx >= 0) cookieJar[name] = rawSC.slice(idx).split(";")[0];
  }

  const allCookies = Object.values(cookieJar).join("; ");

  if (!allCookies.includes(".ASPXAUTH")) {
    throw new Error("3CX login failed - no .ASPXAUTH cookie received");
  }

  return allCookies;
}

/* ── report fetching ────────────────────────────────────────────────────────── */

function buildReportUrl(domain: string, rdId: string, startMm: string, startDd: string, startYyyy: string, endMm?: string, endDd?: string, endYyyy?: string): string {
  const d2mm = endMm ?? startMm;
  const d2dd = endDd ?? startDd;
  const d2yyyy = endYyyy ?? startYyyy;
  return (
    `https://${domain}/app0422/RunReportDefinitionToFile.ashx` +
    `?Output=Excel&U_ID=19978&RD_ID=${rdId}` +
    `&Criteria=Date1%3D${startMm}%2F${startDd}%2F${startYyyy}%7C%7C%7C` +
    `Date2%3D${d2mm}%2F${d2dd}%2F${d2yyyy}%7C%7C%7C` +
    `Extensions%3D%7C%7C%7CQueues%3D%7C%7C%7C` +
    `SortColumn%3D%7C%7C%7CSortAorD%3DASC`
  );
}

const AGENT_DETAIL_RD = "4f5337fb-881e-414f-b5fd-2eee3c1c94c2";
const RONA_RD = "c75845c4-9822-4e4d-ac5b-36f656b54725";

/* ── types ──────────────────────────────────────────────────────────────────── */

interface AgentAvailability {
  extension: string;
  name: string;
  inboundCalls: number;
  inboundTalkTime: number;
  outboundCalls: number;
  outboundTalkTime: number;
  internalCalls: number;
  skippedCalls: number;
  breakTime: number;
  lunchTime: number;
  availableTime: number;
  loggedOutTime: number;
  totalLoginTime: number;
  activityTime: number;
  occupancy: number;
  ronaCount: number;
}

/* ── CSV parsing ────────────────────────────────────────────────────────────── */

function parseAgentDetailCsv(csv: string): AgentAvailability[] {
  const lines = csv.split(/\r?\n/);
  // Find header row (usually row 3, but search for "Extension")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].toLowerCase().includes("extension") && lines[i].toLowerCase().includes("name")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) headerIdx = 2; // fallback to row 3 (0-indexed = 2)

  const headers = parseCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase());

  // Map header names to indices
  const col = (name: string) => {
    const idx = headers.indexOf(name.toLowerCase());
    return idx;
  };

  const agents: AgentAvailability[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const ext = (cols[col("extension")] ?? "").trim();
    const name = (cols[col("name")] ?? "").trim();
    if (!ext || !name) continue;
    // Skip totals/summary rows
    if (name.toLowerCase() === "total" || name.toLowerCase() === "totals") continue;

    const num = (idx: number) => {
      const v = parseFloat((cols[idx] ?? "0").replace(/,/g, ""));
      return isNaN(v) ? 0 : v;
    };

    const occStr = (cols[col("occupancy")] ?? "0").replace(/%/g, "").trim();
    const occVal = parseFloat(occStr);

    agents.push({
      extension: ext,
      name,
      inboundCalls: num(col("inbound calls")),
      inboundTalkTime: num(col("inbound talk time")),
      outboundCalls: num(col("outbound calls")),
      outboundTalkTime: num(col("outbound talk time")),
      internalCalls: num(col("internal calls")),
      skippedCalls: num(col("skipped calls")),
      breakTime: num(col("break")),
      lunchTime: num(col("lunch")),
      availableTime: num(col("inbound")),
      loggedOutTime: num(col("logged out")),
      totalLoginTime: num(col("total login time")),
      activityTime: num(col("activity time")),
      occupancy: isNaN(occVal) ? 0 : occVal,
      ronaCount: 0, // filled from RONA report
    });
  }

  return agents;
}

function parseRonaCsv(csv: string): { byExt: Record<string, number>; byName: Record<string, number> } {
  // Returns RONA counts keyed by both extension number and extension name
  const lines = csv.split(/\r?\n/);
  // Find the REAL header row — must contain BOTH "callid" and "extension"
  // (the CSV has a fake header row with just "CallID,,,,,,,," before the real one)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes("callid") && lower.includes("extension")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) headerIdx = 3; // fallback to row 4

  const headers = parseCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase());
  const extNumCol = headers.indexOf("extension number");
  const extNameCol = headers.indexOf("extension name");

  const byExt: Record<string, number> = {};
  const byName: Record<string, number> = {};

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);

    if (extNumCol >= 0) {
      const ext = (cols[extNumCol] ?? "").trim();
      if (ext) byExt[ext] = (byExt[ext] || 0) + 1;
    }
    if (extNameCol >= 0) {
      const name = (cols[extNameCol] ?? "").trim();
      if (name) byName[name] = (byName[name] || 0) + 1;
    }
  }

  return { byExt, byName };
}


/* ── GET handler ────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    // Default to today in Central Time
    const now = new Date();
    const ctStr = now.toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
    const [ctM, ctD, ctY] = ctStr.split("/");
    const todayISO = `${ctY}-${ctM}-${ctD}`;

    // Support date range: ?start=YYYY-MM-DD&end=YYYY-MM-DD (or legacy ?date=)
    const startParam = searchParams.get("start") || searchParams.get("date") || todayISO;
    const endParam = searchParams.get("end") || startParam;
    const [sYyyy, sMm, sDd] = startParam.split("-");
    const [eYyyy, eMm, eDd] = endParam.split("-");

    const domain = process.env.TCX_DOMAIN || "gpgsc.innicom.com";
    const username = process.env.TCX_USERNAME || "1911";
    const password = process.env.TCX_PASSWORD || "Gu@rdi@n2025";

    // Authenticate
    const cookies = await login3cx(domain, username, password);

    // Fetch both reports in parallel with date range
    const agentDetailUrl = buildReportUrl(domain, AGENT_DETAIL_RD, sMm, sDd, sYyyy, eMm, eDd, eYyyy);
    const ronaUrl = buildReportUrl(domain, RONA_RD, sMm, sDd, sYyyy, eMm, eDd, eYyyy);

    const [agentResp, ronaResp] = await Promise.all([
      httpsGet(agentDetailUrl, { Cookie: cookies }),
      httpsGet(ronaUrl, { Cookie: cookies }),
    ]);

    // Parse Agent Detail
    const agents = parseAgentDetailCsv(agentResp.body);

    // Parse RONA report — match by extension number first, fall back to name
    const { byExt: ronaByExt, byName: ronaByName } = parseRonaCsv(ronaResp.body);

    for (const agent of agents) {
      agent.ronaCount = ronaByExt[agent.extension] || ronaByName[agent.name] || 0;
    }

    // Compute summary
    const loggedIn = agents.filter((a) => a.totalLoginTime > 0);
    const onBreak = agents.filter((a) => a.breakTime > 0 || a.lunchTime > 0);
    const avgOccupancy =
      loggedIn.length > 0
        ? loggedIn.reduce((s, a) => s + a.occupancy, 0) / loggedIn.length
        : 0;
    const totalRona = agents.reduce((s, a) => s + a.ronaCount, 0);

    return NextResponse.json({
      dateRange: { start: startParam, end: endParam },
      agents,
      summary: {
        totalAgents: agents.length,
        loggedIn: loggedIn.length,
        onBreak: onBreak.length,
        avgOccupancy: Math.round(avgOccupancy * 10) / 10,
        totalRona,
      },
    });
  } catch (err) {
    console.error("[availability] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
