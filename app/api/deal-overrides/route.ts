import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS deal_overrides (
      id SERIAL PRIMARY KEY,
      contract_no TEXT NOT NULL,
      customer_id TEXT,
      original_owner TEXT,
      corrected_owner TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(contract_no)
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_overrides_cid
    ON deal_overrides(customer_id)
    WHERE customer_id IS NOT NULL AND customer_id != ''
  `);
}

export async function GET() {
  try {
    await ensureTable();
    const result = await query(`SELECT contract_no, customer_id, original_owner, corrected_owner, created_at FROM deal_overrides ORDER BY created_at DESC`);
    return NextResponse.json(result.rows);
  } catch (err) {
    console.error("[deal-overrides] GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureTable();
    const body = await req.json();
    const overrides: { contract_no: string; customer_id?: string; original_owner?: string; corrected_owner: string }[] = body.overrides;

    if (!Array.isArray(overrides) || overrides.length === 0) {
      return NextResponse.json({ error: "overrides array is required" }, { status: 400 });
    }

    let inserted = 0;
    for (const o of overrides) {
      if (!o.contract_no || !o.corrected_owner) continue;
      await query(
        `INSERT INTO deal_overrides (contract_no, customer_id, original_owner, corrected_owner)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (contract_no) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           original_owner = EXCLUDED.original_owner,
           corrected_owner = EXCLUDED.corrected_owner,
           created_at = NOW()`,
        [o.contract_no, o.customer_id || null, o.original_owner || null, o.corrected_owner]
      );
      inserted++;
    }

    return NextResponse.json({ success: true, inserted });
  } catch (err) {
    console.error("[deal-overrides] POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
