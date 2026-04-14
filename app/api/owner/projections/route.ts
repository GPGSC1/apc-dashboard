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

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Get the most recent Friday on or before refDate
function getPreviousFriday(refDate: string): string {
  const d = new Date(refDate + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun, 5=Fri
  const diff = dow >= 5 ? dow - 5 : dow + 2; // days back to Friday
  if (diff === 0) return refDate; // already Friday
  const fri = new Date(d);
  fri.setUTCDate(d.getUTCDate() - diff);
  return fri.toISOString().slice(0, 10);
}

// Get the next Friday on or after refDate
function getNextFriday(refDate: string): string {
  const d = new Date(refDate + "T12:00:00Z");
  const dow = d.getUTCDay();
  const daysToFri = dow <= 5 ? 5 - dow : 6;
  if (daysToFri === 0) return refDate;
  const fri = new Date(d);
  fri.setUTCDate(d.getUTCDate() + daysToFri);
  return fri.toISOString().slice(0, 10);
}

// ── Payment-date window logic (from workbook qControls) ──
// WALCO funds every Friday based on payments received in a prior window.
//
// ThisFriday = next Friday from AsOfDate
// ThisWindowStart = Friday 2 weeks ago (from AsOfDate)
// ThisWindowEnd = Friday 1 week ago (from AsOfDate)
// NextWindowStart = day after ThisWindowEnd
// NextWindowEnd = AsOfDate
//
// "This Friday" projection = deals that received a WALCO payment
//   between ThisWindowStart and ThisWindowEnd
// "Next Friday" projection = deals that received a WALCO payment
//   between NextWindowStart and NextWindowEnd (partial week so far)
function getPaymentWindows(asOfDate: string) {
  const thisFriday = getNextFriday(asOfDate);
  // Friday 1 week ago = the Friday before thisFriday
  const lastFriday = addDays(thisFriday, -7);
  // Friday 2 weeks ago
  const twoFridaysAgo = addDays(thisFriday, -14);

  return {
    thisFriday,
    nextFriday: addDays(thisFriday, 7),
    // Window for "This Friday" funding: 2 Fridays ago through last Friday
    thisWindow: { start: twoFridaysAgo, end: lastFriday },
    // Window for "Next Friday" funding: day after last Friday through today
    nextWindow: { start: addDays(lastFriday, 1), end: asOfDate },
  };
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

// ── Query deals with payment-date windowing via walco_payments JOIN ──
// Uses DISTINCT ON contract_no to avoid double-counting deals with multiple payments
async function getWindowDeals(
  table: "moxy_deals" | "moxy_home_deals",
  windowStart: string,
  windowEnd: string
): Promise<{ rows: DealRow[]; totalCount: number }> {
  // Get deal financial data for funding calculation (DISTINCT by contract_no)
  const financialRows = await query(
    `SELECT DISTINCT ON (md.contract_no)
       md.cust_cost, md.dealer_cost, md.down_payment, md.finance_term
     FROM walco_payments wp
     JOIN ${table} md ON md.contract_no = wp.policy_number
     WHERE wp.payment_date BETWEEN $1 AND $2
       AND md.deal_status NOT IN ('Back Out', 'VOID', '')
       AND md.cust_cost > 0`,
    [windowStart, windowEnd]
  );

  // Get total unique deal count (including deals without financial data)
  const countRes = await query(
    `SELECT COUNT(DISTINCT wp.policy_number) as count
     FROM walco_payments wp
     JOIN ${table} md ON md.contract_no = wp.policy_number
     WHERE wp.payment_date BETWEEN $1 AND $2
       AND md.deal_status NOT IN ('Back Out', 'VOID', '')`,
    [windowStart, windowEnd]
  );

  return {
    rows: financialRows.rows,
    totalCount: Number(countRes.rows[0].count),
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const today = todayLocal();

    // ── Payment-date windows (from workbook qControls) ──
    const windows = getPaymentWindows(today);

    // ── 1. This Friday deals (payment window: 2 Fridays ago → last Friday) ──
    const [thisAutoData, thisHomeData] = await Promise.all([
      getWindowDeals("moxy_deals", windows.thisWindow.start, windows.thisWindow.end),
      getWindowDeals("moxy_home_deals", windows.thisWindow.start, windows.thisWindow.end),
    ]);

    // ── 2. Next Friday deals (payment window: day after last Friday → today) ──
    const [nextAutoData, nextHomeData] = await Promise.all([
      getWindowDeals("moxy_deals", windows.nextWindow.start, windows.nextWindow.end),
      getWindowDeals("moxy_home_deals", windows.nextWindow.start, windows.nextWindow.end),
    ]);

    // ── 3. Pipeline: deals by status (all deals with payments since thisWindow start) ──
    const [pipelineAutoRes, pipelineHomeRes] = await Promise.all([
      query(
        `SELECT md.deal_status, COUNT(DISTINCT wp.policy_number) as count,
                COALESCE(SUM(DISTINCT md.cust_cost), 0) as total_admin
         FROM walco_payments wp
         JOIN moxy_deals md ON md.contract_no = wp.policy_number
         WHERE wp.payment_date >= $1
         GROUP BY md.deal_status
         ORDER BY count DESC`,
        [windows.thisWindow.start]
      ),
      query(
        `SELECT md.deal_status, COUNT(DISTINCT wp.policy_number) as count,
                COALESCE(SUM(DISTINCT md.cust_cost), 0) as total_admin
         FROM walco_payments wp
         JOIN moxy_home_deals md ON md.contract_no = wp.policy_number
         WHERE wp.payment_date >= $1
         GROUP BY md.deal_status
         ORDER BY count DESC`,
        [windows.thisWindow.start]
      ),
    ]);

    // ── 4. MTD totals (all payments this month, joined to deals) ──
    const monthStart = today.slice(0, 7) + "-01";
    const [mtdAutoRes, mtdHomeRes] = await Promise.all([
      query(
        `SELECT COUNT(DISTINCT wp.policy_number) as count,
                COALESCE(SUM(DISTINCT md.cust_cost), 0) as total_admin
         FROM walco_payments wp
         JOIN moxy_deals md ON md.contract_no = wp.policy_number
         WHERE wp.payment_date BETWEEN $1 AND $2
           AND md.deal_status NOT IN ('Back Out', 'VOID', '')`,
        [monthStart, today]
      ),
      query(
        `SELECT COUNT(DISTINCT wp.policy_number) as count,
                COALESCE(SUM(DISTINCT md.cust_cost), 0) as total_admin
         FROM walco_payments wp
         JOIN moxy_home_deals md ON md.contract_no = wp.policy_number
         WHERE wp.payment_date BETWEEN $1 AND $2
           AND md.deal_status NOT IN ('Back Out', 'VOID', '')`,
        [monthStart, today]
      ),
    ]);

    // ── 5. Weekly history (last 8 weeks) — using payment-date windows ──
    const historyWeeks: {
      weekStart: string; weekEnd: string;
      autoDeals: number; homeDeals: number;
      autoAdmin: number; homeAdmin: number;
    }[] = [];

    for (let w = 0; w < 8; w++) {
      const wkEnd = addDays(windows.thisWindow.end, -7 * w); // Friday
      const wkStart = addDays(wkEnd, -6); // Saturday before
      const [haData, hhData] = await Promise.all([
        getWindowDeals("moxy_deals", wkStart, wkEnd),
        getWindowDeals("moxy_home_deals", wkStart, wkEnd),
      ]);
      const autoAgg = aggregateDeals(haData.rows);
      const homeAgg = aggregateDeals(hhData.rows);
      historyWeeks.push({
        weekStart: wkStart,
        weekEnd: wkEnd,
        autoDeals: haData.totalCount,
        homeDeals: hhData.totalCount,
        autoAdmin: autoAgg.funding,
        homeAdmin: homeAgg.funding,
      });
    }

    // ── 6. WALCO payment totals for this window ──
    let walcoTotal = 0;
    let walcoCount = 0;
    try {
      const walcoRes = await query(
        `SELECT COUNT(*) as count, COALESCE(SUM(payment_amount), 0) as total
         FROM walco_payments
         WHERE payment_date BETWEEN $1 AND $2`,
        [windows.thisWindow.start, windows.thisWindow.end]
      );
      walcoTotal = Number(walcoRes.rows[0].total);
      walcoCount = Number(walcoRes.rows[0].count);
    } catch {
      // walco_payments table doesn't exist yet
    }

    // ── Build funding aggregates ──
    const thisWeekAutoAgg = aggregateDeals(thisAutoData.rows);
    const thisWeekHomeAgg = aggregateDeals(thisHomeData.rows);
    const nextWeekAutoAgg = aggregateDeals(nextAutoData.rows);
    const nextWeekHomeAgg = aggregateDeals(nextHomeData.rows);

    // Use total count (including deals without financial data) for deal counts
    thisWeekAutoAgg.deals = thisAutoData.totalCount;
    thisWeekHomeAgg.deals = thisHomeData.totalCount;
    nextWeekAutoAgg.deals = nextAutoData.totalCount;
    nextWeekHomeAgg.deals = nextHomeData.totalCount;

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
      thisFriday: windows.thisFriday,
      nextFriday: windows.nextFriday,
      thisWeek: {
        range: windows.thisWindow,
        auto: thisWeekAutoAgg,
        home: thisWeekHomeAgg,
        total: buildTotal(thisWeekAutoAgg, thisWeekHomeAgg),
      },
      nextWeek: {
        range: windows.nextWindow,
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
