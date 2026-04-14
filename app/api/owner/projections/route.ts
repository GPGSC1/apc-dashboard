import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";

// ── Fee & Reserve Schedule (static, tiered by term in months) ──
const FEE_SCHEDULE = [
  { minTerm: 1, maxTerm: 24, feeRate: 0.0975, reserveRate: 0.55 },
  { minTerm: 25, maxTerm: 36, feeRate: 0.1075, reserveRate: 0.50 },
  { minTerm: 37, maxTerm: 48, feeRate: 0.1175, reserveRate: 0.45 },
  { minTerm: 49, maxTerm: 60, feeRate: 0.1275, reserveRate: 0.40 },
  { minTerm: 61, maxTerm: 999, feeRate: 0.1475, reserveRate: 0.35 },
];

function getFeeReserve(termMonths: number) {
  const tier = FEE_SCHEDULE.find(
    (t) => termMonths >= t.minTerm && termMonths <= t.maxTerm
  );
  return tier || { feeRate: 0.1275, reserveRate: 0.40 }; // default to 49-60 tier
}

// ── Date helpers ──
function getWeekRange(refDate: string): { start: string; end: string } {
  // Returns Mon–Fri range for the week containing refDate
  const d = new Date(refDate + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ...
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
  const daysToFri = dow <= 5 ? 5 - dow : 6; // if sat, next fri is 6 days
  if (daysToFri === 0) return refDate; // already friday
  const fri = new Date(d);
  fri.setUTCDate(d.getUTCDate() + daysToFri);
  return fri.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const today = todayLocal();

    // ── This week & next week ranges ──
    const thisWeek = getWeekRange(today);
    const nextWeekStart = addDays(thisWeek.end, 3); // Monday after this Friday
    const nextWeek = getWeekRange(nextWeekStart);
    const thisFriday = getNextFriday(today);
    const nextFriday = addDays(thisFriday, 7);

    // ── 1. Deal counts & admin totals for this week ──
    const thisWeekAutoRes = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(admin), 0) as total_admin
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [thisWeek.start, thisWeek.end]
    );
    const thisWeekHomeRes = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(admin::numeric), 0) as total_admin
       FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [thisWeek.start, thisWeek.end]
    );

    // ── 2. Deal counts & admin totals for next week ──
    const nextWeekAutoRes = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(admin), 0) as total_admin
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [nextWeek.start, nextWeek.end]
    );
    const nextWeekHomeRes = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(admin::numeric), 0) as total_admin
       FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [nextWeek.start, nextWeek.end]
    );

    // ── 3. Pipeline: deals by status ──
    const pipelineAutoRes = await query(
      `SELECT deal_status, COUNT(*) as count, COALESCE(SUM(admin), 0) as total_admin
       FROM moxy_deals
       WHERE sold_date >= $1
       GROUP BY deal_status
       ORDER BY count DESC`,
      [thisWeek.start]
    );
    const pipelineHomeRes = await query(
      `SELECT deal_status, COUNT(*) as count, COALESCE(SUM(admin::numeric), 0) as total_admin
       FROM moxy_home_deals
       WHERE sold_date >= $1
       GROUP BY deal_status
       ORDER BY count DESC`,
      [thisWeek.start]
    );

    // ── 4. MTD totals ──
    const monthStart = today.slice(0, 7) + "-01";
    const mtdAutoRes = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(admin), 0) as total_admin
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [monthStart, today]
    );
    const mtdHomeRes = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(admin::numeric), 0) as total_admin
       FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')`,
      [monthStart, today]
    );

    // ── 5. Weekly history (last 8 weeks) ──
    const historyWeeks: { weekStart: string; weekEnd: string; autoDeals: number; homeDeals: number; autoAdmin: number; homeAdmin: number }[] = [];
    for (let w = 0; w < 8; w++) {
      const wStart = addDays(thisWeek.start, -7 * w);
      const wk = getWeekRange(wStart);
      const ha = await query(
        `SELECT COUNT(*) as count, COALESCE(SUM(admin), 0) as total_admin
         FROM moxy_deals
         WHERE sold_date BETWEEN $1 AND $2
           AND deal_status NOT IN ('Back Out', 'VOID', '')`,
        [wk.start, wk.end]
      );
      const hh = await query(
        `SELECT COUNT(*) as count, COALESCE(SUM(admin::numeric), 0) as total_admin
         FROM moxy_home_deals
         WHERE sold_date BETWEEN $1 AND $2
           AND deal_status NOT IN ('Back Out', 'VOID', '')`,
        [wk.start, wk.end]
      );
      historyWeeks.push({
        weekStart: wk.start,
        weekEnd: wk.end,
        autoDeals: Number(ha.rows[0].count),
        homeDeals: Number(hh.rows[0].count),
        autoAdmin: Number(ha.rows[0].total_admin),
        homeAdmin: Number(hh.rows[0].total_admin),
      });
    }

    // ── 6. WALCO payments (when available) ──
    let walcoTotal = 0;
    let walcoCount = 0;
    try {
      const walcoRes = await query(
        `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
         FROM walco_payments
         WHERE payment_date BETWEEN $1 AND $2`,
        [thisWeek.start, thisWeek.end]
      );
      walcoTotal = Number(walcoRes.rows[0].total);
      walcoCount = Number(walcoRes.rows[0].count);
    } catch {
      // walco_payments table doesn't exist yet — that's expected
    }

    // ── Build response ──
    // funding = admin for now. Will be replaced with real funding calc
    // once we have custCost/dealerCost from Moxy + WALCO payments from Lenovo.
    function buildLine(count: number, admin: number) {
      const deals = count;
      const funding = admin; // placeholder: will become real funding amount
      const avgFunding = deals > 0 ? Math.round(funding / deals) : 0;
      return { deals, admin, funding, avgFunding };
    }

    const thisWeekAuto = buildLine(Number(thisWeekAutoRes.rows[0].count), Number(thisWeekAutoRes.rows[0].total_admin));
    const thisWeekHome = buildLine(Number(thisWeekHomeRes.rows[0].count), Number(thisWeekHomeRes.rows[0].total_admin));
    const nextWeekAuto = buildLine(Number(nextWeekAutoRes.rows[0].count), Number(nextWeekAutoRes.rows[0].total_admin));
    const nextWeekHome = buildLine(Number(nextWeekHomeRes.rows[0].count), Number(nextWeekHomeRes.rows[0].total_admin));

    function buildTotal(a: ReturnType<typeof buildLine>, h: ReturnType<typeof buildLine>) {
      const deals = a.deals + h.deals;
      const admin = a.admin + h.admin;
      const funding = a.funding + h.funding;
      const avgFunding = deals > 0 ? Math.round(funding / deals) : 0;
      return { deals, admin, funding, avgFunding };
    }

    return NextResponse.json({
      ok: true,
      today,
      thisFriday,
      nextFriday,
      thisWeek: {
        range: thisWeek,
        auto: thisWeekAuto,
        home: thisWeekHome,
        total: buildTotal(thisWeekAuto, thisWeekHome),
      },
      nextWeek: {
        range: nextWeek,
        auto: nextWeekAuto,
        home: nextWeekHome,
        total: buildTotal(nextWeekAuto, nextWeekHome),
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
