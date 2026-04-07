// CS Collections — PBS Programmatic Report Pull
//
// Required env vars:
//   PBS_USERNAME            Jeremy's PBS login (A00170-JFishbein)
//   PBS_PASSWORD            Jeremy's PBS password
//   PBS_BASE_URL            default https://www.pbsnetaccess.com
//   PBS_LOGIN_PATH          default /EntityLogin.aspx?portfolio=1144
//   PBS_REPORT_NAV_ID       default 00fad979-edd3-41e7-8a5c-9608401287b4
//                           (the NavToId for "Pending Cancellation Report")
//   PBS_USER_ID             default 1644
//   PBS_PORTFOLIO_ID        default 144
//   PBS_CLIENT_ID           default 1
//   PBS_PORTFOLIO_NAME      default "WALCO Funding"
//
// Flow (mirrors the real browser exactly):
//   1. GET  /EntityLogin.aspx → harvest hidden inputs
//   2. POST /EntityLogin.aspx with __doPostBack(ctlLogin$btnLogin) → PBSAuth cookie + SS token
//   3. GET  /Mainview.aspx?NavToId=<home>&SS=<SS> → extract conn token from OpenReportMonitor onclick
//   4. GET  /Mainview.aspx?NavToId=<pendingCancellation>&SS=<SS> → harvest form state
//   5. POST /Mainview.aspx?NavToId=<pendingCancellation>&SS=<SS> with full form body + __EVENTTARGET=ctl13$btnRun
//   6. Poll /Reports/ReportControl.aspx?conn=<conn>&SS=<SS>&...
//        until a "Ready" row for PendingCancellationReport appears
//   7. Parse LiteralName / ClientFileName / mimeType from the Download onclick
//   8. GET /tempretriever.i1uncompressed?LiteralName=...&SS=<SS> → xlsx (or pdf) bytes

import * as XLSX from "xlsx";

const PBS_BASE = () => process.env.PBS_BASE_URL || "https://www.pbsnetaccess.com";
const PBS_LOGIN_PATH = () => process.env.PBS_LOGIN_PATH || "/EntityLogin.aspx?portfolio=1144";
const PBS_REPORT_NAV_ID = () => process.env.PBS_REPORT_NAV_ID || "00fad979-edd3-41e7-8a5c-9608401287b4";
const PBS_USER_ID = () => process.env.PBS_USER_ID || "1644";
const PBS_PORTFOLIO_ID = () => process.env.PBS_PORTFOLIO_ID || "144";
const PBS_CLIENT_ID = () => process.env.PBS_CLIENT_ID || "1";
const PBS_PORTFOLIO_NAME = () => process.env.PBS_PORTFOLIO_NAME || "WALCO Funding";

interface PBSPullResult {
  ok: boolean;
  rawData?: unknown[][];
  error?: string;
  debug?: Record<string, unknown>;
}

export async function pullPBSReport(): Promise<PBSPullResult> {
  const username = process.env.PBS_USERNAME;
  const password = process.env.PBS_PASSWORD;
  if (!username || !password) {
    return { ok: false, error: "PBS credentials not configured (PBS_USERNAME, PBS_PASSWORD)" };
  }

  try {
    // ── 1-2. Login ────────────────────────────────────────────────────────
    const loginPageRes = await fetch(`${PBS_BASE()}${PBS_LOGIN_PATH()}`);
    const loginHtml = await loginPageRes.text();
    let cookies = extractCookies(loginPageRes.headers);
    const hiddens = extractAllHiddens(loginHtml);
    if (!hiddens["__VIEWSTATE"] || !hiddens["__EVENTVALIDATION"]) {
      return { ok: false, error: "Could not extract ASP.NET form tokens from login page" };
    }

    const loginParams: Record<string, string> = {
      ...hiddens,
      __EVENTTARGET: "ctlLogin$btnLogin",
      __EVENTARGUMENT: "",
      "ctlLogin$txtUserName": username,
      "ctlLogin$txtPassword": password,
    };
    const loginRes = await fetch(`${PBS_BASE()}${PBS_LOGIN_PATH()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookies,
        Referer: `${PBS_BASE()}${PBS_LOGIN_PATH()}`,
      },
      body: new URLSearchParams(loginParams).toString(),
      redirect: "manual",
    });
    cookies = mergeCookies(cookies, extractCookies(loginRes.headers));

    // Follow the post-login redirect if any, picking up any additional cookies
    let redirectLoc = loginRes.headers.get("location");
    let redirectHops = 0;
    while (redirectLoc && redirectHops < 5) {
      const url = redirectLoc.startsWith("http") ? redirectLoc : `${PBS_BASE()}${redirectLoc.startsWith("/") ? "" : "/"}${redirectLoc}`;
      const r = await fetch(url, { headers: { Cookie: cookies }, redirect: "manual" });
      cookies = mergeCookies(cookies, extractCookies(r.headers));
      redirectLoc = r.headers.get("location");
      redirectHops += 1;
      if (r.status < 300 || r.status >= 400) break;
    }

    const pbsAuthMatch = cookies.match(/PBSAuth=([^;]*)/);
    if (!pbsAuthMatch || !pbsAuthMatch[1]) {
      return { ok: false, error: `PBS login failed — no PBSAuth cookie. status=${loginRes.status}` };
    }

    // Pull the SS session token from the redirect URL, any response body, or cookies.
    // Easiest: fetch the top Mainview.aspx and extract SS from any link on the page.
    const mainRes = await fetch(`${PBS_BASE()}/Mainview.aspx`, { headers: { Cookie: cookies } });
    const mainHtml = await mainRes.text();
    cookies = mergeCookies(cookies, extractCookies(mainRes.headers));

    const ssMatch = mainHtml.match(/SS=([a-f0-9-]{36})/i);
    if (!ssMatch) {
      return { ok: false, error: "Could not extract SS session token from Mainview after login" };
    }
    const ss = ssMatch[1];

    // conn is a stable per-user encrypted blob. Prefer PBS_CONN env var;
    // fallback to parsing it out of Mainview if present.
    let conn = process.env.PBS_CONN || "";
    if (!conn) {
      const patterns = [
        /OpenReportMonitor\([^)]*?,\s*'([^']+)'\s*\)/,
        /OpenReportMonitor\([^)]*?,\s*"([^"]+)"\s*\)/,
        /[?&]conn=([^&"'\s]+)/,
      ];
      for (const p of patterns) {
        const m = mainHtml.match(p);
        if (m && m[1]) { conn = decodeURIComponent(m[1]); break; }
      }
    }
    if (!conn) {
      return { ok: false, error: "PBS_CONN env var not set and conn token not found in Mainview" };
    }

    // ── 3. Load the Pending Cancellation report form ─────────────────────
    const formUrl = `${PBS_BASE()}/Mainview.aspx?NavToId=${PBS_REPORT_NAV_ID()}&SS=${ss}`;
    const formRes = await fetch(formUrl, { headers: { Cookie: cookies } });
    const formHtml = await formRes.text();
    cookies = mergeCookies(cookies, extractCookies(formRes.headers));

    // DEBUG: if PBS_DEBUG_FORM=1, dump relevant form snippets and return
    if (process.env.PBS_DEBUG_FORM === "1") {
      const btnMatches = formHtml.match(/<(input|a|button)[^>]*(btnRun|Run)[^>]*>/gi) || [];
      const formTag = formHtml.match(/<form[^>]*>/i)?.[0] || "";
      const ctl13 = [...formHtml.matchAll(/name="(ctl\d+\$[^"]+)"/gi)].map(m => m[1]).slice(0, 60);
      const scriptMgr = formHtml.match(/ScriptManager[^<]*?<\/[^>]+>/i)?.[0]?.slice(0, 300) || "";
      return { ok: false, error: `DEBUG len=${formHtml.length} | form=${formTag} | btn=${JSON.stringify(btnMatches)} | names=${JSON.stringify(ctl13)} | sm=${scriptMgr}` };
    }

    // Harvest ALL inputs (hidden + text + checkboxes) so we can replay the form
    const formFields = extractAllInputs(formHtml);
    if (!formFields["SS"]) formFields["SS"] = ss;

    // Set begin/end dates: today and 1 month + 5 days out (the defaults Jeremy uses)
    const { beginDate, endDate } = defaultDateRange();
    // The date fields end in $dtbDate — find them by suffix
    for (const k of Object.keys(formFields)) {
      if (k.endsWith("$dtbDate")) {
        if (/ctl02/.test(k)) formFields[k] = beginDate;
        else if (/ctl03/.test(k)) formFields[k] = endDate;
      }
    }

    // Ensure format is set to PDF (value "1") — Excel is cosmetically listed
    // but PBS serves Pending Cancellation Report as PDF; we parse the PDF
    // server-side into structured data.
    formFields["ctl13$cboReportFormat"] = "1";

    // Fire the Run button
    formFields["__EVENTTARGET"] = "";
    formFields["__EVENTARGUMENT"] = "";
    formFields["ctl13$btnRun"] = "Run";

    const runRes = await fetch(formUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookies,
        Referer: formUrl,
      },
      body: new URLSearchParams(formFields).toString(),
      redirect: "manual",
    });
    cookies = mergeCookies(cookies, extractCookies(runRes.headers));
    if (runRes.status >= 500) {
      return { ok: false, error: `PBS Run POST failed: ${runRes.status}` };
    }

    // ── 4. Poll Report Monitor for a Ready row ───────────────────────────
    const monitorUrl =
      `${PBS_BASE()}/Reports/ReportControl.aspx` +
      `?userId=${encodeURIComponent(PBS_USER_ID())}` +
      `&portfolioId=${encodeURIComponent(PBS_PORTFOLIO_ID())}` +
      `&clientId=${encodeURIComponent(PBS_CLIENT_ID())}` +
      `&portfolio=${encodeURIComponent(PBS_PORTFOLIO_NAME())}` +
      `&snapshotId=&conn=${conn}` +
      `&SS=${ss}` +
      `&userName=${encodeURIComponent(username)}`;

    let downloadInfo: { literalName: string; clientFileName: string; mimeType: string } | null = null;
    const startedAt = Date.now();
    const timeoutMs = 90_000;
    while (Date.now() - startedAt < timeoutMs) {
      const monRes = await fetch(monitorUrl, { headers: { Cookie: cookies } });
      const monHtml = await monRes.text();
      const row = findNewestReadyDownload(monHtml, "PendingCancellationReport");
      if (row) {
        downloadInfo = row;
        break;
      }
      await sleep(3000);
    }
    if (!downloadInfo) {
      return { ok: false, error: `Timed out waiting for Ready row in Report Monitor after ${timeoutMs}ms` };
    }

    // ── 5. Download the file ─────────────────────────────────────────────
    const downloadUrl =
      `${PBS_BASE()}/tempretriever.i1uncompressed` +
      `?LiteralName=${encodeURIComponent(downloadInfo.literalName)}` +
      `&ClientFileName=${encodeURIComponent(downloadInfo.clientFileName)}` +
      `&mimeType=${encodeURIComponent(downloadInfo.mimeType)}` +
      `&SS=${ss}`;
    const dlRes = await fetch(downloadUrl, { headers: { Cookie: cookies } });
    if (!dlRes.ok) {
      return { ok: false, error: `Report download failed: ${dlRes.status} ${dlRes.statusText}` };
    }
    const buffer = Buffer.from(await dlRes.arrayBuffer());

    // If the file is XLSX, parse it. If PDF, return the raw buffer in debug
    // so the caller knows we need a PDF parser.
    const isXlsx = /\.xlsx$/i.test(downloadInfo.clientFileName);
    if (isXlsx) {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
      return { ok: true, rawData };
    }

    return {
      ok: false,
      error: `Report was delivered as ${downloadInfo.clientFileName} (${downloadInfo.mimeType}). Need Excel to parse.`,
      debug: { fileName: downloadInfo.clientFileName, mimeType: downloadInfo.mimeType, size: buffer.length },
    };
  } catch (e) {
    console.error("[pbs-pull] Error:", e);
    return { ok: false, error: String(e) };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function defaultDateRange(): { beginDate: string; endDate: string } {
  // CT date for "today"
  const tz = "America/Chicago";
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric", year: "numeric" });
  const todayParts = fmt.formatToParts(new Date()).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const beginDate = `${parseInt(todayParts.month, 10)}/${parseInt(todayParts.day, 10)}/${todayParts.year}`;
  // End date = same day next month + 5 days
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate() + 5, 12, 0, 0));
  const endParts = fmt.formatToParts(end).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const endDate = `${parseInt(endParts.month, 10)}/${parseInt(endParts.day, 10)}/${endParts.year}`;
  return { beginDate, endDate };
}

function extractAllHiddens(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = tag.match(/name="([^"]+)"/i)?.[1];
    const value = tag.match(/value="([^"]*)"/i)?.[1] ?? "";
    if (name) out[name] = value;
  }
  return out;
}

function extractAllInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = tag.match(/name="([^"]+)"/i)?.[1];
    if (!name) continue;
    const type = (tag.match(/type="([^"]+)"/i)?.[1] || "text").toLowerCase();
    const value = tag.match(/value="([^"]*)"/i)?.[1] ?? "";
    if (type === "checkbox") {
      // Only include if checked
      if (/\bchecked\b/i.test(tag)) out[name] = value || "on";
    } else if (type === "submit" || type === "button" || type === "image") {
      // Skip submit buttons — we set them explicitly
    } else {
      out[name] = value;
    }
  }
  return out;
}

// Find the most recent Ready row for the given report file name in the
// grdvw_ReportDetail table and parse the tempretriever args out of its
// Download anchor onclick.
function findNewestReadyDownload(
  html: string,
  fileNamePrefix: string
): { literalName: string; clientFileName: string; mimeType: string } | null {
  // Crude but effective: grab everything inside <table id="grdvw_ReportDetail" ...>...</table>
  const tableMatch = html.match(/<table[^>]*id="grdvw_ReportDetail"[\s\S]*?<\/table>/i);
  if (!tableMatch) return null;
  const tableHtml = tableMatch[0];

  // Split into <tr> chunks
  const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  // Walk from the top (most-recent is row index 1 in Jeremy's list; header is 0)
  for (const row of rows) {
    if (!/Ready/i.test(row)) continue;
    // Find anchor with onclick that references tempretriever AND the file name prefix
    const anchors = row.match(/<a[^>]*onclick="[^"]*tempretriever[^"]*"[^>]*>/gi) || [];
    for (const a of anchors) {
      const oc = a.match(/onclick="([^"]*)"/i)?.[1] || "";
      if (!oc.includes(fileNamePrefix)) continue;
      const literalName = (oc.match(/LiteralName=([^&'"\s]+)/) || [])[1];
      const clientFileName = (oc.match(/ClientFileName=([^&'"\s]+)/) || [])[1];
      const mimeType = (oc.match(/mimeType=([^&'"\s]+)/) || [])[1];
      if (literalName && clientFileName && mimeType) {
        return {
          literalName: decodeURIComponent(literalName),
          clientFileName: decodeURIComponent(clientFileName),
          mimeType: decodeURIComponent(mimeType),
        };
      }
    }
  }
  return null;
}

function extractCookies(headers: Headers): string {
  const setCookies = headers.getSetCookie?.() || [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function mergeCookies(existing: string, fresh: string): string {
  const map = new Map<string, string>();
  for (const c of existing.split("; ").filter(Boolean)) {
    const [k, ...v] = c.split("=");
    map.set(k, v.join("="));
  }
  for (const c of fresh.split("; ").filter(Boolean)) {
    const [k, ...v] = c.split("=");
    map.set(k, v.join("="));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
