import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";

export async function GET() {
  try {
    // Check if cs_outbound_calls table exists and has data
    const tableCheck = await query(
      `SELECT COUNT(*) as count FROM cs_outbound_calls`
    ).catch(() => ({ rows: [{ count: "TABLE DOES NOT EXIST" }] }));

    const sample = await query(
      `SELECT phone, call_date, agent_name FROM cs_outbound_calls ORDER BY call_date DESC LIMIT 10`
    ).catch(() => ({ rows: [] }));

    // Check a sample PBS phone normalized
    const pbsSample = await query(
      `SELECT main_phone, home_phone FROM cs_past_due_accounts WHERE main_phone != '' LIMIT 5`
    );
    const pbsPhones = pbsSample.rows.map((r: Record<string, string>) => {
      const raw = r.main_phone || "";
      const digits = raw.replace(/\D/g, "");
      const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
      return { raw, normalized };
    });

    return NextResponse.json({
      ok: true,
      outboundCount: tableCheck.rows[0].count,
      outboundSample: sample.rows,
      pbsPhoneSample: pbsPhones,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
