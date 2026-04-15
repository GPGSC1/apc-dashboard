// CS Collections SMS Campaign — Preview Endpoint
// Pulls today's past-due accounts from cs_past_due_accounts, applies scrub rules,
// and returns preview data for the confirmation modal.

import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { todayLocal } from "../../../../lib/date-utils";
import {
  applyScrubRules,
  DEFAULT_MESSAGE_TEMPLATE,
  type PastDueRow,
} from "../../../../lib/cs/text-campaign";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedDate = url.searchParams.get("date") || todayLocal();
    const template = url.searchParams.get("template") || DEFAULT_MESSAGE_TEMPLATE;

    // If the requested date has no assigned-rep rows, fall back to the most
    // recent scrub_date that does. (Covers the case where today's PBS scrub
    // hasn't run yet but collections still wants to preview.)
    let date = requestedDate;
    const checkRes = await query(
      `SELECT COUNT(*)::INT AS n FROM cs_past_due_accounts
       WHERE scrub_date = $1 AND assigned_rep IS NOT NULL AND assigned_rep != ''`,
      [date]
    );
    if (!checkRes.rows[0]?.n) {
      const fallbackRes = await query(
        `SELECT MAX(scrub_date)::TEXT AS d FROM cs_past_due_accounts
         WHERE assigned_rep IS NOT NULL AND assigned_rep != ''`
      );
      if (fallbackRes.rows[0]?.d) date = fallbackRes.rows[0].d;
    }

    // Only accounts with assigned_rep (= actually on the past-due list)
    const result = await query(
      `SELECT
         id, account_number, insured_name,
         main_phone, mobile_phone,
         amount_due, next_due_date,
         installments_made, dispo_1, dispo_2
       FROM cs_past_due_accounts
       WHERE scrub_date = $1
         AND assigned_rep IS NOT NULL AND assigned_rep != ''
       ORDER BY account_number`,
      [date]
    );

    const rows = result.rows as PastDueRow[];
    const scrub = applyScrubRules(rows, template);

    return NextResponse.json({
      ok: true,
      date,
      requestedDate,
      fellBack: date !== requestedDate,
      template,
      totalRows: rows.length,
      recipients: scrub.recipients,
      exclusions: scrub.exclusions,
      scrubbedRows: scrub.scrubbedRows,
    });
  } catch (e) {
    console.error("CS text-preview error:", e);
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 500 }
    );
  }
}
