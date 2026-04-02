import { NextResponse } from "next/server";
import https from "https";

// Fetch raw 3CX report and show direction breakdown WITHOUT any filtering
export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || "2026-04-02";

  try {
    const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
    const username = process.env.TCX_USERNAME ?? "1911";
    const password = process.env.TCX_PASSWORD;
    if (!password) return NextResponse.json({ error: "TCX_PASSWORD not set" });

    // Login
    const loginPage = await httpGet(`https://${domain}/LoginPage.aspx`);
    const vs = loginPage.body.match(/id="__VIEWSTATE"[^>]*value="([^"]*)"/i)?.[1] || "";
    const vsg = loginPage.body.match(/id="__VIEWSTATEGENERATOR"[^>]*value="([^"]*)"/i)?.[1] || "";
    const ev = loginPage.body.match(/id="__EVENTVALIDATION"[^>]*value="([^"]*)"/i)?.[1] || "";

    const loginBody = new URLSearchParams({
      __VIEWSTATE: vs, __VIEWSTATEGENERATOR: vsg, __EVENTVALIDATION: ev,
      txtUsername: username, txtPassword: password, x: "42", y: "6",
    }).toString();

    const loginResp = await httpPost(`https://${domain}/LoginPage.aspx`, loginBody);
    if (!loginResp.cookies.includes(".ASPXAUTH")) {
      return NextResponse.json({ error: "3CX login failed" });
    }

    // Fetch report
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

    const csvResp = await httpGet(reportUrl, { Cookie: loginResp.cookies });
    const lines = csvResp.body.split("\n");

    // Find header
    let headerIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (lines[i].toLowerCase().includes("callid")) { headerIdx = i; break; }
    }

    // Parse header
    const headers = headerIdx >= 0 ? parseCsv(lines[headerIdx]) : [];

    // Count directions (column 3 = Direction/In/Out)
    const directionCol = headers.findIndex(h => h.toLowerCase().includes("in") && h.toLowerCase().includes("out"));
    const dirCol = directionCol >= 0 ? directionCol : 3;

    const dirCounts: Record<string, number> = {};
    const sampleRows: string[][] = [];
    let totalRows = 0;

    for (let i = (headerIdx >= 0 ? headerIdx + 1 : 4); i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCsv(line);
      if (cols.length < 5) continue;
      totalRows++;

      const dir = (cols[dirCol] || "").trim();
      dirCounts[dir || "(empty)"] = (dirCounts[dir || "(empty)"] || 0) + 1;

      // Sample first 3 of each direction
      if (sampleRows.length < 15) {
        sampleRows.push(cols.slice(0, 12));
      }
    }

    return NextResponse.json({
      ok: true,
      date,
      totalLines: lines.length,
      headerIdx,
      headers: headers.slice(0, 15),
      directionColumn: dirCol,
      totalDataRows: totalRows,
      directionCounts: dirCounts,
      sampleRows: sampleRows.slice(0, 5),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

function parseCsv(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ body: string; cookies: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers, rejectUnauthorized: false }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({
        body: d,
        cookies: (res.headers["set-cookie"] ?? []).map(c => c.split(";")[0]).join("; ")
      }));
    }).on("error", reject);
  });
}

function httpPost(url: string, body: string): Promise<{ body: string; cookies: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body).toString() },
      rejectUnauthorized: false,
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({
        body: d,
        cookies: (res.headers["set-cookie"] ?? []).map(c => c.split(";")[0]).join("; ")
      }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
