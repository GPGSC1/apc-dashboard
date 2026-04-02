import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";

export async function GET() {
  try {
    const count = await query("SELECT COUNT(*) as c FROM cs_outbound_calls").catch(() => ({ rows: [{ c: "TABLE MISSING" }] }));
    const sample = await query("SELECT phone, call_date, agent_name FROM cs_outbound_calls ORDER BY call_date DESC LIMIT 10").catch(() => ({ rows: [] }));

    // Check matches against cs_past_due_accounts
    const matches = await query(`
      SELECT a.insured_name, a.main_phone, a.home_phone, o.call_date as last_called, o.agent_name as called_by
      FROM cs_past_due_accounts a
      JOIN cs_outbound_calls o ON (
        o.phone = REGEXP_REPLACE(a.main_phone, '[^0-9]', '', 'g')
        OR o.phone = REGEXP_REPLACE(a.home_phone, '[^0-9]', '', 'g')
      )
      WHERE a.scrub_date = '2026-04-02'
      ORDER BY o.call_date DESC
      LIMIT 10
    `).catch((e) => ({ rows: [], _error: String(e) }));

    return NextResponse.json({
      ok: true,
      outboundCount: count.rows[0].c,
      outboundSample: sample.rows,
      matchedAccounts: matches.rows,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
