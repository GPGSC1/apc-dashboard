// CS Weekly Report — Mirrors Jeremy's CS Director Weekly Workbook
// Computes week-over-week metrics for Collections, Call Volume, Conversion %
// Future: CS Retention, Funding, QA, Merchant Info, Bounced ACH, Refunds

import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";

// Helper: get Monday-based week boundaries for a month
function getWeekBoundaries(year: number, month: number): { start: string; end: string; label: string }[] {
  const weeks: { start: string; end: string; label: string }[] = [];
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);

  // Find the first Monday on or before the 1st (to capture partial week)
  let cursor = new Date(firstDay);
  // Back up to Monday
  const dayOfWeek = cursor.getDay();
  if (dayOfWeek !== 1) {
    // If Sunday (0), go back 6 days; otherwise go back (day - 1)
    cursor.setDate(cursor.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  }

  let weekNum = 1;
  while (cursor <= lastDay) {
    const weekStart = new Date(Math.max(cursor.getTime(), firstDay.getTime()));
    const weekEndRaw = new Date(cursor);
    weekEndRaw.setDate(weekEndRaw.getDate() + 6); // Sunday
    const weekEnd = new Date(Math.min(weekEndRaw.getTime(), lastDay.getTime()));

    const fmtShort = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    const fmtISO = (d: Date) => d.toISOString().slice(0, 10);

    weeks.push({
      start: fmtISO(weekStart),
      end: fmtISO(weekEnd),
      label: `Week ${weekNum} (${fmtShort(weekStart)} - ${fmtShort(weekEnd)})`,
    });

    cursor.setDate(cursor.getDate() + 7);
    weekNum++;
  }

  return weeks;
}

// Assign a date string to a week index
function dateToWeekIdx(dateStr: string, weeks: { start: string; end: string }[]): number {
  for (let i = 0; i < weeks.length; i++) {
    if (dateStr >= weeks[i].start && dateStr <= weeks[i].end) return i;
  }
  return -1;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const monthParam = url.searchParams.get("month") || "";

    // Parse month: "2026-04" or default to current month
    let year: number, month: number;
    if (/^\d{4}-\d{2}$/.test(monthParam)) {
      [year, month] = monthParam.split("-").map(Number);
    } else {
      const now = new Date();
      // Use CT
      const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
      year = ct.getFullYear();
      month = ct.getMonth() + 1;
    }

    const weeks = getWeekBoundaries(year, month);
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${new Date(year, month, 0).getDate()}`;

    // ═══════════════════════════════════════════════════════════════════════
    // 1. COLLECTIONS PER REP
    // ═══════════════════════════════════════════════════════════════════════
    const collectionsResult = await query(
      `SELECT
        assigned_rep,
        scrub_date::TEXT as scrub_date,
        COUNT(*) FILTER (WHERE dispo_1 = 'Collected') as collections,
        COUNT(*) FILTER (WHERE dispo_1 = 'Collected' AND installments_made = 0) as zero_pays,
        COALESCE(SUM(amount_due) FILTER (WHERE dispo_1 = 'Collected'), 0) as amt_collected
      FROM cs_past_due_accounts
      WHERE scrub_date >= $1 AND scrub_date <= $2
        AND assigned_rep IS NOT NULL AND assigned_rep != ''
      GROUP BY assigned_rep, scrub_date
      ORDER BY assigned_rep, scrub_date`,
      [monthStart, monthEnd]
    );

    // Aggregate by rep and week
    const repSet = new Set<string>();
    const collectionsByRepWeek: Record<string, { collections: number; zeroPays: number; amtCollected: number }[]> = {};

    for (const row of collectionsResult.rows) {
      const rep = row.assigned_rep;
      repSet.add(rep);
      if (!collectionsByRepWeek[rep]) {
        collectionsByRepWeek[rep] = weeks.map(() => ({ collections: 0, zeroPays: 0, amtCollected: 0 }));
      }
      const wi = dateToWeekIdx(row.scrub_date, weeks);
      if (wi >= 0) {
        collectionsByRepWeek[rep][wi].collections += parseInt(row.collections) || 0;
        collectionsByRepWeek[rep][wi].zeroPays += parseInt(row.zero_pays) || 0;
        collectionsByRepWeek[rep][wi].amtCollected += parseFloat(row.amt_collected) || 0;
      }
    }

    // Totals per week
    const collectionsTotals = weeks.map((_, wi) => {
      let collections = 0, zeroPays = 0, amtCollected = 0;
      for (const rep of Object.keys(collectionsByRepWeek)) {
        collections += collectionsByRepWeek[rep][wi].collections;
        zeroPays += collectionsByRepWeek[rep][wi].zeroPays;
        amtCollected += collectionsByRepWeek[rep][wi].amtCollected;
      }
      return { collections, zeroPays, amtCollected };
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. OUTBOUND CALL VOLUME (from cs_outbound_calls)
    // ═══════════════════════════════════════════════════════════════════════
    const outboundResult = await query(
      `SELECT
        agent_name,
        (call_time::DATE)::TEXT as call_date,
        COUNT(*) as total_calls
      FROM cs_outbound_calls
      WHERE call_time >= $1::DATE AND call_time <= ($2::DATE + 1)
      GROUP BY agent_name, call_time::DATE
      ORDER BY agent_name, call_date`,
      [monthStart, monthEnd]
    );

    // Outbound by rep by week
    const outboundByRepWeek: Record<string, number[]> = {};
    const outboundTotals = weeks.map(() => 0);

    for (const row of outboundResult.rows) {
      const agent = row.agent_name || "Unknown";
      if (!outboundByRepWeek[agent]) outboundByRepWeek[agent] = weeks.map(() => 0);
      const wi = dateToWeekIdx(row.call_date, weeks);
      if (wi >= 0) {
        const cnt = parseInt(row.total_calls) || 0;
        outboundByRepWeek[agent][wi] += cnt;
        outboundTotals[wi] += cnt;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. INBOUND CALL VOLUME (from queue_calls - collections queue)
    // ═══════════════════════════════════════════════════════════════════════
    const inboundResult = await query(
      `SELECT
        call_date::TEXT as call_date,
        COUNT(*) as total_calls,
        COUNT(*) FILTER (WHERE status = 'unanswered' OR (first_ext IS NULL AND first_ext = '')) as dropped
      FROM queue_calls
      WHERE call_date >= $1 AND call_date <= $2
        AND (queue ILIKE '%collect%' OR queue ILIKE '%cs%')
      GROUP BY call_date
      ORDER BY call_date`,
      [monthStart, monthEnd]
    );

    const inboundTotals = weeks.map(() => ({ total: 0, dropped: 0 }));
    for (const row of inboundResult.rows) {
      const wi = dateToWeekIdx(row.call_date, weeks);
      if (wi >= 0) {
        inboundTotals[wi].total += parseInt(row.total_calls) || 0;
        inboundTotals[wi].dropped += parseInt(row.dropped) || 0;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. CONVERSION % (Collections / Outbound Calls per rep)
    // ═══════════════════════════════════════════════════════════════════════
    // Map 3CX agent full names to collection rep first names for matching
    const conversionByRep: Record<string, number[]> = {};
    const reps = [...repSet].sort();

    for (const rep of reps) {
      conversionByRep[rep] = weeks.map((_, wi) => {
        const coll = collectionsByRepWeek[rep]?.[wi]?.collections || 0;
        // Find outbound calls matching this rep (match by first name)
        let outbound = 0;
        for (const [agentName, weekCounts] of Object.entries(outboundByRepWeek)) {
          if (agentName.toLowerCase().startsWith(rep.toLowerCase())) {
            outbound += weekCounts[wi];
          }
        }
        return outbound > 0 ? Math.round((coll / outbound) * 1000) / 1000 : 0;
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 5. CS RETENTION (from Moxy deals - cancels, saves approximation)
    // ═══════════════════════════════════════════════════════════════════════
    // Cancels = Moxy deals that changed to Cancelled/Cancel POA status
    // We track deal_status in moxy_deals
    const cancelResult = await query(
      `SELECT
        sold_date::TEXT as sold_date,
        deal_status,
        COUNT(*) as cnt
      FROM (
        SELECT sold_date, deal_status FROM moxy_deals
        WHERE sold_date >= $1 AND sold_date <= $2
        UNION ALL
        SELECT sold_date, deal_status FROM moxy_home_deals
        WHERE sold_date >= $1 AND sold_date <= $2
      ) combined
      GROUP BY sold_date, deal_status
      ORDER BY sold_date`,
      [monthStart, monthEnd]
    );

    const retentionByWeek = weeks.map(() => ({
      totalDeals: 0,
      activeSold: 0,
      cancelled: 0,
      backOut: 0,
      cancelPOA: 0,
    }));

    for (const row of cancelResult.rows) {
      const wi = dateToWeekIdx(row.sold_date, weeks);
      if (wi < 0) continue;
      const cnt = parseInt(row.cnt) || 0;
      retentionByWeek[wi].totalDeals += cnt;
      const status = (row.deal_status || "").toLowerCase();
      if (status === "cancelled") retentionByWeek[wi].cancelled += cnt;
      else if (status === "cancel poa") retentionByWeek[wi].cancelPOA += cnt;
      else if (status === "back out") retentionByWeek[wi].backOut += cnt;
      else retentionByWeek[wi].activeSold += cnt;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. DISPOSITION SUMMARY (all dispos by rep for the month)
    // ═══════════════════════════════════════════════════════════════════════
    const dispoResult = await query(
      `SELECT
        assigned_rep,
        dispo_1,
        COUNT(*) as cnt
      FROM cs_past_due_accounts
      WHERE scrub_date >= $1 AND scrub_date <= $2
        AND assigned_rep IS NOT NULL AND assigned_rep != ''
        AND dispo_1 IS NOT NULL AND dispo_1 != ''
      GROUP BY assigned_rep, dispo_1
      ORDER BY assigned_rep, cnt DESC`,
      [monthStart, monthEnd]
    );

    const dispoByRep: Record<string, Record<string, number>> = {};
    for (const row of dispoResult.rows) {
      const rep = row.assigned_rep;
      if (!dispoByRep[rep]) dispoByRep[rep] = {};
      dispoByRep[rep][row.dispo_1] = parseInt(row.cnt) || 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 7. ACCOUNT TOTALS (total accounts assigned per rep per week)
    // ═══════════════════════════════════════════════════════════════════════
    const accountTotalsResult = await query(
      `SELECT
        assigned_rep,
        scrub_date::TEXT as scrub_date,
        COUNT(*) as total_accounts
      FROM cs_past_due_accounts
      WHERE scrub_date >= $1 AND scrub_date <= $2
        AND assigned_rep IS NOT NULL AND assigned_rep != ''
      GROUP BY assigned_rep, scrub_date`,
      [monthStart, monthEnd]
    );

    const accountsByRepWeek: Record<string, number[]> = {};
    for (const row of accountTotalsResult.rows) {
      const rep = row.assigned_rep;
      if (!accountsByRepWeek[rep]) accountsByRepWeek[rep] = weeks.map(() => 0);
      const wi = dateToWeekIdx(row.scrub_date, weeks);
      if (wi >= 0) {
        accountsByRepWeek[rep][wi] += parseInt(row.total_accounts) || 0;
      }
    }

    return NextResponse.json({
      ok: true,
      month: `${year}-${String(month).padStart(2, "0")}`,
      weeks: weeks.map(w => w.label),
      weekDates: weeks,
      collections: {
        byRep: collectionsByRepWeek,
        totals: collectionsTotals,
      },
      callVolume: {
        outboundByRep: outboundByRepWeek,
        outboundTotals,
        inboundTotals,
      },
      conversion: {
        byRep: conversionByRep,
      },
      retention: retentionByWeek,
      dispoByRep,
      accountsByRepWeek,
      reps: [...repSet].sort(),
    });
  } catch (e) {
    console.error("Weekly report error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
