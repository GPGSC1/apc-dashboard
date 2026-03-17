import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import https from 'https';

// ─── Types ─────────────────────────────────────────────────────────────────────
export interface CallRecord {
  callId:      string;
  startTime:   string;
  phoneNumber: string;   // 10-digit normalised
  destName:    string;
  status:      string;
  talkTimeSec: number;
  queueName:   string;
  opened:      boolean;  // passes all 4 opened rules
}

interface SeedCall {
  phone:     string;
  date:      string;
  destName:  string;
  queueName: string;
}

interface SeedFile {
  generatedAt: string;
  count:       number;
  opened:      SeedCall[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), 'data');

function loadSeed(): SeedFile | null {
  const seedPath = path.join(DATA_DIR, 'tcx_calls_seed.json');
  try {
    if (!fs.existsSync(seedPath)) return null;
    return JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedFile;
  } catch {
    return null;
  }
}

function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/^=/, '').replace(/^"/, '').replace(/"$/, '');
  const digits  = cleaned.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits.slice(-10);
}

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

// ─── Opened rules ──────────────────────────────────────────────────────────────
// 1. Status = "answered"
// 2. Destination Name non-empty AND not starting with "AI F"
// 3. Talk Time (sec) > 0
// 4. Queue Name contains "mail 4"
function isOpened(destName: string, status: string, talkTimeSec: number, queueName: string): boolean {
  if (status !== 'answered') return false;
  if (!destName || destName.toUpperCase().startsWith('AI F')) return false;
  if (talkTimeSec <= 0) return false;
  if (!queueName.toLowerCase().includes('mail 4')) return false;
  return true;
}

function parseCSV(csv: string, fromDate: string, toDate: string): CallRecord[] {
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

  const CI  = find('callid')           >= 0 ? find('callid')           : 0;
  const STI = find('start time')       >= 0 ? find('start time')       : 1;
  const PHI = find('originated by')    >= 0 ? find('originated by')    : 8;
  const DNI = find('destination name') >= 0 ? find('destination name') : 11;
  const SSI = find('status')           >= 0 ? find('status')           : 12;
  const TTI = find('talk time (sec)')  >= 0 ? find('talk time (sec)')  : 14;
  const QI  = find('queue name')       >= 0 ? find('queue name')       : 19;

  const records: CallRecord[] = [];
  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = parseCsvLine(line);
    if (c.length < 13) continue;

    const phone = normalizePhone(c[PHI] ?? '');
    if (!phone || phone.length !== 10) continue;

    const startTime  = (c[STI] ?? '').trim();
    const destName   = (c[DNI] ?? '').trim();
    const status     = (c[SSI] ?? '').trim().toLowerCase();
    const talkSec    = parseFloat(c[TTI] ?? '0') || 0;
    const queueName  = (c[QI]  ?? '').trim();

    // Date filter
    try {
      const d = new Date(startTime);
      if (!isNaN(d.getTime())) {
        const dateStr = d.toISOString().slice(0, 10);
        if (dateStr < fromDate || dateStr > toDate) continue;
      }
    } catch { /* include if can't parse */ }

    records.push({
      callId:      (c[CI] ?? '').trim(),
      startTime,
      phoneNumber: phone,
      destName,
      status,
      talkTimeSec: talkSec,
      queueName,
      opened: isOpened(destName, status, talkSec, queueName),
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

  // ── 1. Seed: historical 3CX opened calls ────────────────────────────────────
  const seed        = loadSeed();
  const seedMaxDate = seed
    ? seed.opened.reduce((max, c) => c.date > max ? c.date : max, '')
    : '';

  const calls: CallRecord[] = [];
  let seedCount = 0;

  if (seed && seedMaxDate) {
    const effectiveEnd = to <= seedMaxDate ? to : seedMaxDate;
    for (const c of seed.opened) {
      if (c.date < from || c.date > effectiveEnd) continue;
      calls.push({
        callId:      '',
        startTime:   c.date,
        phoneNumber: c.phone,
        destName:    c.destName,
        status:      'answered',
        talkTimeSec: 1,      // > 0 (actual value not needed downstream)
        queueName:   c.queueName,
        opened:      true,   // pre-filtered: only opened calls stored in seed
      });
      seedCount++;
    }
  }

  // ── 2. Live 3CX API for dates after the seed ────────────────────────────────
  let liveCount = 0;
  let liveError: string | null = null;

  const liveNeeded = !seed || !seedMaxDate || to > seedMaxDate;
  if (liveNeeded) {
    const liveFrom = seed && seedMaxDate
      ? new Date(new Date(seedMaxDate).getTime() + 86400000).toISOString().slice(0, 10)
      : from;

    if (liveFrom <= to) {
      if (!password) {
        liveError = 'TCX_PASSWORD env var not set';
      } else {
        try {
          const loginPageHtml = await httpsGet(`https://${domain}/LoginPage.aspx`);
          const viewState     = extractViewState(loginPageHtml, '__VIEWSTATE');
          const viewStateGen  = extractViewState(loginPageHtml, '__VIEWSTATEGENERATOR');
          const eventVal      = extractViewState(loginPageHtml, '__EVENTVALIDATION');

          if (!viewState) throw new Error('Could not extract ViewState from 3CX login page');

          const loginBody = new URLSearchParams({
            '__VIEWSTATE':          viewState,
            '__VIEWSTATEGENERATOR': viewStateGen,
            '__EVENTVALIDATION':    eventVal,
            'txtUsername':          username,
            'txtPassword':          password,
            'x': '42', 'y': '6',
          }).toString();

          const loginResp = await httpsPost(`https://${domain}/LoginPage.aspx`, loginBody, {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept':       'text/html',
          });

          if (!loginResp.cookies.includes('.ASPXAUTH')) {
            throw new Error('3CX login failed — no auth cookie returned');
          }

          const fromFmt   = formatDate(liveFrom);
          const toFmt     = formatDate(to);
          const reportUrl =
            `https://${domain}/app0422/RunReportDefinitionToFile.ashx` +
            `?Output=Excel&U_ID=19978` +
            `&RD_ID=c80b90ab-0a2d-4413-b242-38e4046571f1` +
            `&Criteria=Date1%3D${encodeURIComponent(fromFmt)}%7C%7C%7C` +
            `Date2%3D${encodeURIComponent(toFmt)}%7C%7C%7C` +
            `Extensions%3D%7C%7C%7CQueues%3D%7C%7C%7C` +
            `PageNumber%3D1%7C%7C%7CPageCnt%3D2000%7C%7C%7C` +
            `SortColumn%3D%7C%7C%7CSortAorD%3D`;

          const csv       = await httpsGet(reportUrl, { Cookie: loginResp.cookies });
          const liveCalls = parseCSV(csv, liveFrom, to);
          calls.push(...liveCalls);
          liveCount = liveCalls.length;
        } catch (err: unknown) {
          liveError = String(err);
          console.error('[calls/route.ts] live API error:', err);
        }
      }
    }
  }

  return NextResponse.json({
    ok:          true,
    from,
    to,
    seedCount,
    liveCount,
    ...(liveError ? { liveError } : {}),
    totalCalls:  calls.length,
    openedCalls: calls.filter(c => c.opened).length,
    calls,
    lastUpdated: new Date().toISOString(),
  });
}
