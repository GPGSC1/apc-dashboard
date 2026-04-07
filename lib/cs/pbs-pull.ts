// CS Collections — PBS Programmatic Report Pull
// Logs in to pbsnetaccess.com, pulls the Pending Cancellation report as Excel
//
// Required env vars (set when going live):
//   PBS_USERNAME  — Jeremy's PBS login
//   PBS_PASSWORD  — Jeremy's PBS password
//   PBS_BASE_URL  — e.g. "https://pbsnetaccess.com" (default)
//
// The PBS login is ASP.NET WebForms auth:
//   1. GET /Login.aspx → extract __VIEWSTATE, __EVENTVALIDATION
//   2. POST credentials → get .ASPXAUTH cookie
//   3. GET report endpoint with auth cookie → download .xlsx

import * as XLSX from "xlsx";

const PBS_BASE = () => process.env.PBS_BASE_URL || "https://pbsnetaccess.com";
const PBS_LOGIN_PATH = () => process.env.PBS_LOGIN_PATH || "/EntityLogin.aspx?portfolio=1144";

interface PBSPullResult {
  ok: boolean;
  rawData?: unknown[][];
  error?: string;
}

/**
 * Pull the Pending Cancellation report from PBS as raw Excel rows.
 * Returns the raw 2D array for processing by the scrub pipeline.
 */
export async function pullPBSReport(): Promise<PBSPullResult> {
  const username = process.env.PBS_USERNAME;
  const password = process.env.PBS_PASSWORD;

  if (!username || !password) {
    return { ok: false, error: "PBS credentials not configured (PBS_USERNAME, PBS_PASSWORD)" };
  }

  try {
    // Step 1: GET login page to extract ASP.NET form tokens
    const loginPageRes = await fetch(`${PBS_BASE()}${PBS_LOGIN_PATH()}`, {
      redirect: "manual",
    });
    const loginHtml = await loginPageRes.text();
    const cookies = extractCookies(loginPageRes.headers);

    const viewState = extractFormField(loginHtml, "__VIEWSTATE");
    const eventValidation = extractFormField(loginHtml, "__EVENTVALIDATION");
    const viewStateGenerator = extractFormField(loginHtml, "__VIEWSTATEGENERATOR");

    if (!viewState || !eventValidation) {
      return { ok: false, error: "Could not extract ASP.NET form tokens from login page" };
    }

    // Step 2: POST login credentials
    const loginBody = new URLSearchParams({
      __VIEWSTATE: viewState,
      __EVENTVALIDATION: eventValidation,
      ...(viewStateGenerator ? { __VIEWSTATEGENERATOR: viewStateGenerator } : {}),
      txtUserName: username,
      txtPassword: password,
      btnLogin: "Log In",
    });

    const loginRes = await fetch(`${PBS_BASE()}${PBS_LOGIN_PATH()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookies,
      },
      body: loginBody.toString(),
      redirect: "manual",
    });

    // Collect auth cookies from the login response
    const authCookies = mergeCookies(cookies, extractCookies(loginRes.headers));

    if (!authCookies.includes(".ASPXAUTH")) {
      return { ok: false, error: "PBS login failed — no auth cookie received" };
    }

    // Step 3: Download the Pending Cancellation report
    // The exact report URL will need to be confirmed with Jeremy's account
    // Common pattern: /Reports/PendingCancellation.aspx or similar
    const reportUrl = process.env.PBS_REPORT_URL || `${PBS_BASE()}/Reports/PendingCancellation.aspx`;

    const reportRes = await fetch(reportUrl, {
      headers: { Cookie: authCookies },
    });

    if (!reportRes.ok) {
      return { ok: false, error: `PBS report download failed: ${reportRes.status} ${reportRes.statusText}` };
    }

    // Parse Excel response
    const buffer = Buffer.from(await reportRes.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

    return { ok: true, rawData };
  } catch (e) {
    console.error("[pbs-pull] Error:", e);
    return { ok: false, error: String(e) };
  }
}

// --- Helpers ---

function extractFormField(html: string, fieldName: string): string {
  // Try id= first, then name=, both orderings of attributes
  const patterns = [
    new RegExp(`id="${fieldName}"[^>]*value="([^"]*)"`, "i"),
    new RegExp(`name="${fieldName}"[^>]*value="([^"]*)"`, "i"),
    new RegExp(`value="([^"]*)"[^>]*name="${fieldName}"`, "i"),
    new RegExp(`value="([^"]*)"[^>]*id="${fieldName}"`, "i"),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return "";
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
