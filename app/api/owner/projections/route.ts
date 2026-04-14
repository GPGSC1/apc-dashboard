import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";

// ── Fee & Reserve Schedule (from Inspiron's measurement map — qKeyUnified) ──
// Tiered by finance term. Same rates for WALCO (auto) and WALCO-HW (home).
const FEE_SCHEDULE = [
  { minTerm: 1, maxTerm: 12, feeRate: 0.0975, reserveRate: 0.35 },
  { minTerm: 13, maxTerm: 15, feeRate: 0.1075, reserveRate: 0.40 },
  { minTerm: 16, maxTerm: 18, feeRate: 0.1275, reserveRate: 0.45 },
  { minTerm: 19, maxTerm: 24, feeRate: 0.1475, reserveRate: 0.55 },
];

function getFeeReserve(termMonths: number) {
  const tier = FEE_SCHEDULE.find(
    (t) => termMonths >= t.minTerm && termMonths <= t.maxTerm
  );
  return tier || { feeRate: 0.1275, reserveRate: 0.45 }; // default to 16-18 tier
}

// ── Funding formula (verified by Inspiron against 99/99 deals, <$0.01 tolerance) ──
// FundingAmount = ((CustomerPay - DownPayment) × (1 - FeePct) - AdminCost) × (1 - ReservePct)
// AdminCost = dealerCost (the dealer/admin cost field from Moxy)
function calcFunding(custCost: number, downPayment: number, dealerCost: number, term: number): number {
  if (!custCost || custCost <= 0) return 0;
  const { feeRate, reserveRate } = getFeeReserve(term);
  const financed = custCost - downPayment;
  const afterFee = financed * (1 - feeRate);
  const afterAdmin = afterFee - dealerCost;
  const fundingAmount = afterAdmin * (1 - reserveRate);
  return Math.max(0, fundingAmount); // don't go negative
}

// ── Date helpers ──
function getWeekRange(refDate: string): { start: string; end: string } {
  const d = new Date(refDate + "T12:00:00Z");
  const dow = d.getUTCDay();
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() + diffToMon);
  const fri = new Date(mon);
  fri.setUTCDate(mon.getUTCDate() + 4);
  return {
    start: mon.toISOString().slice(0, 10),
    end: fri.toISOString().slice(0, 10),
  };
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function getNextFriday(refDate: string): string {
  const d = new Date(refDate + "T12:00:00Z");
  const dow = d.getUTCDay();
  const daysToFri = dow <= 5 ? 5 - dow : 6;
  if (daysToFri === 0) return refDate;
  const fri = new Date(d);
  fri.setUTCDate(d.getUTCDate() + daysToFri);
  return fri.toISOString().slice(0, 10);
}

// ── Build funding aggregates from deal rows ──
interface DealRow {
  cust_cost: number;
  dealer_cost: number;
  down_payment: number;
  finance_term: number;
}

function aggregateDeals(rows: DealRow[]) {
  let totalFunding = 0;
  let count = 0;
  for (const r of rows) {
    const f = calcFunding(
      Number(r.cust_cost) || 0,
      Number(r.down_payment) || 0,
      Number(r.dealer_cost) || 0,
      Number(r.finance_term) || 0
    );
    totalFunding += f;
    count++;
  }
  return {
    deals: count,
    funding: Math.round(totalFunding * 100) / 100,
    avgFunding: count > 0 ? Math.round(totalFunding / count) : 0,
    admin: Math.round(totalFunding * 100) / 100, // keep for backward compat
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const today = todayLocal();

    // ── Friday windows (WALCO funds every Friday) ──
    // "This Friday" window = prior Monday–Friday payment window
    // "Next Friday" window = current partial week through today
    const thisWeek = getWeekRange(today);
    const nextWeekStart = addDays(thisWeek.end, 3);
    const nextWeek = getWeekRange(nextWeekStart);
    const thisFriday = getNextFriday(today);
    const nextFriday = addDays(thisFriday, 7);

    // ── 1. This week deals (with financial fields) ──
    const thisWeekAutoRows = await query(
      `SELECT cust_cost, dealer_cost, down_payment, finance_term
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')
         AND cust_cost > 0`,
      [thisWeek.start, thisWeek.end]
    );
    const thisWeekHomeRows = await query(
      `SELECT cust_cost, dealer_cost, down_payment, finance_term
       FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')
         AND cust_cost > 0`,
      [thisWeek.start, thisWeek.end]
    );

    // Also get total deal count (including deals without financial data yet)
    const thisWeekAutoCount = await query(
      `SELECT COUNT(*) as count FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [thisWeek.start, thisWeek.end]
    );
    const thisWeekHomeCount = await query(
      `SELECT COUNT(*) as count FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [thisWeek.start, thisWeek.end]
    );

    // ── 2. Next week deals ──
    const nextWeekAutoRows = await query(
      `SELECT cust_cost, dealer_cost, down_payment, finance_term
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')
         AND cust_cost > 0`,
      [nextWeek.start, nextWeek.end]
    );
    const nextWeekHomeRows = await query(
      `SELECT cust_cost, dealer_cost, down_payment, finance_term
       FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')
         AND cust_cost > 0`,
      [nextWeek.start, nextWeek.end]
    );
    const nextWeekAutoCount = await query(
      `SELECT COUNT(*) as count FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [nextWeek.start, nextWeek.end]
    );
    const nextWeekHomeCount = await query(
      `SELECT COUNT(*) as count FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [nextWeek.start, nextWeek.end]
    );

    // ── 3. Pipeline: deals by status ──
    const pipelineAutoRes = await query(
      `SELECT deal_status, COUNT(*) as count, COALESCE(SUM(cust_cost), 0) as total_admin
       FROM moxy_deals
       WHERE sold_date >= $1
       GROUP BY deal_status
       ORDER BY count DESC`,
      [thisWeek.start]
    );
    const pipelineHomeRes = await query(
      `SELECT deal_status, COUNT(*) as count, COALESCE(SUM(cust_cost), 0) as total_admin
       FROM moxy_home_deals
       WHERE sold_date >= $1
       GROUP BY deal_status
       ORDER BY count DESC`,
      [thisWeek.start]
    );

    // ── 4. MTD totals ──
    const monthStart = today.slice(0, 7) + "-01";
    const mtdAutoRes = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(cust_cost), 0) as total_admin
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [monthStart, today]
    );
    const mtdHomeRes = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(cust_cost), 0) as total_admin
       FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [monthStart, today]
    );

    // ── 5. Weekly history (last 8 weeks) — compute funding per week ──
    const historyWeeks: {
      weekStart: string; weekEnd: string;
      autoDeals: number; homeDeals: number;
      autoAdmin: number; homeAdmin: number;
    }[] = [];

    for (let w = 0; w < 8; w++) {
      const wStart = addDays(thisWeek.start, -7 * w);
      const wk = getWeekRange(wStart);
      const haRows = await query(
        `SELECT cust_cost, dealer_cost, down_payment, finance_term
         FROM moxy_deals
         WHERE sold_date BETWEEN $1 AND $2
           AND deal_status NOT IN ('Back Out', 'VOID', '')
           AND cust_cost > 0`,
        [wk.start, wk.end]
      );
      const hhRows = await query(
        `SELECT cust_cost, dealer_cost, down_payment, finance_term
         FROM moxy_home_deals
         WHERE sold_date BETWEEN $1 AND $2
           AND deal_status NOT IN ('Back Out', 'VOID', '')
           AND cust_cost > 0`,
        [wk.start, wk.end]
      );
      const haCount = await query(
        `SELECT COUNT(*) as count FROM moxy_deals
         WHERE sold_date BETWEEN $1 AND $2 AND deal_status NOT IN ('Back Out', 'VOID', '')`,
        [wk.start, wk.end]
      );
      const hhCount = await query(
        `SELECT COUNT(*) as count FROM moxy_home_deals
         WHERE sold_date BETWEEN $1 AND $2 AND deal_status NOT IN ('Back Out', 'VOID', '')`,
        [wk.start, wk.end]
      );
      const autoAgg = aggregateDeals(haRows.rows);
      const homeAgg = aggregateDeals(hhRows.rows);
      historyWeeks.push({
        weekStart: wk.start,
        weekEnd: wk.end,
        autoDeals: Number(haCount.rows[0].count),
        homeDeals: Number(hhCount.rows[0].count),
        autoAdmin: autoAgg.funding,
        homeAdmin: homeAgg.funding,
      });
    }

    // ── 6. WALCO payments (when available) ──
    let walcoTotal = 0;
    let walcoCount = 0;
    try {
      const walcoRes = await query(
        `SELECT COUNT(*) as count, COALESCE(SUM(payment_amount), 0) as total
         FROM walco_payments
         WHERE payment_date BETWEEN $1 AND $2`,
        [thisWeek.start, thisWeek.end]
      );
      walcoTotal = Number(walcoRes.rows[0].total);
      walcoCount = Number(walcoRes.rows[0].count);
    } catch {
      // walco_payments table doesn't exist yet
    }

    // ── Build funding aggregates ──
    const thisWeekAutoAgg = aggregateDeals(thisWeekAutoRows.rows);
    const thisWeekHomeAgg = aggregateDeals(thisWeekHomeRows.rows);
    const nextWeekAutoAgg = aggregateDeals(nextWeekAutoRows.rows);
    const nextWeekHomeAgg = aggregateDeals(nextWeekHomeRows.rows);

    // Use total count (including deals without financial data) for deal counts
    thisWeekAutoAgg.deals = Number(thisWeekAutoCount.rows[0].count);
    thisWeekHomeAgg.deals = Number(thisWeekHomeCount.rows[0].count);
    nextWeekAutoAgg.deals = Number(nextWeekAutoCount.rows[0].count);
    nextWeekHomeAgg.deals = Number(nextWeekHomeCount.rows[0].count);

    function buildTotal(a: typeof thisWeekAutoAgg, h: typeof thisWeekHomeAgg) {
      const deals = a.deals + h.deals;
      const funding = a.funding + h.funding;
      return {
        deals,
        funding,
        avgFunding: deals > 0 ? Math.round(funding / deals) : 0,
        admin: funding,
      };
    }

    return NextResponse.json({
      ok: true,
      today,
      thisFriday,
      nextFriday,
      thisWeek: {
        range: thisWeek,
        auto: thisWeekAutoAgg,
        home: thisWeekHomeAgg,
        total: buildTotal(thisWeekAutoAgg, thisWeekHomeAgg),
      },
      nextWeek: {
        range: nextWeek,
        auto: nextWeekAutoAgg,
        home: nextWeekHomeAgg,
        total: buildTotal(nextWeekAutoAgg, nextWeekHomeAgg),
      },
      mtd: {
        monthStart,
        auto: { deals: Number(mtdAutoRes.rows[0].count), admin: Number(mtdAutoRes.rows[0].total_admin) },
        home: { deals: Number(mtdHomeRes.rows[0].count), admin: Number(mtdHomeRes.rows[0].total_admin) },
        total: {
          deals: Number(mtdAutoRes.rows[0].count) + Number(mtdHomeRes.rows[0].count),
          admin: Number(mtdAutoRes.rows[0].total_admin) + Number(mtdHomeRes.rows[0].total_admin),
        },
      },
      pipeline: {
        auto: pipelineAutoRes.rows.map((r: Record<string, unknown>) => ({
          status: r.deal_status,
          count: Number(r.count),
          admin: Number(r.total_admin),
        })),
        home: pipelineHomeRes.rows.map((r: Record<string, unknown>) => ({
          status: r.deal_status,
          count: Number(r.count),
          admin: Number(r.total_admin),
        })),
      },
      walco: { count: walcoCount, total: walcoTotal },
      history: historyWeeks,
      feeSchedule: FEE_SCHEDULE,
    });
  } catch (e) {
    console.error("Owner projections error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
