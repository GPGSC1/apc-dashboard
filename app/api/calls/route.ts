import { NextResponse } from 'next/server';
import https from 'https';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface CallRecord {
  callId:      string;
  startTime:   string;
  phoneNumber: string;   // 10-digit normalised (Originated By)
  destName:    string;   // Destination Name — rep name
  status:      string;
  talkTimeSec: number;   // Talk Time (sec) col O
  queueName:   string;   // Queue Name col T
  opened:      boolean;  // passes all 4 opened rules
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
  url: string, body: string, headers: Record<string, string> = {}
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

// ── OPENED RULES ──────────────────────────────────────────────────────────────
// A call counts as "opened" if ALL 4 conditions are met:
//   1. Status (col M, index 12) = "answered"
//   2. Destination Name (col L, index 11) is non-empty AND does NOT start with "AI F"
//   3. Talk Time in seconds (col O, index 14) > 0
//   4. Queue Name (col T, index 19) contains "mail 4" (case insensitive)
function isOpened(destName: string, status: string, talkTimeSec: number, queueName: string): boolean {
  if (status !== 'answered') return false;
  if (!destName || destName.toUpperCase().startsWith('AI F')) return false;
  if (talkTimeSec <= 0) return false;
  if (!queueName.toLowerCase().includes('mail 4')) return false;
  return true;
}

function parseCSV(csv: string): CallRecord[] {
  const lines = csv.split('\n');
  if (lines.length < 5) return [];

  // Find header row (contains 'callid')
  let headerRowIdx = 3;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].toLowerCase().includes('callid')) { headerRowIdx = i; break; }
  }

  const headers = parseCsvLine(lines[headerRowIdx]).map(h => h.trim().toLowerCase());

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

  // Map columns by header name with hard fallbacks matching actual 3CX positions:
  // 0:CallID  1:Start Time  2:End Time  3:In/Out
  // 4:First Extension  5:First Extension Name
  // 6:Last Extension   7:Last Extension Name
  // 8:Originated By    9:Originated By Name
  // 10:Destination     11:Destination Name
  // 12:Status          13:Talk Time  14:Talk Time (sec)
  // ...                19:Queue Name
  const CI  = find('callid')              >= 0 ? find('callid')              : 0;
  const STI = find('start time')          >= 0 ? find('start time')          : 1;
  const PHI = find('originated by')       >= 0 ? find('originated by')       : 8;
  const DNI = find('destination name')    >= 0 ? find('destination name')    : 11;
  const SSI = find('status')              >= 0 ? find('status')              : 12;
  const TTI = find('talk time (sec)')     >= 0 ? find('talk time (sec)')     : 14;
  const QI  = find('queue name')          >= 0 ? find('queue name')          : 19;

  const records: CallRecord[] = [];
  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < 13) continue;

    const phone = normalizePhone(c[PHI] ?? '');
    if (!phone || phone.length !== 10) continue;

    const destName    = (c[DNI] ?? '').trim();
    const status      = (c[SSI] ?? '').trim().toLowerCase();
    const talkTimeSec = parseFloat(c[TTI] ?? '0') || 0;
    const queueName   = (c[QI]  ?? '').trim();

    records.push({
      callId:      (c[CI]  ?? '').trim(),
      startTime:   (c[STI] ?? '').trim(),
      phoneNumber: phone,
      destName,
      status,
      talkTimeSec,
      queueName,
      opened: isOpened(destName, status, talkTimeSec, queueName),
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

    // 3. Fetch call log report
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
      ok:          true,
      from,
      to,
      totalCalls:  calls.length,
      openedCalls: calls.filter(c => c.opened).length,
      calls,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err: any) {
    console.error('[calls/route.ts]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
