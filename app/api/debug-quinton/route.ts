import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";
import { todayLocal } from "../../../lib/date-utils";

export async function GET() {
  const today = todayLocal();

  // Quinton's home deals today
  const deals = await query(
    `SELECT customer_id, contract_no, first_name, last_name, home_phone, mobile_phone,
            sold_date, deal_status, campaign, promo_code, owner, salesperson
     FROM moxy_home_deals
     WHERE sold_date = $1
       AND (LOWER(owner) LIKE '%lovett%' OR LOWER(salesperson) LIKE '%lovett%')`,
    [today]
  );

  const results = [];
  for (const d of deals.rows) {
    const hp = (d.home_phone ?? "").replace(/\D/g, "").slice(-10);
    const mp = (d.mobile_phone ?? "").replace(/\D/g, "").slice(-10);
    const phones = [hp, mp].filter(p => p.length === 10);

    const phoneHistory: Record<string, unknown[]> = {};
    for (const p of phones) {
      const hist = await query(
        `SELECT phone, queue, call_date, dest_name, status
         FROM queue_calls
         WHERE phone = $1
         ORDER BY call_date DESC
         LIMIT 20`,
        [p]
      );
      phoneHistory[p] = hist.rows;
    }

    results.push({ deal: d, phoneHistory });
  }

  return NextResponse.json({ today, dealsFound: deals.rows.length, results });
}
