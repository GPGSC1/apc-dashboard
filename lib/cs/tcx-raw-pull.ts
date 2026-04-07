// CS-specific 3CX pull — captures EVERY call (inbound + outbound, every queue,
// every status, every extension) into cs_raw_calls. No filtering. No dedup
// beyond call_id. Account matching happens at query time.

import https from "https";
import { query, getPool } from "../db/connection";
import { ensureHistoricalTables, todayCT } from "./historical";

// ── Tiny HTTPS helpers (self-contained, no cross-route imports) ───────────
function httpsGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; cookies: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        method: "GET",
        headers: { Accept: "text/html,application/xhtml+xml,*/*", ...headers },
        rejectUnauthorized: false,
      },
      (res) => {
        let d = "";
        const cookies = (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d, cookies }));
      }
    );
    req.on("error", reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<{ body: string; cookies: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          const cookies = (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
          resolve({ body: data, cookies });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error("timeout")); });
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

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function norm10(p: string): string {
  if (!p) return "";
  const d = String(p).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : d;
}

// ── Main: pull today's full 3CX call dump and append to cs_raw_calls ──────
export async function pullCsRawCalls(targetDate?: string): Promise<{
  ok: boolean;
  inserted?: number;
  fetched?: number;
  error?: string;
}> {
  const date = targetDate || todayCT();
  const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
  const username = process.env.TCX_USERNAME ?? "1911";
  const password = process.env.TCX_PASSWORD;
  if (!password) return { ok: false, error: "TCX_PASSWORD not set" };

  try {
    await ensureHistoricalTables();

    // ── Login to 3CX ──
    const loginPageHtml = (await httpsGet(`https://${domain}/LoginPage.aspx`)).body;
    const viewState = extractViewState(loginPageHtml, "__VIEWSTATE");
    const viewStateGen = extractViewState(loginPageHtml, "__VIEWSTATEGENERATOR");
    const eventVal = extractViewState(loginPageHtml, "__EVENTVALIDATION");
    if (!viewState) return { ok: false, error: "Could not extract ViewState from 3CX login page" };

    const loginBody = new URLSearchParams({
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventVal,
      txtUsername: username,
      txtPassword: password,
      x: "42", y: "6",
    }).toString();

    const loginResp = await httpsPost(`https://${domain}/LoginPage.aspx`, loginBody, {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    });
    if (!loginResp.cookies.includes(".ASPXAUTH")) {
      return { ok: false, error: "3CX login failed — no auth cookie" };
    }

    // ── Fetch the full call detail report for today ──
    const [y, m, d] = date.split("-");
    const dateFmt = `${m}/${d}/${y}`;
    const reportUrl =
      `https://${domain}/app0422/RunReportDefinitionToFile.ashx` +
      `?Output=Excel&U_ID=19978` +
      `&RD_ID=c80b90ab-0a2d-4413-b242-38e4046571f1` +
      `&Criteria=Date1%3D${encodeURIComponent(dateFmt)}%7C%7C%7C` +
      `Date2%3D${encodeURIComponent(dateFmt)}%7C%7C%7C` +
      `Extensions%3D%7C%7C%7CQueues%3D%7C%7C%7C` +
      `PageNumber%3D1%7C%7C%7CPageCnt%3D10000%7C%7C%7C` +
      `SortColumn%3D%7C%7C%7CSortAorD%3D`;

    const csvResp = await httpsGet(reportUrl, { Cookie: loginResp.cookies });
    const lines = csvResp.body.split("\n");

    // Locate header row
    let headerIdx = 3;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (lines[i].toLowerCase().includes("callid")) { headerIdx = i; break; }
    }

    // Auto-detect Status column
    let SSI = -1;
    for (let probe = headerIdx + 1; probe < Math.min(headerIdx + 100, lines.length); probe++) {
      const pc = parseCsvLine(lines[probe]?.trim() ?? "");
      for (let j = 10; j < 16; j++) {
        const v = (pc[j] || "").trim().toLowerCase();
        if (v === "answered" || v === "unanswered") { SSI = j; break; }
      }
      if (SSI >= 0) break;
    }
    if (SSI < 0) SSI = 12;

    const CI = 0;   // CallID
    const STI = 1;  // StartTime
    const IOI = 3;  // Direction (Inbound/Outbound)
    const FEI = 4;  // First Extension
    const FNI = 5;  // First Ext Name
    const PHI = 8;  // Phone
    const DNI = SSI - 1;  // Destination
    const QI = SSI + 7;   // Queue Name

    // Collect every row, append to cs_raw_calls
    const headerRow = parseCsvLine(lines[headerIdx] || "");
    const rows: Array<{
      call_id: string; started_at: string | null; call_date: string;
      direction: string; phone: string; first_ext: string; agent_name: string;
      destination: string; queue_name: string; status: string; raw: Record<string, string>;
    }> = [];

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const cols = parseCsvLine(line);
      const callId = (cols[CI] || "").trim();
      if (!callId || callId.toLowerCase() === "callid") continue;

      const startTimeRaw = (cols[STI] || "").trim();
      // Parse as CT — 3CX exports in server-local CT
      let started_at: string | null = null;
      if (startTimeRaw) {
        // Accept "M/D/YYYY H:MM:SS" or ISO
        const t = startTimeRaw.replace(" ", "T");
        const parsed = new Date(t);
        if (!isNaN(parsed.getTime())) started_at = parsed.toISOString();
      }

      const raw: Record<string, string> = {};
      for (let j = 0; j < headerRow.length; j++) {
        raw[headerRow[j] || `col${j}`] = cols[j] || "";
      }

      rows.push({
        call_id: callId,
        started_at,
        call_date: date,
        direction: (cols[IOI] || "").trim(),
        phone: norm10(cols[PHI] || ""),
        first_ext: (cols[FEI] || "").trim(),
        agent_name: (cols[FNI] || "").trim(),
        destination: (cols[DNI] || "").trim(),
        queue_name: (cols[QI] || "").trim(),
        status: (cols[SSI] || "").trim(),
        raw,
      });
    }

    let inserted = 0;
    if (rows.length > 0) {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        for (const r of rows) {
          const res = await client.query(
            `INSERT INTO cs_raw_calls
             (call_id, started_at, call_date, direction, phone, first_ext,
              agent_name, destination, queue_name, status, raw_row)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (call_id) DO NOTHING`,
            [
              r.call_id, r.started_at, r.call_date, r.direction, r.phone,
              r.first_ext, r.agent_name, r.destination, r.queue_name, r.status,
              JSON.stringify(r.raw),
            ]
          );
          inserted += res.rowCount || 0;
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    return { ok: true, fetched: rows.length, inserted };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Business-hours gate: M-F 7am-7pm CT, Sat 9am-5pm CT ───────────────────
export function isCsBusinessHours(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const dow = parts.find((p) => p.type === "weekday")?.value || "";
  const hourStr = parts.find((p) => p.type === "hour")?.value || "0";
  const hour = parseInt(hourStr, 10);
  // Sunday = closed
  if (dow === "Sun") return false;
  // Saturday: 9am–5pm (inclusive of 9, exclusive of 17)
  if (dow === "Sat") return hour >= 9 && hour < 17;
  // M-F: 7am–7pm (inclusive of 7, exclusive of 19)
  return hour >= 7 && hour < 19;
}
