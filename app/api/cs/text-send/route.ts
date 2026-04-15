// CS Collections SMS Campaign — Send Endpoint
// Accepts a list of recipients (from the preview) and sends each via TextMagic.
// Logs the batch to cs_text_campaigns + cs_text_messages for audit.

import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";
import {
  sendOneText,
  type TextRecipient,
} from "../../../../lib/cs/text-campaign";

export const maxDuration = 300; // 5 min — some batches can be large

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
      sent_by TEXT
    )
  `);
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
    const dryRun: boolean = body.dryRun === true;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No recipients provided" },
        { status: 400 }
      );
    }

    // Optional safety cap
    if (recipients.length > 5000) {
      return NextResponse.json(
        { ok: false, error: `Batch too large: ${recipients.length} (max 5000)` },
        { status: 400 }
      );
    }

    await ensureTables();
    const today = todayLocal();

    // Create campaign row
    const campaignRes = await query(
      `INSERT INTO cs_text_campaigns (scrub_date, template, total_recipients, sent_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [today, template, recipients.length, sentBy]
    );
    const campaignId = campaignRes.rows[0].id;

    // Send sequentially with small pacing to avoid TextMagic rate-limiting.
    // TextMagic allows ~10/sec. We pace at ~5/sec (200ms) for safety.
    const results = [];
    let sent = 0;
    let failed = 0;

    for (const recipient of recipients) {
      let result;
      if (dryRun) {
        result = {
          ok: true,
          recipientId: recipient.id,
          phone: recipient.phone,
          messageId: "dry-run",
          cost: 0,
        };
      } else {
        result = await sendOneText(recipient);
        // Pace at ~5/sec
        await new Promise((r) => setTimeout(r, 200));
      }

      if (result.ok) sent++;
      else failed++;

      // Log per-message
      try {
        await query(
          `INSERT INTO cs_text_messages
             (campaign_id, account_id, account_number, insured_name, phone, message,
              status, textmagic_id, cost, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            campaignId,
            recipient.id,
            recipient.accountNumber,
            recipient.name,
            recipient.phone,
            recipient.message,
            result.ok ? "sent" : "failed",
            result.messageId || null,
            result.cost ?? null,
            result.error || null,
          ]
        );
      } catch (logErr) {
        console.error("Failed to log message:", logErr);
      }

      results.push(result);
    }

    // Update campaign totals
    await query(
      `UPDATE cs_text_campaigns
         SET total_sent = $1, total_failed = $2
       WHERE id = $3`,
      [sent, failed, campaignId]
    );

    return NextResponse.json({
      ok: true,
      campaignId,
      totalRecipients: recipients.length,
      sent,
      failed,
      dryRun,
      results,
    });
  } catch (e) {
    console.error("CS text-send error:", e);
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 500 }
    );
  }
}
