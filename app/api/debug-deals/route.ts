import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";

export async function GET() {
  const from = "2026-04-01";
  const to = "2026-04-05";

  // Our sold deals
  const ourSold = await query(
    `SELECT DISTINCT ON (customer_id || '|' || contract_no)
       customer_id, contract_no, salesperson, owner, first_name, last_name,
       sold_date, deal_status, promo_code, campaign
     FROM moxy_deals d
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status = 'Sold'
       AND NOT (
         (contract_no IS NULL OR contract_no = '')
         AND EXISTS (
           SELECT 1 FROM moxy_deals d2
           WHERE d2.customer_id = d.customer_id
             AND d2.deal_status = d.deal_status
             AND d2.contract_no IS NOT NULL AND d2.contract_no != ''
             AND d2.sold_date BETWEEN $1 AND $2
         )
       )
     ORDER BY customer_id || '|' || contract_no, sold_date DESC`,
    [from, to]
  );

  // Our all-status deals
  const ourAll = await query(
    `SELECT DISTINCT ON (customer_id || '|' || contract_no)
       customer_id, contract_no, salesperson, owner, first_name, last_name,
       sold_date, deal_status, promo_code, campaign
     FROM moxy_deals d
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status != ''
       AND NOT (
         (contract_no IS NULL OR contract_no = '')
         AND EXISTS (
           SELECT 1 FROM moxy_deals d2
           WHERE d2.customer_id = d.customer_id
             AND d2.deal_status = d.deal_status
             AND d2.contract_no IS NOT NULL AND d2.contract_no != ''
             AND d2.sold_date BETWEEN $1 AND $2
         )
       )
     ORDER BY customer_id || '|' || contract_no, sold_date DESC`,
    [from, to]
  );

  // Check for deals with empty contract_no
  const emptyContracts = await query(
    `SELECT customer_id, contract_no, deal_status, first_name, last_name, sold_date, owner
     FROM moxy_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND (contract_no IS NULL OR contract_no = '')
       AND deal_status != ''`,
    [from, to]
  );

  // All raw deals (no dedup) to see everything in DB
  const rawAll = await query(
    `SELECT customer_id, contract_no, deal_status, first_name, last_name, sold_date, owner, promo_code
     FROM moxy_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status != ''
     ORDER BY last_name, first_name`,
    [from, to]
  );

  return NextResponse.json({
    counts: {
      ourSold: ourSold.rows.length,
      ourAll: ourAll.rows.length,
      rawRowsInDB: rawAll.rows.length,
    },
    emptyContracts: emptyContracts.rows,
    statusBreakdown: await (async () => {
      const r = await query(
        `SELECT deal_status, COUNT(*) as cnt FROM moxy_deals
         WHERE sold_date BETWEEN $1 AND $2 AND deal_status != ''
         GROUP BY deal_status ORDER BY cnt DESC`,
        [from, to]
      );
      return r.rows;
    })(),
    // Output all deals sorted by contract_no for easy comparison
    allSoldDeals: ourSold.rows,
  });
}
