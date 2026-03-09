import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import * as fs from "fs";
import * as path from "path";

// One-time endpoint to seed KV with historical AIM data from CSV export
// GET /api/aim-seed  (no auth — restrict by deleting file after seeding)

const CAMPAIGN_START = "2026-02-25";

const KNOWN_LISTS: Record<string, number> = {
  RT: 0, JL021926LP: 8000, BL021926BO: 8000,
  JH022326MN: 8000, JL021926CR: 8000, DG021726SC: 5000, JL022526RS: 6000,
};

const detectListKey = (text: string): string | null => {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const m10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (m10) return (m10[1] + m10[2] + m10[3]).toUpperCase();
  const m8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (m8) return (m8[1] + m8[2]).toUpperCase();
  return null;
};

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

export async function GET() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return NextResponse.json({ ok: false, error: "KV not configured" }, { status: 500 });
  }
  const redis = new Redis({ url, token });

  // Find AIM CSV in /data folder
  const dataDir = path.join(process.cwd(), "data");
  const files   = fs.readdirSync(dataDir);

  // Look for files with "calls" in the name (AIM exports)
  const csvFiles = files.filter(f =>
    f.toLowerCase().endsWith('.csv') &&
    (f.toLowerCase().includes('call') || f.toLowerCase().includes('aim'))
  );

  if (csvFiles.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "No AIM CSV file found in /data folder. Name your file with 'calls' or 'aim' in the filename."
    }, { status: 400 });
  }

  // AIM CSV columns:
  // Agent Id | Agent Name | From | To | Direction | Duration | Duration (seconds) |
  // Transfer Call Duration | Cost | Ended Reason | Outcomes | Started At | Call id |
  // Campaign name | Transfer number
  const COL = {
    agentName:    1,
    duration_sec: 6,
    cost:         8,
    outcomes:     10,
    startedAt:    11,
    callId:       12,
    campaignName: 13,
  };

  type DailyAIM = Record<string, Record<string, { min: number; cost: number }>>;
  const daily: DailyAIM = {};
  let processed = 0, skipped = 0, matched = 0;

  for (const csvFile of csvFiles) {
    const text  = fs.readFileSync(path.join(dataDir, csvFile), "latin1");
    const lines = text.split(/\r?\n/);

    // Find header row
    let headerIdx = 0;
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      if (lines[i].toLowerCase().includes("campaign name") || lines[i].toLowerCase().includes("started at")) {
        headerIdx = i;
        break;
      }
    }

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const c = parseCsvLine(line);
      if (c.length < 14) continue;

      processed++;

      const outcomes     = (c[COL.outcomes]     ?? "").toLowerCase();
      const isTransfer   = outcomes.includes("transferred");
      if (!isTransfer) { skipped++; continue; }

      const campaignName = c[COL.campaignName] ?? "";
      const list         = detectListKey(campaignName);
      if (!list || !Object.prototype.hasOwnProperty.call(KNOWN_LISTS, list)) { skipped++; continue; }

      const startedAt    = c[COL.startedAt] ?? "";
      const dateMatch    = startedAt.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!dateMatch) { skipped++; continue; }
      const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      if (date < CAMPAIGN_START) { skipped++; continue; }

      const durationSec  = parseFloat(c[COL.duration_sec] ?? "0") || 0;
      const cost         = parseFloat(c[COL.cost]         ?? "0") || 0;
      const min          = durationSec / 60;

      if (!daily[date]) daily[date] = {};
      if (!daily[date][list]) daily[date][list] = { min: 0, cost: 0 };
      daily[date][list].min  += min;
      daily[date][list].cost += cost;
      matched++;
    }
  }

  // Round values
  for (const dayData of Object.values(daily)) {
    for (const v of Object.values(dayData)) {
      v.min  = Math.round(v.min);
      v.cost = Math.round(v.cost * 100) / 100;
    }
  }

  // Save to KV
  await redis.set("aim:daily", daily);
  await redis.set("aim:lastPulled", new Date().toISOString());

  // Summary by list
  const summary: Record<string, { min: number; cost: number }> = {};
  for (const dayData of Object.values(daily)) {
    for (const [li, stats] of Object.entries(dayData)) {
      if (!summary[li]) summary[li] = { min: 0, cost: 0 };
      summary[li].min  += stats.min;
      summary[li].cost += stats.cost;
    }
  }

  return NextResponse.json({
    ok:        true,
    message:   "AIM seed complete",
    files:     csvFiles,
    processed,
    matched,
    skipped,
    daysStored: Object.keys(daily).length,
    summary,
  });
}
