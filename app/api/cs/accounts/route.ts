import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date") || todayLocal();
    const rep = url.searchParams.get("rep");

    let sql = `SELECT * FROM cs_past_due_accounts WHERE scrub_date = $1`;
    const params: (string | null)[] = [date];

    if (rep) {
      sql += ` AND assigned_rep = $2`;
      params.push(rep);
    }

    sql += ` ORDER BY assigned_rep, account_number`;

    const result = await query(sql, params);

    // Get upload metadata for this date
    const uploadResult = await query(
      "SELECT * FROM cs_scrub_uploads WHERE scrub_date = $1 ORDER BY uploaded_at DESC LIMIT 1",
      [date]
    );

    return NextResponse.json({
      ok: true,
      accounts: result.rows,
      upload: uploadResult.rows[0] || null,
      date,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { accountId, dispo1, dispo2, dispoDate, emailSent } = body;

    if (!accountId) {
      return NextResponse.json({ ok: false, error: "accountId required" }, { status: 400 });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (dispo1 !== undefined) {
      sets.push(`dispo_1 = $${paramIdx++}`);
      params.push(dispo1);
    }
    if (dispo2 !== undefined) {
      sets.push(`dispo_2 = $${paramIdx++}`);
      params.push(dispo2);
    }
    if (dispoDate !== undefined) {
      sets.push(`dispo_date = $${paramIdx++}`);
      params.push(dispoDate || null);
    }
    if (emailSent !== undefined) {
      sets.push(`email_sent = $${paramIdx++}`);
      params.push(emailSent);
    }

    if (sets.length === 0) {
      return NextResponse.json({ ok: false, error: "No fields to update" }, { status: 400 });
    }

    sets.push(`updated_at = NOW()`);
    params.push(accountId);

    await query(
      `UPDATE cs_past_due_accounts SET ${sets.join(", ")} WHERE id = $${paramIdx}`,
      params
    );

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
