// CS Collections SMS Campaign — Bulk Send Endpoint
// Uses TextMagic's bulk-with-template workflow:
//   1) Ensure custom fields exist
//   2) Upsert contacts with firstName + AmountDue + MissedPaymentDate (parallel)
//   3) ONE bulk send call referencing all contact IDs — server-side merge
// Logs the campaign + per-recipient contact-sync result for audit.

import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";
import {
  sendCampaignBulk,
  type TextRecipient,
} from "../../../../lib/cs/text-campaign";

export const maxDuration = 300;

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS cs_text_campaigns (
      id SERIAL PRIMARY KEY,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      scrub_date DATE NOT NULL,
      template TEXT NOT NULL,
      total_recipients INTEGER NOT NULL DEFAULT 0,
      total_sent INTEGER NOT NULL DEFAULT 0,
      total_failed INTEGER NOT NULL DEFAULT 0,
      sent_by TEXT,
      textmagic_session_id BIGINT,
      textmagic_bulk_id BIGINT
    )
  `);
  // If the table already exists from prior versions, add new columns idempotently.
  await query(`ALTER TABLE cs_text_campaigns ADD COLUMN IF NOT EXISTS textmagic_session_id BIGINT`);
  await query(`ALTER TABLE cs_text_campaigns ADD COLUMN IF NOT EXISTS textmagic_bulk_id BIGINT`);

  await query(`
    CREATE TABLE IF NOT EXISTS cs_text_messages (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES cs_text_campaigns(id) ON DELETE CASCADE,
      account_id INTEGER,
      account_number TEXT,
      insured_name TEXT,
      phone VARCHAR(10),
      message TEXT,
      status TEXT NOT NULL,
      textmagic_id TEXT,
      cost NUMERIC(10,4),
      error TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cs_text_msg_campaign ON cs_text_messages(campaign_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cs_text_msg_phone ON cs_text_messages(phone)`);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const recipients: TextRecipient[] = body.recipients || [];
    const template: string = body.template || "";
    const sentBy: string = body.sentBy || "unknown";

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No recipients provided" },
        { status: 400 }
      );
    }
    if (recipients.length > 10000) {
      return NextResponse.json(
        { ok: false, error: `Batch too large: ${recipients.length} (max 10000)` },
        { status: 400 }
      );
    }

    await ensureTables();
    const today = todayLocal();

    // Create campaign row up front so we can reference it in per-message log
    const campaignRes = await query(
      `INSERT INTO cs_text_campaigns (scrub_date, template, total_recipients, sent_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [today, template, recipients.length, sentBy]
    );
    const campaignId = campaignRes.rows[0].id;

    // Fire the bulk send
    const bulk = await sendCampaignBulk(recipients);

    // Log per-recipient (contact sync result). The actual per-message TextMagic
    // delivery happens async on their side and is tracked via session/bulk ID.
    try {
      const logValues: string[] = [];
      const logParams: unknown[] = [];
      let p = 1;
      const idToRecipient = new Map<number, TextRecipient>();
      for (const r of recipients) idToRecipient.set(r.id, r);

      for (const item of bulk.perRecipient) {
        const r = idToRecipient.get(item.recipientId);
        if (!r) continue;
        logValues.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
        );
        logParams.push(
          campaignId,
          r.id,
          r.accountNumber,
          r.name,
          r.phone,
          r.message,
          item.status === "synced" ? "queued" : "failed",
          item.contactId ? String(item.contactId) : null,
          item.error || null
        );
      }

      if (logValues.length > 0) {
        await query(
          `INSERT INTO cs_text_messages
             (campaign_id, account_id, account_number, insured_name, phone, message,
              status, textmagic_id, error)
           VALUES ${logValues.join(", ")}`,
          logParams
        );
      }
    } catch (logErr) {
      console.error("Failed to batch-log per-message rows:", logErr);
    }

    // Update campaign totals + store TextMagic session/bulk ID
    await query(
      `UPDATE cs_text_campaigns
         SET total_sent = $1,
             total_failed = $2,
             textmagic_session_id = $3,
             textmagic_bulk_id = $4
       WHERE id = $5`,
      [
        bulk.ok ? bulk.contactsSynced : 0,
        bulk.contactsFailed + (bulk.ok ? 0 : bulk.contactsSynced),
        bulk.sessionId || null,
        bulk.bulkId || null,
        campaignId,
      ]
    );

    return NextResponse.json({
      ok: bulk.ok,
      campaignId,
      totalRecipients: recipients.length,
      sent: bulk.ok ? bulk.contactsSynced : 0,
      failed: bulk.contactsFailed + (bulk.ok ? 0 : bulk.contactsSynced),
      contactsSynced: bulk.contactsSynced,
      sessionId: bulk.sessionId,
      bulkId: bulk.bulkId,
      error: bulk.error,
    });
  } catch (e) {
    console.error("CS text-send error:", e);
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 500 }
    );
  }
}
