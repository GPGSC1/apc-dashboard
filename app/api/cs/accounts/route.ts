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

    // Normalize phones and look up last outbound call timestamps per phone
    const normPhone = (raw: string): string => {
      const digits = String(raw || "").replace(/\D/g, "");
      return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    };

    // Build maps: normalized phone -> account IDs, and which phone field it came from
    const phone1Map = new Map<string, number[]>(); // normalized main_phone -> account ids
    const phone2Map = new Map<string, number[]>(); // normalized work_phone -> account ids
    const phone3Map = new Map<string, number[]>(); // normalized mobile_phone -> account ids
    const allPhones = new Set<string>();

    for (const row of result.rows) {
      if (row.main_phone) {
        const n = normPhone(row.main_phone);
        if (n.length === 10) {
          if (!phone1Map.has(n)) phone1Map.set(n, []);
          phone1Map.get(n)!.push(row.id);
          allPhones.add(n);
        }
      }
      if (row.work_phone) {
        const n = normPhone(row.work_phone);
        if (n.length === 10) {
          if (!phone2Map.has(n)) phone2Map.set(n, []);
          phone2Map.get(n)!.push(row.id);
          allPhones.add(n);
        }
      }
      if (row.mobile_phone) {
        const n = normPhone(row.mobile_phone);
        if (n.length === 10) {
          if (!phone3Map.has(n)) phone3Map.set(n, []);
          phone3Map.get(n)!.push(row.id);
          allPhones.add(n);
        }
      }
    }

    // Query last outbound call timestamp for all phones in one shot
    const lastCalledPhone1 = new Map<number, string>(); // accountId -> timestamp
    const lastCalledPhone2 = new Map<number, string>(); // accountId -> timestamp
    const lastCalledPhone3 = new Map<number, string>(); // accountId -> timestamp (mobile)
    if (allPhones.size > 0) {
      const phoneArr = [...allPhones];
      const obResult = await query(
        `SELECT phone, MAX(call_time)::TEXT as last_called FROM cs_outbound_calls WHERE phone = ANY($1) GROUP BY phone`,
        [phoneArr]
      );
      for (const row of obResult.rows) {
        // Map to phone 1 accounts (main_phone)
        const p1Ids = phone1Map.get(row.phone) || [];
        for (const id of p1Ids) {
          const existing = lastCalledPhone1.get(id);
          if (!existing || row.last_called > existing) {
            lastCalledPhone1.set(id, row.last_called);
          }
        }
        // Map to phone 2 accounts (work_phone)
        const p2Ids = phone2Map.get(row.phone) || [];
        for (const id of p2Ids) {
          const existing = lastCalledPhone2.get(id);
          if (!existing || row.last_called > existing) {
            lastCalledPhone2.set(id, row.last_called);
          }
        }
        // Map to phone 3 accounts (mobile_phone)
        const p3Ids = phone3Map.get(row.phone) || [];
        for (const id of p3Ids) {
          const existing = lastCalledPhone3.get(id);
          if (!existing || row.last_called > existing) {
            lastCalledPhone3.set(id, row.last_called);
          }
        }
      }
    }

    // Merge last_called per phone into accounts
    const accounts = result.rows.map((row: Record<string, unknown>) => ({
      ...row,
      last_called_phone1: lastCalledPhone1.get(row.id as number) || null,
      last_called_phone2: lastCalledPhone2.get(row.id as number) || null,
      last_called_mobile: lastCalledPhone3.get(row.id as number) || null,
    }));

    // Get upload metadata for this date
    const uploadResult = await query(
      "SELECT * FROM cs_scrub_uploads WHERE scrub_date = $1 ORDER BY uploaded_at DESC LIMIT 1",
      [date]
    );

    return NextResponse.json({
      ok: true,
      accounts,
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
