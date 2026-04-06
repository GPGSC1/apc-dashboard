import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";

export async function GET() {
  const from = "2026-04-01";
  const to = "2026-04-05";

  // Our sold deals (with empty-contract dedup + deal_status match)
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

  // ALL raw rows for the period (no dedup at all)
  const rawAll = await query(
    `SELECT customer_id, contract_no, deal_status, first_name, last_name,
       sold_date, owner, promo_code, salesperson
     FROM moxy_deals
     WHERE sold_date BETWEEN $1 AND $2
       AND deal_status != ''
     ORDER BY last_name, first_name, contract_no`,
    [from, to]
  );

  // Status breakdown
  const statusBreakdown = await query(
    `SELECT deal_status, COUNT(*) as cnt FROM moxy_deals
     WHERE sold_date BETWEEN $1 AND $2 AND deal_status != ''
     GROUP BY deal_status ORDER BY cnt DESC`,
    [from, to]
  );

  // Contract number lists for easy diff
  const soldContractNos = ourSold.rows
    .map((r: any) => r.contract_no?.trim() || '')
    .filter((c: string) => c !== '')
    .sort();

  const allContractNos = ourAll.rows
    .map((r: any) => r.contract_no?.trim() || '')
    .filter((c: string) => c !== '')
    .sort();

  // Empty contract deals
  const emptyContracts = ourAll.rows.filter((r: any) => !r.contract_no?.trim());

  // Deals with "Cancelled" status (check for trailing spaces)
  const cancelledDeals = rawAll.rows.filter((r: any) =>
    r.deal_status?.toLowerCase().includes('cancel')
  );

  return NextResponse.json({
    counts: {
      ourSold: ourSold.rows.length,
      ourAll: ourAll.rows.length,
      rawRowsInDB: rawAll.rows.length,
      soldContractCount: soldContractNos.length,
      allContractCount: allContractNos.length,
    },
    statusBreakdown: statusBreakdown.rows,
    emptyContracts,
    cancelledDeals: cancelledDeals.map((r: any) => ({
      customer_id: r.customer_id,
      contract_no: r.contract_no,
      deal_status: r.deal_status,
      deal_status_repr: JSON.stringify(r.deal_status),
      name: `${r.first_name} ${r.last_name}`,
    })),
    soldContractNos,
    allContractNos,
    // Include sold deals with customer_id for the empty-contract cases
    soldDealsWithCid: ourSold.rows.map((r: any) => ({
      cid: r.customer_id,
      cn: r.contract_no || '',
      status: r.deal_status,
      name: `${r.first_name} ${r.last_name}`,
    })),
  });
}
