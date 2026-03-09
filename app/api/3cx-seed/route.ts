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

function isOpened(destName: string, status: string, talkTimeSec: number, queueName: string): boolean {
  if (status !== 'answered') return false;
  if (!destName || destName.toUpperCase().startsWith('AI F')) return false;
  if (talkTimeSec <= 0) return false;
  if (!queueName.toLowerCase().includes('mail 4')) return false;
  return true;
}

export async function GET() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return NextResponse.json({ ok: false, error: "KV not configured" }, { status: 500 });
  }
  const redis = new Redis({ url, token });

  const dataDir = path.join(process.cwd(), "data");
  const files   = fs.readdirSync(dataDir);

  // Find 3CX CSV files — look for "call" or "summary" or "3cx" in filename
  const csvFiles = files.filter(f =>
    f.toLowerCase().endsWith('.csv') &&
    (f.toLowerCase().includes('call_summary') ||
     f.toLowerCase().includes('3cx') ||
     f.toLowerCase().includes('summary'))
  );

  if (csvFiles.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "No 3CX CSV file found in /data folder. Name your file with 'call_summary' or '3cx' in the filename."
    }, { status: 400 });
  }

  // Load existing opened set from KV (so we don't overwrite existing data)
  let openedSet: Record<string, { date: string }> = {};
  try {
    const existing = await redis.get<Record<string, { date: string }>>("3cx:opened");
    if (existing) openedSet = existing;
  } catch {}

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
    const TTI = find('talk time (sec)')  >= 0 ? find('talk time (sec)')  : 14;
    const QI  = find('queue name')       >= 0 ? find('queue name')       : 19;

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
      const talkTimeSec = parseFloat(c[TTI] ?? '0') || 0;
      const queueName   = (c[QI]  ?? '').trim();
      const startTime   = (c[STI] ?? '').trim();

      if (!isOpened(destName, status, talkTimeSec, queueName)) { skipped++; continue; }

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
