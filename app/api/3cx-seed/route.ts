import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import * as fs from "fs";
import * as path from "path";

// One-time endpoint to seed KV with historical 3CX opened phones from CSV export
// GET /api/3cx-seed

const CAMPAIGN_START = "2026-02-25";

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

function normalizePhone(raw: string): string {
  const s = raw.replace(/^=/, '').replace(/^"/, '').replace(/"$/, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  if (d.length === 10) return d;
  return d.slice(-10);
}

function isOpened(destName: string, status: string, queueId: string): boolean {
  if (status !== 'answered') return false;
  if (!destName || destName.trim() === '') return false;
  if (queueId.trim() !== '8043') return false;
  return true;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const reset = searchParams.get("reset") === "true";

  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return NextResponse.json({ ok: false, error: "KV not configured" }, { status: 500 });
  }
  const redis = new Redis({ url, token });

  const dataDir = path.join(process.cwd(), "data");
  const files   = fs.readdirSync(dataDir);

  // Known list file names to exclude
  const LIST_FILES = new Set(['rt','bl021926bo','dg021726sc','jh022326mn','jl021926cr','jl021926lp','jl022526rs']);
  const AIM_KEYWORDS = ['acalls','bcalls','xfrcalls','aim'];

  // Find 3CX CSV files by content — any CSV that isn't a list file or AIM file
  // and contains 'callid' in its first 5 lines
  const csvFiles = files.filter(f => {
    if (!f.toLowerCase().endsWith('.csv')) return false;
    const base = f.replace(/\.csv$/i,'').toLowerCase();
    if (LIST_FILES.has(base)) return false;
    if (AIM_KEYWORDS.some(k => base.includes(k))) return false;
    if (base === 'opened' || base === 'sales') return false;
    // Peek at file to confirm it's a 3CX report
    try {
      const preview = fs.readFileSync(path.join(dataDir, f), 'latin1').slice(0, 2000);
      return preview.toLowerCase().includes('callid') && preview.toLowerCase().includes('originated by');
    } catch { return false; }
  });

  if (csvFiles.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "No 3CX CSV file found in /data folder. Make sure the file contains 'callid' and 'originated by' columns."
    }, { status: 400 });
  }

  // Load existing opened set (skip if reset=true)
  let openedSet: Record<string, { date: string }> = {};
  if (!reset) {
    try {
      const existing = await redis.get<Record<string, { date: string }>>("3cx:opened");
      if (existing) openedSet = existing;
    } catch {}
  }

  const existingCount = Object.keys(openedSet).length;
  let processed = 0, added = 0, skipped = 0;

  for (const csvFile of csvFiles) {
    const text  = fs.readFileSync(path.join(dataDir, csvFile), "latin1");
    const lines = text.split(/\r?\n/);

    // Find header row (contains 'callid')
    let headerIdx = 3;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (lines[i].toLowerCase().includes('callid')) { headerIdx = i; break; }
    }

    const headers = parseCsvLine(lines[headerIdx]).map(h => h.trim().toLowerCase());
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
    const QI  = find('queue')            >= 0 ? find('queue')            : 18;

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const c = parseCsvLine(line);
      if (c.length < 13) continue;

      processed++;

      const phone       = normalizePhone(c[PHI] ?? '');
      if (!phone || phone.length !== 10) { skipped++; continue; }

      const destName    = (c[DNI] ?? '').trim();
      const status      = (c[SSI] ?? '').trim().toLowerCase();
      const queueId     = (c[QI]  ?? '').trim();
      const startTime   = (c[STI] ?? '').trim();

      if (!isOpened(destName, status, queueId)) { skipped++; continue; }

      // Parse date
      const dm = startTime.match(/(\d+)\/(\d+)\/(\d{4})/);
      if (!dm) { skipped++; continue; }
      const date = `${dm[3]}-${dm[1].padStart(2,'0')}-${dm[2].padStart(2,'0')}`;
      if (date < CAMPAIGN_START) { skipped++; continue; }

      // First appearance ITD wins — don't overwrite existing
      if (!openedSet[phone]) {
        openedSet[phone] = { date };
        added++;
      }
    }
  }

  // Save to KV
  await redis.set("3cx:opened", openedSet);
  await redis.set("3cx:lastPulled", new Date().toISOString());

  return NextResponse.json({
    ok:            true,
    message:       "3CX seed complete",
    files:         csvFiles,
    processed,
    added,
    skipped,
    existingCount,
    totalOpened:   Object.keys(openedSet).length,
  });
}
