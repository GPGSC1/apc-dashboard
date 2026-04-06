import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";

export async function GET() {
  const from = "2026-04-01";
  const to = "2026-04-05";

  // Home deals - all statuses
  const homeAll = await query(
    `SELECT DISTINCT ON (customer_id || '|' || contract_no)
       customer_id, contract_no, salesperson, owner, first_name, last_name,
       home_phone, mobile_phone, sold_date, deal_status, campaign, promo_code
     FROM moxy_home_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status != ''
     ORDER BY customer_id || '|' || contract_no, sold_date DESC`,
    [from, to]
  );

  // Home deals - sold only
  const homeSold = await query(
    `SELECT DISTINCT ON (customer_id || '|' || contract_no)
       customer_id, contract_no, salesperson, owner, first_name, last_name,
       home_phone, mobile_phone, sold_date, deal_status, campaign, promo_code
     FROM moxy_home_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status = 'Sold'
     ORDER BY customer_id || '|' || contract_no, sold_date DESC`,
    [from, to]
  );

  // Check for potential dupes: same customer name + phone appearing multiple times
  const possibleDupes = await query(
    `SELECT first_name, last_name, home_phone, mobile_phone,
       COUNT(*) as cnt,
       array_agg(DISTINCT contract_no) as contracts,
       array_agg(DISTINCT customer_id) as cust_ids,
       array_agg(DISTINCT deal_status) as statuses
     FROM moxy_home_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status != ''
     GROUP BY first_name, last_name, home_phone, mobile_phone
     HAVING COUNT(*) > 1
     ORDER BY cnt DESC`,
    [from, to]
  );

  // Check for deals with empty/null contract_no (could bypass dedup)
  const emptyContracts = await query(
    `SELECT customer_id, contract_no, first_name, last_name, deal_status, sold_date
     FROM moxy_home_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status != ''
       AND (contract_no IS NULL OR contract_no = '')
     ORDER BY sold_date`,
    [from, to]
  );

  // Status breakdown
  const statusBreakdown = await query(
    `SELECT deal_status, COUNT(*) as cnt
     FROM moxy_home_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status != ''
     GROUP BY deal_status
     ORDER BY cnt DESC`,
    [from, to]
  );

  // Auto deals for comparison
  const autoAll = await query(
    `SELECT COUNT(*) as cnt FROM (
       SELECT DISTINCT ON (customer_id || '|' || contract_no) *
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2 AND deal_status != ''
       ORDER BY customer_id || '|' || contract_no, sold_date DESC
     ) x`,
    [from, to]
  );
  const autoSold = await query(
    `SELECT COUNT(*) as cnt FROM (
       SELECT DISTINCT ON (customer_id || '|' || contract_no) *
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2 AND deal_status = 'Sold'
       ORDER BY customer_id || '|' || contract_no, sold_date DESC
     ) x`,
    [from, to]
  );

  return NextResponse.json({
    dateRange: { from, to },
    counts: {
      homeAll: homeAll.rows.length,
      homeSold: homeSold.rows.length,
      autoAll: parseInt(autoAll.rows[0].cnt),
      autoSold: parseInt(autoSold.rows[0].cnt),
    },
    homeStatusBreakdown: statusBreakdown.rows,
    possibleDupes: { count: possibleDupes.rows.length, rows: possibleDupes.rows },
    emptyContracts: { count: emptyContracts.rows.length, rows: emptyContracts.rows },
    allHomeDeals: homeAll.rows,
  });
}
