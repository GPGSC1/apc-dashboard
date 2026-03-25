import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";
import { todayLocal } from "../../../lib/date-utils";
import { mapQueue, isAutoQueue, isHomeQueue, ALL_QUEUES } from "../../../lib/queue-map";
import { TEAMS, isExcludedSalesperson } from "../../../lib/teams";

/**
 * SALES DATA ROUTE — Powers the /sales dashboard.
 * Queries Postgres directly for salesperson-centric metrics.
 * No AIM data, no external API calls.
 */

const CAMPAIGN_START = "2026-02-25";

interface QueueStats {
  deals: number;
  calls: number;
  closeRate: number;
  unanswered: number;
}

interface SalespersonStats {
  totalDeals: number;
  totalCalls: number;
  closeRate: number;
  queues: Record<string, { deals: number; calls: number }>;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fromDate = url.searchParams.get("start") ?? CAMPAIGN_START;
  const toDate = url.searchParams.get("end") ?? todayLocal();

  try {
    // ── 1. DEALS by salesperson with queue attribution ──────────────
    // Get all qualifying deals in range
    const dealsResult = await query(
      `SELECT DISTINCT ON (contract_no)
         contract_no, salesperson, home_phone, mobile_phone, sold_date, deal_status
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')
         AND (salesperson IS NULL OR salesperson NOT ILIKE '%fishbein%')
       ORDER BY contract_no, sold_date DESC`,
      [fromDate, toDate]
    );

    // Build phone→queue map from phone_last_queue
    const phoneQueueResult = await query(
      "SELECT phone, queue FROM phone_last_queue"
    );
    const phoneToQueue = new Map<string, string>();
    for (const row of phoneQueueResult.rows) {
      const mapped = mapQueue(row.queue);
      if (mapped) phoneToQueue.set(row.phone.trim(), mapped);
    }

    // ── 2. OPENED CALLS count by queue in date range ────────────────
    // opened_calls only has mail 4 calls. For broader queue data,
    // we count from phone_last_queue entries with matching dates.
    const callsResult = await query(
      `SELECT plq.queue, COUNT(DISTINCT oc.phone) as cnt
       FROM opened_calls oc
       INNER JOIN phone_last_queue plq ON plq.phone = oc.phone
       WHERE oc.call_date BETWEEN $1 AND $2
       GROUP BY plq.queue`,
      [fromDate, toDate]
    );

    // Also get total opened calls
    const totalCallsResult = await query(
      `SELECT COUNT(*) as cnt FROM opened_calls WHERE call_date BETWEEN $1 AND $2`,
      [fromDate, toDate]
    );
    const totalCalls = parseInt(totalCallsResult.rows[0]?.cnt ?? "0");

    // Build queue→calls map
    const queueCalls: Record<string, number> = {};
    for (const row of callsResult.rows) {
      const mapped = mapQueue(row.queue);
      if (mapped) {
        queueCalls[mapped] = (queueCalls[mapped] ?? 0) + parseInt(row.cnt);
      }
    }

    // ── 3. ATTRIBUTE deals to queues and salespersons ────────────────
    const bySalesperson: Record<string, SalespersonStats> = {};
    const byQueue: Record<string, QueueStats> = {};
    let companyDeals = 0;
    let autoDeals = 0, homeDealCount = 0;
    let autoCalls = 0, homeCallCount = 0;

    // Initialize queues
    for (const q of ALL_QUEUES) {
      byQueue[q] = { deals: 0, calls: queueCalls[q] ?? 0, closeRate: 0, unanswered: 0 };
      if (isAutoQueue(q)) autoCalls += byQueue[q].calls;
      if (isHomeQueue(q)) homeCallCount += byQueue[q].calls;
    }

    for (const deal of dealsResult.rows) {
      const sp = deal.salesperson?.trim();
      if (!sp || isExcludedSalesperson(sp)) continue;

      // Find which queue this deal came from
      const phones = [deal.home_phone, deal.mobile_phone]
        .map((p: string) => (p ?? "").replace(/\D/g, "").slice(-10))
        .filter((p: string) => p.length === 10);

      let dealQueue: string | null = null;
      for (const p of phones) {
        const q = phoneToQueue.get(p);
        if (q) { dealQueue = q; break; }
      }

      companyDeals++;

      if (dealQueue) {
        if (byQueue[dealQueue]) byQueue[dealQueue].deals++;
        if (isAutoQueue(dealQueue)) autoDeals++;
        if (isHomeQueue(dealQueue)) homeDealCount++;
      }

      // Track per salesperson
      if (!bySalesperson[sp]) {
        bySalesperson[sp] = { totalDeals: 0, totalCalls: 0, closeRate: 0, queues: {} };
      }
      bySalesperson[sp].totalDeals++;
      if (dealQueue) {
        if (!bySalesperson[sp].queues[dealQueue]) {
          bySalesperson[sp].queues[dealQueue] = { deals: 0, calls: 0 };
        }
        bySalesperson[sp].queues[dealQueue].deals++;
      }
    }

    // Compute close rates for queues
    for (const q of ALL_QUEUES) {
      const qs = byQueue[q];
      qs.closeRate = qs.calls > 0 ? qs.deals / qs.calls : 0;
    }

    // Compute salesperson close rates
    for (const sp of Object.values(bySalesperson)) {
      sp.totalCalls = Object.values(sp.queues).reduce((s, q) => s + q.calls, 0);
      sp.closeRate = sp.totalDeals > 0 ? sp.totalDeals / Math.max(sp.totalCalls, 1) : 0;
    }

    // ── 4. DAILY TRENDS (for charts) ────────────────────────────────
    const trendsResult = await query(
      `SELECT sold_date, COUNT(DISTINCT contract_no) as cnt
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')
         AND (salesperson IS NULL OR salesperson NOT ILIKE '%fishbein%')
       GROUP BY sold_date
       ORDER BY sold_date`,
      [fromDate, toDate]
    );
    const dailyTrends = trendsResult.rows.map((r) => ({
      date: String(r.sold_date).slice(0, 10),
      deals: parseInt(r.cnt),
    }));

    // ── 5. STALENESS ────────────────────────────────────────────────
    const metaResult = await query(
      "SELECT source, max_date FROM seed_metadata WHERE source IN ('moxy', 'tcx')"
    );
    const staleness: Record<string, string | null> = { moxy: null, cx: null };
    for (const row of metaResult.rows) {
      if (row.source === "moxy") staleness.moxy = row.max_date ? String(row.max_date).slice(0, 10) : null;
      if (row.source === "tcx") staleness.cx = row.max_date ? String(row.max_date).slice(0, 10) : null;
    }

    return NextResponse.json({
      companyTotal: {
        deals: companyDeals,
        calls: totalCalls,
        closeRate: totalCalls > 0 ? companyDeals / totalCalls : 0,
      },
      autoTotal: {
        deals: autoDeals,
        calls: autoCalls,
        closeRate: autoCalls > 0 ? autoDeals / autoCalls : 0,
      },
      homeTotal: {
        deals: homeDealCount,
        calls: homeCallCount,
        closeRate: homeCallCount > 0 ? homeDealCount / homeCallCount : 0,
      },
      byQueue,
      bySalesperson,
      teams: TEAMS,
      dailyTrends,
      staleness,
      dateRange: { from: fromDate, to: toDate },
    });
  } catch (err) {
    console.error("[sales-data] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
