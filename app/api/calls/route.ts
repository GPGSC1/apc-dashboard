import { NextResponse } from 'next/server';
import { Redis } from "@upstash/redis";
import https from 'https';

// ── KV ────────────────────────────────────────────────────────────────────────
// Stores: 3cx:opened → Record<phone, { date: string (YYYY-MM-DD) }>
// Stores: 3cx:lastPulled → ISO string

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

type OpenedSet = Record<string, { date: string }>;

async function loadOpened(redis: Redis): Promise<OpenedSet> {
  try {
    const raw = await redis.get<OpenedSet>("3cx:opened");
    return raw ?? {};
  } catch { return {}; }
}

async function saveOpened(redis: Redis, opened: OpenedSet, lastPulled: string) {
  try {
    await redis.set("3cx:opened", opened);
    await redis.set("3cx:lastPulled", lastPulled);
  } catch (e) { console.error("[3CX KV] save failed:", e); }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/^=/, '').replace(/^"/, '').replace(/"$/, '');
  const digits  = cleaned.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits.slice(-10);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
}

function extractViewState(html: string, field: string): string {
  let m = html.match(new RegExp(`id="${field}"[^>]*value="([^"]*)"`, 'i'));
  if (m) return m[1];
  m = html.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`, 'i'));
  return m ? m[1] : '';
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

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

// ── OPENED RULES (matches manual exactly) ────────────────────────────────────
// 1. Status = "answered"
// 2. Destination Name non-empty
// 3. Queue (col 18) = "8043"  ← exact queue ID match, not name
function isOpened(destName: string, status: string, queueId: string): boolean {
  if (status !== 'answered') return false;
  if (!destName || destName.trim() === '') return false;
  if (queueId.trim() !== '8043') return false;
  return true;
}

function parseCSV(csv: string): { phone: string; date: string }[] {
  const lines = csv.split('\n');
  if (lines.length < 5) return [];

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

  const STI = find('start time')       >= 0 ? find('start time')       : 1;
  const PHI = find('originated by')    >= 0 ? find('originated by')    : 8;
  const DNI = find('destination name') >= 0 ? find('destination name') : 11;
  const SSI = find('status')           >= 0 ? find('status')           : 12;
  const QI  = find('queue')            >= 0 ? find('queue')            : 18;  // col 18 = Queue ID "8043"

  const results: { phone: string; date: string }[] = [];
  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < 13) continue;

    const phone       = normalizePhone(c[PHI] ?? '');
    if (!phone || phone.length !== 10) continue;

    const destName    = (c[DNI] ?? '').trim();
    const status      = (c[SSI] ?? '').trim().toLowerCase();
    const queueId     = (c[QI]  ?? '').trim();
    const startTime   = (c[STI] ?? '').trim();

    if (!isOpened(destName, status, queueId)) continue;

    // Parse date from startTime (format: M/D/YYYY H:MM:SS AM/PM)
    const dateMatch = startTime.match(/(\d+)\/(\d+)\/(\d{4})/);
    const date = dateMatch
      ? `${dateMatch[3]}-${dateMatch[1].padStart(2,'0')}-${dateMatch[2].padStart(2,'0')}`
      : new Date().toISOString().slice(0, 10);

    results.push({ phone, date });
  }
  return results;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from') ?? '2026-02-25';
  const to   = searchParams.get('to')   ?? new Date().toISOString().slice(0, 10);

  const domain   = process.env.TCX_DOMAIN   ?? 'gpgsc.innicom.com';
  const username = process.env.TCX_USERNAME ?? '1911';
  const password = process.env.TCX_PASSWORD;

  if (!password) {
    return NextResponse.json({ ok: false, error: 'TCX_PASSWORD not set' }, { status: 500 });
  }

  const redis = getRedis();

  try {
    // 1. Login to 3CX
    const loginPageHtml = await httpsGet(`https://${domain}/LoginPage.aspx`);
    const viewState     = extractViewState(loginPageHtml, '__VIEWSTATE');
    const viewStateGen  = extractViewState(loginPageHtml, '__VIEWSTATEGENERATOR');
    const eventVal      = extractViewState(loginPageHtml, '__EVENTVALIDATION');

    const loginBody = new URLSearchParams({
      '__VIEWSTATE': viewState, '__VIEWSTATEGENERATOR': viewStateGen,
      '__EVENTVALIDATION': eventVal, 'txtUsername': username,
      'txtPassword': password, 'x': '42', 'y': '6',
    }).toString();

    const loginResp = await httpsPost(`https://${domain}/LoginPage.aspx`, loginBody, {
      'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/html',
    });

    if (!loginResp.cookies.includes('.ASPXAUTH')) {
      return NextResponse.json({ ok: false, error: '3CX login failed' }, { status: 401 });
    }

    // 2. Pull 3CX report — use lastPulled date to minimize data
    let pullFrom = from;
    if (redis) {
      try {
        const lastPulled = await redis.get<string>("3cx:lastPulled");
        if (lastPulled) {
          const lastDate = new Date(lastPulled).toISOString().slice(0, 10);
          // Pull from the later of: lastPulled date or requested from date
          pullFrom = lastDate > from ? lastDate : from;
        }
      } catch {}
    }

    const reportUrl =
      `https://${domain}/app0422/RunReportDefinitionToFile.ashx` +
      `?Output=Excel&U_ID=19978` +
      `&RD_ID=c80b90ab-0a2d-4413-b242-38e4046571f1` +
      `&Criteria=Date1%3D${encodeURIComponent(formatDate(pullFrom))}%7C%7C%7C` +
      `Date2%3D${encodeURIComponent(formatDate(to))}%7C%7C%7C` +
      `Extensions%3D%7C%7C%7CQueues%3D%7C%7C%7C` +
      `PageNumber%3D1%7C%7C%7CPageCnt%3D2000%7C%7C%7C` +
      `SortColumn%3D%7C%7C%7CSortAorD%3D`;

    const csv          = await httpsGet(reportUrl, { Cookie: loginResp.cookies });
    const newOpened    = parseCSV(csv);
    const nowISO       = new Date().toISOString();

    // 3. Merge into KV opened set (ITD dedup — first appearance wins)
    let openedSet: OpenedSet = {};
    if (redis) {
      openedSet = await loadOpened(redis);
      let changed = false;
      for (const { phone, date } of newOpened) {
        if (!openedSet[phone]) {
          openedSet[phone] = { date };
          changed = true;
        }
      }
      if (changed) await saveOpened(redis, openedSet, nowISO);
    }

    // 4. Return opened phones filtered to requested date range
    const filteredOpened = Object.entries(openedSet)
      .filter(([, v]) => v.date >= from && v.date <= to)
      .map(([phone, v]) => ({ phone, date: v.date }));

    return NextResponse.json({
      ok:           true,
      from,
      to,
      openedCount:  filteredOpened.length,
      totalITD:     Object.keys(openedSet).length,
      opened:       filteredOpened,
      lastUpdated:  nowISO,
    });

  } catch (err: unknown) {
    console.error('[calls/route.ts]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
