/**
 * Fetch today's 3CX calls directly via the 3CX report API.
 * This avoids spawning the /api/calls serverless function which loads the 12MB tcx_seed.json.
 */
import https from "https";

interface LiveCall {
  phoneNumber: string;
  queueName: string;
  startTime: string;
  destName: string;
  status: string;
  talkTimeSec: number;
  opened: boolean;
}

// ─── HTTPS helpers (3CX uses self-signed certs) ────────────────────────────

function httpsGet(url: string, extraHeaders?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml,*/*",
      ...(extraHeaders ?? {}),
    };
    const req = https.get(url, { headers, rejectUnauthorized: false }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location ?? "";
        return resolve(httpsGet(loc.startsWith("http") ? loc : new URL(loc, url).href, extraHeaders));
      }
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<{ body: string; cookies: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          const cookies = (res.headers["set-cookie"] ?? [])
            .map((c) => c.split(";")[0])
            .join("; ");
          resolve({ body: data, cookies });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

function extractViewState(html: string, field: string): string {
  const m =
    html.match(new RegExp(`id="${field}"[^>]*value="([^"]*)"`, "i")) ??
    html.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`, "i"));
  return m?.[1] ?? "";
}

function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

const SALES_QUEUES = ["mail 1", "mail 2", "mail 3", "mail 4", "mail 5", "mail 6", "home 1", "home 2", "home 4", "home 5"];

function isOpened(destName: string, status: string, talkTimeSec: number, queueName: string): boolean {
  if (status !== "answered") return false;
  if (!destName || destName.toUpperCase().startsWith("AI F")) return false;
  if (talkTimeSec <= 0) return false;
  if (!queueName.toLowerCase().includes("mail 4")) return false;
  return true;
}

// ─── Main: fetch today's live calls ─────────────────────────────────────────

export async function fetchTodayLiveCalls(): Promise<{ calls: LiveCall[]; error: string | null }> {
  const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
  const username = process.env.TCX_USERNAME ?? "1911";
  const password = process.env.TCX_PASSWORD ?? "";

  if (!password) return { calls: [], error: "TCX_PASSWORD not set" };

  try {
    const loginPageHtml = await httpsGet(`https://${domain}/LoginPage.aspx`);
    const viewState = extractViewState(loginPageHtml, "__VIEWSTATE");
    const viewStateGen = extractViewState(loginPageHtml, "__VIEWSTATEGENERATOR");
    const eventVal = extractViewState(loginPageHtml, "__EVENTVALIDATION");

    if (!viewState) throw new Error("Could not extract ViewState from 3CX login page");

    const loginBody = new URLSearchParams({
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventVal,
      txtUsername: username,
      txtPassword: password,
      x: "42",
      y: "6",
    }).toString();

    const loginResp = await httpsPost(`https://${domain}/LoginPage.aspx`, loginBody, {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    });

    if (!loginResp.cookies.includes(".ASPXAUTH")) {
      throw new Error("3CX login failed — no auth cookie");
    }

    // Format today's date as M/D/YYYY
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    const todayFmt = fmt.format(now); // e.g. "3/24/2026"

    const reportUrl =
      `https://${domain}/app0422/RunReportDefinitionToFile.ashx` +
      `?Output=Excel&U_ID=19978` +
      `&RD_ID=c80b90ab-0a2d-4413-b242-38e4046571f1` +
      `&Criteria=Date1%3D${encodeURIComponent(todayFmt)}%7C%7C%7C` +
      `Date2%3D${encodeURIComponent(todayFmt)}%7C%7C%7C` +
      `Extensions%3D%7C%7C%7CQueues%3D%7C%7C%7C` +
      `PageNumber%3D1%7C%7C%7CPageCnt%3D10000%7C%7C%7C` +
      `SortColumn%3D%7C%7C%7CSortAorD%3D`;

    const csv = await httpsGet(reportUrl, { Cookie: loginResp.cookies });

    // Parse CSV
    const calls: LiveCall[] = [];
    const lines = csv.split("\n");
    let headerIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (lines[i].toLowerCase().includes("callid")) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return { calls, error: null };

    // Auto-detect column positions from header (same logic as seed-rebuild)
    const headers = lines[headerIdx].split(",").map((h) => h.trim().toLowerCase().replace(/"/g, ""));
    const findCol = (name: string): number => headers.indexOf(name);

    // Standard positions
    let CI = findCol("callid");
    let STI = findCol("start time");
    let PHI = findCol("originated by");
    let IOI = findCol("in/out");

    // Status column detection (handles extra empty header columns in 3CX export)
    let SSI = findCol("status");
    let DNI = SSI >= 0 ? SSI - 1 : findCol("destination name");
    let TTI = SSI >= 0 ? SSI + 2 : findCol("talk time (sec)");
    let QI = findCol("queue name");

    if (CI < 0 || STI < 0 || PHI < 0) return { calls, error: "Could not parse CSV headers" };

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const c = line.split(",").map((v) => v.replace(/"/g, "").trim());
      if (c.length < 13) continue;

      const phone = normalizePhone(c[PHI] ?? "");
      if (!phone || phone.length !== 10) continue;

      const queueName = (c[QI] ?? "").trim();
      const isSalesQueue = SALES_QUEUES.some((q) => queueName.toLowerCase().includes(q));
      if (!isSalesQueue) continue;

      const inOut = (c[IOI] ?? "").trim().toLowerCase();
      if (inOut !== "inbound") continue;

      const destName = (c[DNI] ?? "").trim();
      const status = (c[SSI] ?? "").trim().toLowerCase();
      const talkSec = parseFloat(c[TTI] ?? "0") || 0;
      const startTime = (c[STI] ?? "").trim();

      calls.push({
        phoneNumber: phone,
        queueName,
        startTime,
        destName,
        status,
        talkTimeSec: talkSec,
        opened: isOpened(destName, status, talkSec, queueName),
      });
    }

    return { calls, error: null };
  } catch (e) {
    return { calls: [], error: String(e) };
  }
}
