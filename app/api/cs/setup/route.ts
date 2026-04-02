// Temporary setup route — creates CS tables in Neon Postgres
// DELETE THIS FILE after first successful run

import { NextResponse } from "next/server";
import { getPool } from "../../../../lib/db/connection";

export async function POST() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_reps (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const reps = ["Adrian","Ash","Danielle","David","Steven","Rachel","Katelyn","Mark","Josh","Mallory"];
    for (const r of reps) {
      await client.query("INSERT INTO cs_reps (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [r]);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_rep_schedule (
        rep_id INTEGER NOT NULL REFERENCES cs_reps(id),
        work_date DATE NOT NULL,
        is_working BOOLEAN DEFAULT true,
        PRIMARY KEY (rep_id, work_date)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_scrub_uploads (
        id SERIAL PRIMARY KEY,
        uploaded_at TIMESTAMPTZ DEFAULT NOW(),
        scrub_date DATE NOT NULL,
        filename VARCHAR(255),
        raw_row_count INTEGER DEFAULT 0,
        filtered_row_count INTEGER DEFAULT 0,
        carryover_count INTEGER DEFAULT 0,
        final_row_count INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_past_due_accounts (
        id SERIAL PRIMARY KEY,
        scrub_date DATE NOT NULL,
        account_number VARCHAR(50) NOT NULL,
        insured_name VARCHAR(200),
        policy_number VARCHAR(50),
        agent_entity VARCHAR(100),
        installments_made INTEGER DEFAULT 0,
        next_due_date DATE,
        sched_cxl_date DATE,
        bill_hold VARCHAR(50),
        billing_method VARCHAR(50),
        amount_due NUMERIC(10,2) DEFAULT 0,
        main_phone VARCHAR(20),
        work_phone VARCHAR(20),
        customer_email VARCHAR(200),
        state VARCHAR(10),
        assigned_rep VARCHAR(100),
        dispo_1 VARCHAR(100),
        dispo_2 VARCHAR(100),
        dispo_date DATE,
        email_sent BOOLEAN DEFAULT false,
        is_carryover BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_cs_past_due_scrub_date ON cs_past_due_accounts(scrub_date)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_cs_past_due_account ON cs_past_due_accounts(account_number)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_cs_past_due_rep ON cs_past_due_accounts(assigned_rep)");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_past_due_unique ON cs_past_due_accounts(scrub_date, account_number)");

    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_scrub_backups (
        id SERIAL PRIMARY KEY,
        backup_date DATE NOT NULL,
        original_scrub_date DATE NOT NULL,
        account_number VARCHAR(50) NOT NULL,
        insured_name VARCHAR(200),
        policy_number VARCHAR(50),
        assigned_rep VARCHAR(100),
        dispo_1 VARCHAR(100),
        dispo_2 VARCHAR(100),
        dispo_date DATE,
        amount_due NUMERIC(10,2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_cs_backup_date ON cs_scrub_backups(backup_date)");

    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_collections_log (
        id SERIAL PRIMARY KEY,
        log_date DATE NOT NULL,
        rep_name VARCHAR(100) NOT NULL,
        collections_count INTEGER DEFAULT 0,
        zero_pays INTEGER DEFAULT 0,
        amt_collected NUMERIC(10,2) DEFAULT 0,
        outbound_total INTEGER DEFAULT 0,
        outbound_answered INTEGER DEFAULT 0,
        outbound_unanswered INTEGER DEFAULT 0,
        inbound_total INTEGER DEFAULT 0,
        inbound_dropped INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_collections_log_unique ON cs_collections_log(log_date, rep_name)");

    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_disposition_options (
        id SERIAL PRIMARY KEY,
        label VARCHAR(100) NOT NULL UNIQUE,
        is_carryover BOOLEAN DEFAULT false,
        sort_order INTEGER DEFAULT 0
      )
    `);
    const dispos: [string, boolean, number][] = [
      ["Follow Up", true, 1], ["Scheduled PDP", true, 2], ["Mailed Check", true, 3], ["Mailed C.", true, 4],
      ["Paid", false, 5], ["Promise to Pay", false, 6], ["No Answer", false, 7], ["Left Voicemail", false, 8],
      ["Wrong Number", false, 9], ["Refused", false, 10], ["Cancelled", false, 11],
    ];
    for (const [label, isCarryover, sortOrder] of dispos) {
      await client.query(
        "INSERT INTO cs_disposition_options (label, is_carryover, sort_order) VALUES ($1, $2, $3) ON CONFLICT (label) DO NOTHING",
        [label, isCarryover, sortOrder]
      );
    }

    await client.query("COMMIT");

    // Verify
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE tablename LIKE 'cs_%' ORDER BY tablename");
    const repsResult = await client.query("SELECT name FROM cs_reps ORDER BY name");

    return NextResponse.json({
      ok: true,
      message: "CS tables created and seeded",
      tables: tables.rows.map((r: { tablename: string }) => r.tablename),
      reps: repsResult.rows.map((r: { name: string }) => r.name),
    });
  } catch (e) {
    await client.query("ROLLBACK");
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  } finally {
    client.release();
  }
}
