import { NextResponse } from 'next/server';
import https from 'https';

// ─── Types ───────────────────────────────────────────────────────────────────
export interface CallRecord {
  callId: string;
  startTime: string;
  agentName: string;
  phoneNumber: string;   // 10-digit normalised
  status: string;
  queueName: string;
  answered: boolean;     // status === 'answered' AND destName present
  destName: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function extractViewState(html: string, field: string): string {
  const re = new RegExp(`id="${field}"[^>]*value="([^"]*)"`, 'i');
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`name="${field}"[^>]*value="([^"]*)"`, 'i');
  const m2 = html.match(re2);
  return m2 ? m2[1] : '';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length === 10 ? digits : '';
}

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers },
      (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(d)); }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url: string, body: string, headers: Record<string, string> = {}): Promise<{ body: string; cookies: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers },
      (res) => {
        let d = '';
        const cookies = (res.headers['set-cookie'] ?? []).join('; ');
        res.on('data', c => (d += c));
        res.on('end', () => resolve({ body: d, cookies }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSV(csv: string): CallRecord[] {
  const lines = csv.split('\n');
  if (lines.length < 5) return [];
  const records: CallRecord[] = [];
  // Skip 4 header lines (3 metadata + 1 column header)
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCSVLine(line);
    if (c.length < 20) continue;
    // col[5] = Destination Name (rep name), col[7] = fallback agent name
    const destName = (c[5] || '').trim();
    const agentName = destName || (c[7] || '').trim();
    const rawPhone = (c[8] || '').replace(/^=/, '').replace(/"/g, '').trim();
    const status = (c[12] || '').trim().toLowerCase();
    records.push({
      callId:      c[0] || '',
      startTime:   c[1] || '',
      agentName,
      destName,
      phoneNumber: normalizePhone(rawPhone),
      status,
      queueName:   c[19] || '',
      // "opened" = answered AND a rep name is present (destName non-empty)
      answered:    status === 'answered' && destName.length > 0,
    });
  }
  return records;
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from') ?? '2026-02-25'; // default = campaign start
  const to   = searchParams.get('to')   ?? new Date().toISOString().slice(0, 10);

  const domain = process.env.TCX_DOMAIN ?? 'gpgsc.innicom.com';
  const username = process.env.TCX_USERNAME ?? '1911';
  const password = process.env.TCX_PASSWORD!;

  if (!password) {
    return NextResponse.json({ ok: false, error: 'TCX_PASSWORD env var not set' }, { status: 500 });
  }

  try {
    // 1. GET login page → extract ASP.NET ViewState tokens
    const loginPageHtml = await httpsGet(`https://${domain}/LoginPage.aspx`);
    const viewState     = extractViewState(loginPageHtml, '__VIEWSTATE');
    const viewStateGen  = extractViewState(loginPageHtml, '__VIEWSTATEGENERATOR');
    const eventVal      = extractViewState(loginPageHtml, '__EVENTVALIDATION');

    if (!viewState) {
      return NextResponse.json({ ok: false, error: 'Could not extract ViewState from 3CX login page' }, { status: 500 });
    }

    // 2. POST credentials → get .ASPXAUTH cookie
    const loginBody = new URLSearchParams({
      '__VIEWSTATE':          viewState,
      '__VIEWSTATEGENERATOR': viewStateGen,
      '__EVENTVALIDATION':    eventVal,
      'txtUsername':          username,
      'txtPassword':          password,
      'x': '42',
      'y': '6',
    }).toString();

    const loginResp = await httpsPost(`https://${domain}/LoginPage.aspx`, loginBody, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html',
    });

    if (!loginResp.cookies.includes('.ASPXAUTH')) {
      return NextResponse.json({ ok: false, error: '3CX login failed — no auth cookie returned' }, { status: 401 });
    }

    // 3. Fetch call-log report (all queues, answered + unanswered)
    const fromFmt = formatDate(from);
    const toFmt   = formatDate(to);
    const reportUrl =
      `https://${domain}/app0422/RunReportDefinitionToFile.ashx` +
      `?Output=Excel&U_ID=19978` +
      `&RD_ID=c80b90ab-0a2d-4413-b242-38e4046571f1` +
      `&Criteria=Date1%3D${encodeURIComponent(fromFmt)}%7C%7C%7C` +
      `Date2%3D${encodeURIComponent(toFmt)}%7C%7C%7C` +
      `Extensions%3D%7C%7C%7CQueues%3D%7C%7C%7C` +
      `PageNumber%3D1%7C%7C%7CPageCnt%3D2000%7C%7C%7C` +
      `SortColumn%3D%7C%7C%7CSortAorD%3D`;

    const csv = await httpsGet(reportUrl, { Cookie: loginResp.cookies });
    const calls = parseCSV(csv);

    return NextResponse.json({
      ok: true,
      from,
      to,
      totalCalls:    calls.length,
      answeredCalls: calls.filter(c => c.answered).length,
      calls,
      lastUpdated:   new Date().toISOString(),
    });

  } catch (err: any) {
    console.error('[calls/route.ts]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
