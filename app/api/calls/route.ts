import { NextResponse } from 'next/server';
import https from 'https';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface CallRecord {
  callId:      string;
  startTime:   string;
  phoneNumber: string;   // 10-digit normalised customer phone (Originated By)
  destName:    string;   // rep name from Destination Name col — non-empty = reached a rep
  status:      string;   // 'answered' | 'unanswered' | etc.
  queueName:   string;
  answered:    boolean;  // status === 'answered' AND destName non-empty
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractViewState(html: string, field: string): string {
  let m = html.match(new RegExp(`id="${field}"[^>]*value="([^"]*)"`, 'i'));
  if (m) return m[1];
  m = html.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/^=/, '').replace(/^"/, '').replace(/"$/, '');
  const digits  = cleaned.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits.slice(-10);
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

function httpsPost(
  url: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ body: string; cookies: string }> {
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

function parseCsvLine(line: string): string[] {
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

  // Find header row by scanning for 'callid'
  // 3CX export structure: line 0=title, line 1=params, line 2=section, line 3=headers, line 4+=data
  let headerRowIdx = 3;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].toLowerCase().includes('callid')) { headerRowIdx = i; break; }
  }

  const headers = parseCsvLine(lines[headerRowIdx]).map(h => h.trim().toLowerCase());

  // Locate columns by header name, with hard fallbacks matching actual 3CX column positions:
  // 0:CallID  1:Start Time  2:End Time  3:In/Out
  // 4:First Extension  5:First Extension Name
  // 6:Last Extension   7:Last Extension Name
  // 8:Originated By    9:Originated By Name
  // 10:Destination     11:Destination Name (rep name)
  // 12:Status          ...  19:Queue Name
  const find = (...names: string[]): number => {
    for (const name of names) {
      const idx = headers.findIndex(h => h === name);
      if (idx >= 0) return idx;
    }
    for (const name of names) {
      const idx = headers.findIndex(h => h.includes(name));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const CI  = find('callid')           >= 0 ? find('callid')           : 0;
  const STI = find('start time')       >= 0 ? find('start time')       : 1;
  const PHI = find('originated by')    >= 0 ? find('originated by')    : 8;   // customer phone
  const DNI = find('destination name') >= 0 ? find('destination name') : 11;  // rep name
  const SSI = find('status')           >= 0 ? find('status')           : 12;
  const QI  = find('queue name')       >= 0 ? find('queue name')       : 19;

  const records: CallRecord[] = [];
  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < 13) continue;

    const phone = normalizePhone(c[PHI] ?? '');
    if (!phone || phone.length !== 10) continue;

    const destName = (c[DNI] ?? '').trim();
    const status   = (c[SSI] ?? '').trim().toLowerCase();

    records.push({
      callId:      (c[CI]  ?? '').trim(),
      startTime:   (c[STI] ?? '').trim(),
      phoneNumber: phone,
      destName,
      status,
      queueName:   (c[QI]  ?? '').trim(),
      answered:    status === 'answered' && destName.length > 0,
    });
  }
  return records;
}

// ─── Route handler ─────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from') ?? '2026-02-25';
  const to   = searchParams.get('to')   ?? new Date().toISOString().slice(0, 10);

  const domain   = process.env.TCX_DOMAIN   ?? 'gpgsc.innicom.com';
  const username = process.env.TCX_USERNAME ?? '1911';
  const password = process.env.TCX_PASSWORD;

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
      return NextResponse.json(
        { ok: false, error: 'Could not extract ViewState from 3CX login page' },
        { status: 500 }
      );
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
      'Accept':       'text/html',
    });

    if (!loginResp.cookies.includes('.ASPXAUTH')) {
      return NextResponse.json(
        { ok: false, error: '3CX login failed — no auth cookie returned' },
        { status: 401 }
      );
    }

    // 3. Fetch call-log report (all queues, all statuses)
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

    const csv   = await httpsGet(reportUrl, { Cookie: loginResp.cookies });
    const calls = parseCSV(csv);

    return NextResponse.json({
      ok:            true,
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
