// CS Overview — powers the top-of-page stat boxes
//
// Returns two blocks:
//   today    — live snapshot of right now (always today, ignores date range)
//   activity — event metrics summed over the requested date range, drawn from
//              cs_daily_snapshot. If today is in the range, today's in-progress
//              numbers are merged in live (computed from cs_past_due_accounts).
//
// Query params:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   (default: today..today)

import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { computeSnapshot, ensureSnapshotTable } from "../../../../lib/cs/snapshot";

function todayCT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(request: Request) {
  try {
    await ensureSnapshotTable();

    const url = new URL(request.url);
    const today = todayCT();
    const start = url.searchParams.get("start") || today;
    const end = url.searchParams.get("end") || today;

    // ── TODAY block (always current, regardless of range) ────────────────────
    const live = await computeSnapshot(today);

    // Calls remaining = total_accounts - accounts_called
    const callsRemaining = Math.max(0, live.total_accounts - live.accounts_called);

    // Worked today = accounts on today's list with ANY disposition entered
    const workedRes = await query(
      `SELECT COUNT(*) AS worked
       FROM cs_past_due_accounts
       WHERE scrub_date = $1
         AND (
           (dispo_1 IS NOT NULL AND dispo_1 <> '')
           OR (dispo_2 IS NOT NULL AND dispo_2 <> '')
         )`,
      [today]
    );
    const workedToday = parseInt(workedRes.rows[0]?.worked || "0", 10);

    const todayBlock = {
      date: today,
      total_accounts: live.total_accounts,
      zero_pay_accounts: live.zero_pay_accounts,
      non_zero_accounts: live.non_zero_accounts,
      accounts_called: live.accounts_called,
      calls_remaining: callsRemaining,
      worked_today: workedToday,
    };

    // ── ACTIVITY block (summed over range from snapshots) ────────────────────
    // Historical days come from cs_daily_snapshot. If today is in the range,
    // we compute today live and add it on top of anything for dates < today.
    const historyEnd = end >= today ? prevDay(today) : end;

    let history = {
      collections: 0,
      zero_pay_collections: 0,
      non_zero_collections: 0,
      amt_collected: 0,
      calls_dialed: 0,
      total_accounts_sum: 0,
    };

    if (start <= historyEnd) {
      const histRes = await query(
        `SELECT
           COALESCE(SUM(collections_count), 0) AS collections,
           COALESCE(SUM(zero_pay_collections), 0) AS zero_pay_collections,
           COALESCE(SUM(non_zero_collections), 0) AS non_zero_collections,
           COALESCE(SUM(amt_collected), 0) AS amt_collected,
           COALESCE(SUM(calls_dialed), 0) AS calls_dialed,
           COALESCE(SUM(total_accounts), 0) AS total_accounts_sum
         FROM cs_daily_snapshot
         WHERE snapshot_date >= $1 AND snapshot_date <= $2`,
        [start, historyEnd]
      );
      const h = histRes.rows[0] || {};
      history = {
        collections: parseInt(h.collections || "0", 10),
        zero_pay_collections: parseInt(h.zero_pay_collections || "0", 10),
        non_zero_collections: parseInt(h.non_zero_collections || "0", 10),
        amt_collected: parseFloat(h.amt_collected || "0"),
        calls_dialed: parseInt(h.calls_dialed || "0", 10),
        total_accounts_sum: parseInt(h.total_accounts_sum || "0", 10),
      };
    }

    // Merge in today's live values if today ∈ [start, end]
    const includeToday = start <= today && today <= end;
    const activity = {
      collections: history.collections + (includeToday ? live.collections_count : 0),
      zero_pay_collections: history.zero_pay_collections + (includeToday ? live.zero_pay_collections : 0),
      non_zero_collections: history.non_zero_collections + (includeToday ? live.non_zero_collections : 0),
      amt_collected: history.amt_collected + (includeToday ? live.amt_collected : 0),
      calls_dialed: history.calls_dialed + (includeToday ? live.calls_dialed : 0),
      total_accounts_sum: history.total_accounts_sum + (includeToday ? live.total_accounts : 0),
    };

    // Volume-weighted collection rate
    const collectionRate =
      activity.total_accounts_sum > 0
        ? (activity.collections / activity.total_accounts_sum) * 100
        : 0;

    return NextResponse.json({
      ok: true,
      today: todayBlock,
      activity: {
        start,
        end,
        ...activity,
        collection_rate: collectionRate,
      },
    });
  } catch (e) {
    console.error("[cs/overview] Error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

/** Return YYYY-MM-DD for the day before dateStr (pure string math, no TZ) */
function prevDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
