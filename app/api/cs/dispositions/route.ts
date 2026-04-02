import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";

export async function GET() {
  try {
    const result = await query(
      "SELECT id, label, is_carryover FROM cs_disposition_options ORDER BY sort_order"
    );
    return NextResponse.json({ ok: true, dispositions: result.rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
