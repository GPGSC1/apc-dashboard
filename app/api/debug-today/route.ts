import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";
import { todayLocal } from "../../../lib/date-utils";

export async function GET() {
  const today = todayLocal();

  // Same dedup logic as sales-data
  const deduped = await query(
    `SELECT DISTINCT ON (customer_id || '|' || contract_no)
       customer_id, contract_no, first_name, last_name, deal_status, sold_date,
       owner, salesperson, campaign, promo_code
     FROM moxy_deals d
     WHERE sold_date = $1
       AND deal_status = 'Sold'
       AND NOT (
         (contract_no IS NULL OR contract_no = '')
         AND EXISTS (
           SELECT 1 FROM moxy_deals d2
           WHERE d2.customer_id = d.customer_id
             AND d2.deal_status = d.deal_status
             AND d2.contract_no IS NOT NULL AND d2.contract_no != ''
             AND d2.sold_date = $1
         )
       )
     ORDER BY customer_id || '|' || contract_no, sold_date DESC`,
    [today]
  );

  // All raw rows today
  const raw = await query(
    `SELECT customer_id, contract_no, first_name, last_name, deal_status,
       owner, salesperson, campaign, promo_code
     FROM moxy_deals
     WHERE sold_date = $1
     ORDER BY last_name, first_name`,
    [today]
  );

  const rawSold = raw.rows.filter((r: any) => r.deal_status === 'Sold');
  const empties = rawSold.filter((r: any) => !r.contract_no?.trim());

  // Customer IDs that have BOTH empty and real contract for Sold status
  const cidGroups: Record<string, any[]> = {};
  for (const r of rawSold) {
    const cid = r.customer_id;
    if (!cidGroups[cid]) cidGroups[cid] = [];
    cidGroups[cid].push(r);
  }
  const dupedCids = Object.entries(cidGroups).filter(([, rows]) => rows.length > 1);

  return NextResponse.json({
    today,
    dedupedCount: deduped.rows.length,
    rawTotalCount: raw.rows.length,
    rawSoldCount: rawSold.rows.length,
    emptyContracts: empties,
    duplicateCustomerIds: dupedCids.map(([cid, rows]) => ({
      cid,
      count: rows.length,
      rows: rows.map((r: any) => ({
        contract_no: r.contract_no || '(empty)',
        name: `${r.first_name} ${r.last_name}`,
        owner: r.owner,
        status: r.deal_status,
      })),
    })),
  });
}
