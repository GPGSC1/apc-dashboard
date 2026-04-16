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

// ── Funding formula (verbatim from Apps Script line 419) ──
// fundingAmount = (1 - reservePct) * (((customerPay - downPayment) * (1 - feePct)) - adminCost)
// AdminCost = dealerCost (mapping previously verified <$0.01 tolerance)
function calcFunding(custCost: number, downPayment: number, dealerCost: number, term: number): number {
  if (!custCost || custCost <= 0) return 0;
  const { feeRate, reserveRate } = getFeeReserve(term);
  const financed = custCost - downPayment;
  const afterFee = financed * (1 - feeRate);
  const afterAdmin = afterFee - dealerCost;
  const fundingAmount = afterAdmin * (1 - reserveRate);
  return Math.max(0, fundingAmount);
}

// ── Date helpers ──

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

// ── Payment-date windows (verbatim from Apps Script lines 156-160) ──
// thisFriday       = next Friday from asOfDate
// thisWindowStart  = thisFriday - 13 days (prior Saturday, 2 weeks back)
// thisWindowEnd    = thisFriday - 7 days  (prior Friday)
// nextWindowStart  = thisFriday - 6 days  (current Saturday)
// nextWindowEnd    = asOfDate             (partial window, run date)
function getPaymentWindows(asOfDate: string) {
  const thisFriday = getNextFriday(asOfDate);
  return {
    thisFriday,
    nextFriday: addDays(thisFriday, 7),
    thisWindow: { start: addDays(thisFriday, -13), end: addDays(thisFriday, -7) },
    nextWindow: { start: addDays(thisFriday, -6), end: asOfDate },
  };
}

// ── Policy-key normalization (verbatim from Apps Script line 504) ──
// Strip commas; if numeric-looking, trunc to int; upper; strip non-alphanumeric;
// if all digits, strip leading zeros. Applied to BOTH sides of the deal↔payment join.
// Installed once per cold start via CREATE OR REPLACE.
let _normalizeFnInstalled = false;
async function ensureNormalizeFn() {
  if (_normalizeFnInstalled) return;
  await query(`
    CREATE OR REPLACE FUNCTION normalize_policy_key(v TEXT)
    RETURNS TEXT AS $$
    DECLARE
      s TEXT;
    BEGIN
      IF v IS NULL THEN RETURN ''; END IF;
      s := TRIM(v);
      IF s = '' THEN RETURN ''; END IF;
      -- strip commas for numeric detection
      s := REPLACE(s, ',', '');
      -- if purely numeric (optional sign, optional decimal, optional exponent), truncate to int
      IF s ~ '^[+-]?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN
        s := SPLIT_PART(s, '.', 1);
        s := REPLACE(s, '+', '');
      END IF;
      -- uppercase + strip non-alphanumeric
      s := REGEXP_REPLACE(UPPER(s), '[^A-Z0-9]', '', 'g');
      -- if all digits, strip leading zeros (preserving a single 0 if only zeros)
      IF s ~ '^[0-9]+$' THEN
        s := REGEXP_REPLACE(s, '^0+', '');
        IF s = '' THEN s := '0'; END IF;
      END IF;
      RETURN s;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);
  _normalizeFnInstalled = true;
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
    admin: Math.round(totalFunding * 100) / 100,
  };
}

// ── Workbook eligibility (all 5 rules from Apps Script, verbatim) ──
// For every WALCO payment in [windowStart, windowEnd]:
//   (1) Bucket check — payment_date ∈ window ✓
//   (2) Skip negative payments
//   (3) Deal must match on normalized policy key (the JOIN)
//   (4) STRICT STATUS: LOWER(deal_status) LIKE '%sold%'
//       Cancelled / Back Out / VOID / Cancel POA / etc. all drop.
//   (5) PYMTS-MADE RULE:
//         eligible IFF (payIsAsOf && pymtsMade=0) OR (payIsBeforeAsOf && pymtsMade=1)
//       where pymtsMade = count of positive payments strictly before asOfDate.
//   (6) NEGATIVE-PAYMENT-LATER SKIP: drop if any negative payment exists on/after payDate.
//   DISTINCT ON contract_no prevents double-counting when 2 payments both qualify.
async function getWindowDeals(
  table: "moxy_deals" | "moxy_home_deals",
  windowStart: string,
  windowEnd: string,
  asOfDate: string
): Promise<{ rows: DealRow[]; totalCount: number }> {
  const eligibilityCTE = `
    WITH pm AS (
      SELECT policy_number, COUNT(*)::int AS pymts_made
      FROM walco_payments
      WHERE payment_amount > 0 AND payment_date < $3
      GROUP BY policy_number
    ),
    eligible_payments AS (
      SELECT wp.policy_number, wp.payment_date
      FROM walco_payments wp
      LEFT JOIN pm ON pm.policy_number = wp.policy_number
      WHERE wp.payment_amount > 0
        AND wp.payment_date BETWEEN $1 AND $2
        AND (
          (wp.payment_date = $3::date AND COALESCE(pm.pymts_made, 0) = 0)
          OR
          (wp.payment_date < $3::date AND COALESCE(pm.pymts_made, 0) = 1)
        )
        AND NOT EXISTS (
          SELECT 1 FROM walco_payments nwp
          WHERE nwp.policy_number = wp.policy_number
            AND nwp.payment_amount < 0
            AND nwp.payment_date >= wp.payment_date
        )
    )`;

  // NOTE: workbook does NOT filter on CustomerPay > 0. Deals with missing
  // financial fields still count toward DealCount (they contribute $0 funding
  // via Math.max(0, ...) in calcFunding). Backfill of missing cust_cost /
  // down_payment / dealer_cost / finance_term in moxy_deals is a Lenovo task
  // — the count is correct here regardless.
  const financialRows = await query(
    `${eligibilityCTE}
     SELECT DISTINCT ON (md.contract_no)
       md.cust_cost, md.dealer_cost, md.down_payment, md.finance_term
     FROM eligible_payments ep
     JOIN ${table} md
       ON normalize_policy_key(md.contract_no) = normalize_policy_key(ep.policy_number)
     WHERE LOWER(md.deal_status) LIKE '%sold%'`,
    [windowStart, windowEnd, asOfDate]
  );

  const countRes = await query(
    `${eligibilityCTE}
     SELECT COUNT(DISTINCT md.contract_no)::int AS count
     FROM eligible_payments ep
     JOIN ${table} md
       ON normalize_policy_key(md.contract_no) = normalize_policy_key(ep.policy_number)
     WHERE LOWER(md.deal_status) LIKE '%sold%'`,
    [windowStart, windowEnd, asOfDate]
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

    await ensureNormalizeFn();

    const windows = getPaymentWindows(today);

    // ── This Friday (payments Sat 2wks ago → prior Fri) ──
    const [thisAutoData, thisHomeData] = await Promise.all([
      getWindowDeals("moxy_deals", windows.thisWindow.start, windows.thisWindow.end, today),
      getWindowDeals("moxy_home_deals", windows.thisWindow.start, windows.thisWindow.end, today),
    ]);

    // ── Next Friday (payments current Sat → today, partial) ──
    const [nextAutoData, nextHomeData] = await Promise.all([
      getWindowDeals("moxy_deals", windows.nextWindow.start, windows.nextWindow.end, today),
      getWindowDeals("moxy_home_deals", windows.nextWindow.start, windows.nextWindow.end, today),
    ]);

    // ── Pipeline (status breakdown of all payments since thisWindow start, no eligibility filter — diagnostic only) ──
    const [pipelineAutoRes, pipelineHomeRes] = await Promise.all([
      query(
        `SELECT deal_status, COUNT(*) as count, COALESCE(SUM(cust_cost), 0) as total_admin
         FROM (
           SELECT DISTINCT ON (md.contract_no) md.deal_status, md.cust_cost
           FROM walco_payments wp
           JOIN moxy_deals md ON normalize_policy_key(md.contract_no) = normalize_policy_key(wp.policy_number)
           WHERE wp.payment_date >= $1
         ) deduped
         GROUP BY deal_status
         ORDER BY count DESC`,
        [windows.thisWindow.start]
      ),
      query(
        `SELECT deal_status, COUNT(*) as count, COALESCE(SUM(cust_cost), 0) as total_admin
         FROM (
           SELECT DISTINCT ON (md.contract_no) md.deal_status, md.cust_cost
           FROM walco_payments wp
           JOIN moxy_home_deals md ON normalize_policy_key(md.contract_no) = normalize_policy_key(wp.policy_number)
           WHERE wp.payment_date >= $1
         ) deduped
         GROUP BY deal_status
         ORDER BY count DESC`,
        [windows.thisWindow.start]
      ),
    ]);

    // ── MTD totals (Sold-only per workbook) ──
    const monthStart = today.slice(0, 7) + "-01";
    const [mtdAutoRes, mtdHomeRes] = await Promise.all([
      query(
        `SELECT COUNT(*) as count, COALESCE(SUM(cust_cost), 0) as total_admin
         FROM (
           SELECT DISTINCT ON (md.contract_no) md.cust_cost
           FROM walco_payments wp
           JOIN moxy_deals md ON normalize_policy_key(md.contract_no) = normalize_policy_key(wp.policy_number)
           WHERE wp.payment_date BETWEEN $1 AND $2
             AND LOWER(md.deal_status) LIKE '%sold%'
         ) deduped`,
        [monthStart, today]
      ),
      query(
        `SELECT COUNT(*) as count, COALESCE(SUM(cust_cost), 0) as total_admin
         FROM (
           SELECT DISTINCT ON (md.contract_no) md.cust_cost
           FROM walco_payments wp
           JOIN moxy_home_deals md ON normalize_policy_key(md.contract_no) = normalize_policy_key(wp.policy_number)
           WHERE wp.payment_date BETWEEN $1 AND $2
             AND LOWER(md.deal_status) LIKE '%sold%'
         ) deduped`,
        [monthStart, today]
      ),
    ]);

    // ── Weekly history (last 8 weeks) — replay workbook rule with each week's Friday as asOfDate ──
    const historyWeeks: {
      weekStart: string; weekEnd: string;
      autoDeals: number; homeDeals: number;
      autoAdmin: number; homeAdmin: number;
    }[] = [];

    for (let w = 0; w < 8; w++) {
      const wkEnd = addDays(windows.thisWindow.end, -7 * w); // Friday
      const wkStart = addDays(wkEnd, -6);                     // Saturday before
      const wkAsOf = addDays(wkEnd, 1);                       // Saturday after (AsOfDate snapshot for historical reconstruction)
      const [haData, hhData] = await Promise.all([
        getWindowDeals("moxy_deals", wkStart, wkEnd, wkAsOf),
        getWindowDeals("moxy_home_deals", wkStart, wkEnd, wkAsOf),
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

    // ── WALCO raw payment totals for the ThisFri window (diagnostic) ──
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
      // table doesn't exist yet
    }

    // ── Build funding aggregates ──
    const thisWeekAutoAgg = aggregateDeals(thisAutoData.rows);
    const thisWeekHomeAgg = aggregateDeals(thisHomeData.rows);
    const nextWeekAutoAgg = aggregateDeals(nextAutoData.rows);
    const nextWeekHomeAgg = aggregateDeals(nextHomeData.rows);

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

    void url; // keep for future query params (e.g. ?asof=)

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
