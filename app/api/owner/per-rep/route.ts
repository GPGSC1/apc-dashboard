import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { ensureSalesViews } from "../../../../lib/db/ensure-sales-views";
import { todayLocal } from "../../../../lib/date-utils";

// ── Fee & Reserve Schedule (mirrors projections route) ──
const FEE_SCHEDULE = [
  { minTerm: 1, maxTerm: 12, feeRate: 0.0975, reserveRate: 0.35 },
  { minTerm: 13, maxTerm: 15, feeRate: 0.1075, reserveRate: 0.40 },
  { minTerm: 16, maxTerm: 18, feeRate: 0.1275, reserveRate: 0.45 },
  { minTerm: 19, maxTerm: 24, feeRate: 0.1475, reserveRate: 0.55 },
];

function getFeeReserve(termMonths: number) {
  const tier = FEE_SCHEDULE.find((t) => termMonths >= t.minTerm && termMonths <= t.maxTerm);
  return tier || { feeRate: 0.1275, reserveRate: 0.45 };
}

function calcFunding(custCost: number, downPayment: number, dealerCost: number, term: number): number {
  if (!custCost || custCost <= 0) return 0;
  const { feeRate, reserveRate } = getFeeReserve(term);
  const financed = custCost - downPayment;
  const afterFee = financed * (1 - feeRate);
  const afterAdmin = afterFee - dealerCost;
  const fundingAmount = afterAdmin * (1 - reserveRate);
  return Math.max(0, fundingAmount);
}

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
      s := REPLACE(s, ',', '');
      IF s ~ '^[+-]?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN
        s := SPLIT_PART(s, '.', 1);
        s := REPLACE(s, '+', '');
      END IF;
      s := REGEXP_REPLACE(UPPER(s), '[^A-Z0-9]', '', 'g');
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

interface DealRow {
  owner: string;
  contract_no: string;
  line: "auto" | "home";
  cust_cost: number | null;
  down_payment: number | null;
  dealer_cost: number | null;
  finance_term: number | null;
  norm_key: string;
}

interface RepStats {
  owner: string;
  autoDeals: number;
  homeDeals: number;
  totalDeals: number;
  autoFunded: number;
  homeFunded: number;
  totalFunded: number;
  potentialFunding: number;
  actualFunding: number;
  fundingPct: number;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const today = todayLocal();
    const monthStart = today.slice(0, 7) + "-01";
    const start = url.searchParams.get("start") || monthStart;
    const end = url.searchParams.get("end") || today;

    await ensureNormalizeFn();
    await ensureSalesViews(); // installs v_moxy_deals_deduped + v_moxy_home_deals_deduped

    // ── Step 1: pre-aggregate the set of "funded" normalized policy keys ──
    // A policy is "funded" if it has at least one positive payment that doesn't
    // have a later (>=) negative payment. This collapses the workbook's per-payment
    // pymts-made rule into a per-deal predicate (a deal that ever had a positive
    // payment without a subsequent reversal has triggered WALCO funding).
    //
    // Done in one query, cached as a Set in JS — avoids cross-table normalize_key
    // joins which are ~290x slower.
    const fundedRes = await query(`
      SELECT DISTINCT normalize_policy_key(wp.policy_number) AS k
      FROM walco_payments wp
      WHERE wp.payment_amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM walco_payments nwp
          WHERE nwp.policy_number = wp.policy_number
            AND nwp.payment_amount < 0
            AND nwp.payment_date >= wp.payment_date
        )
    `);
    const fundedKeys = new Set<string>(fundedRes.rows.map((r: { k: string }) => r.k));

    // ── Step 2: pull all Sold deals in date range with normalized key ──
    const dealsRes = await query(`
      SELECT
        TRIM(md.owner) AS owner, md.contract_no, 'auto'::text AS line,
        md.cust_cost, md.down_payment, md.dealer_cost, md.finance_term,
        normalize_policy_key(md.contract_no) AS norm_key
      FROM v_moxy_deals_deduped md
      WHERE LOWER(md.deal_status) LIKE '%sold%'
        AND md.sold_date BETWEEN $1 AND $2
        AND COALESCE(TRIM(md.owner), '') != ''
      UNION ALL
      SELECT
        TRIM(md.owner), md.contract_no, 'home'::text,
        md.cust_cost, md.down_payment, md.dealer_cost, md.finance_term,
        normalize_policy_key(md.contract_no)
      FROM v_moxy_home_deals_deduped md
      WHERE LOWER(md.deal_status) LIKE '%sold%'
        AND md.sold_date BETWEEN $1 AND $2
        AND COALESCE(TRIM(md.owner), '') != ''
    `, [start, end]);

    // ── Step 3: aggregate by owner ──
    const repMap = new Map<string, RepStats>();
    for (const r of dealsRes.rows as DealRow[]) {
      const key = r.owner;
      const stats = repMap.get(key) || {
        owner: key,
        autoDeals: 0, homeDeals: 0, totalDeals: 0,
        autoFunded: 0, homeFunded: 0, totalFunded: 0,
        potentialFunding: 0, actualFunding: 0, fundingPct: 0,
      };
      const isAuto = r.line === "auto";
      const dealFunding = calcFunding(
        Number(r.cust_cost) || 0,
        Number(r.down_payment) || 0,
        Number(r.dealer_cost) || 0,
        Number(r.finance_term) || 0
      );
      stats.totalDeals++;
      stats.potentialFunding += dealFunding;
      if (isAuto) stats.autoDeals++; else stats.homeDeals++;
      if (fundedKeys.has(r.norm_key)) {
        stats.totalFunded++;
        stats.actualFunding += dealFunding;
        if (isAuto) stats.autoFunded++; else stats.homeFunded++;
      }
      repMap.set(key, stats);
    }

    const reps: RepStats[] = [];
    for (const stats of repMap.values()) {
      stats.potentialFunding = Math.round(stats.potentialFunding * 100) / 100;
      stats.actualFunding = Math.round(stats.actualFunding * 100) / 100;
      stats.fundingPct = stats.potentialFunding > 0
        ? Math.round((stats.actualFunding / stats.potentialFunding) * 1000) / 10
        : 0;
      reps.push(stats);
    }
    reps.sort((a, b) => b.actualFunding - a.actualFunding);

    const totals = reps.reduce(
      (acc, r) => {
        acc.autoDeals += r.autoDeals;
        acc.homeDeals += r.homeDeals;
        acc.totalDeals += r.totalDeals;
        acc.autoFunded += r.autoFunded;
        acc.homeFunded += r.homeFunded;
        acc.totalFunded += r.totalFunded;
        acc.potentialFunding += r.potentialFunding;
        acc.actualFunding += r.actualFunding;
        return acc;
      },
      {
        autoDeals: 0, homeDeals: 0, totalDeals: 0,
        autoFunded: 0, homeFunded: 0, totalFunded: 0,
        potentialFunding: 0, actualFunding: 0,
      }
    );
    const totalsFundingPct = totals.potentialFunding > 0
      ? Math.round((totals.actualFunding / totals.potentialFunding) * 1000) / 10
      : 0;

    return NextResponse.json({
      ok: true,
      today,
      range: { start, end },
      reps,
      totals: {
        ...totals,
        potentialFunding: Math.round(totals.potentialFunding * 100) / 100,
        actualFunding: Math.round(totals.actualFunding * 100) / 100,
        fundingPct: totalsFundingPct,
      },
    });
  } catch (e) {
    console.error("Owner per-rep error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
