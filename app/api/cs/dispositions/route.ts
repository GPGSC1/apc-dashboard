import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";

// Disposition options matching the Google Sheet dropdowns
const DISPOSITIONS: [string, boolean, number][] = [
  // Carry-over dispositions (keep account on list next day)
  ["Follow Up", true, 1],
  ["Scheduled PDP", true, 2],
  ["Mailed Check", true, 3],
  // Standard dispositions
  ["No Voicemail", false, 4],
  ["VM Full", false, 5],
  ["LVM", false, 6],
  ["Sent Email", false, 7],
  ["Collected", false, 8],
  ["PUHU", false, 9],
  ["Wrong #/NIS", false, 10],
  ["Cancelled Policy", false, 11],
  ["Sent To CS", false, 12],
  ["Spanish", false, 13],
  ["DO NOT CALL", false, 14],
  ["CS- Save Attempt", false, 15],
];

export async function GET() {
  try {
    // One-time migration: ensure all Google Sheet dispositions exist
    for (const [label, isCarryover, sortOrder] of DISPOSITIONS) {
      await query(
        "INSERT INTO cs_disposition_options (label, is_carryover, sort_order) VALUES ($1, $2, $3) ON CONFLICT (label) DO UPDATE SET sort_order = $3",
        [label, isCarryover, sortOrder]
      );
    }

    const result = await query(
      "SELECT id, label, is_carryover FROM cs_disposition_options ORDER BY sort_order"
    );
    return NextResponse.json({ ok: true, dispositions: result.rows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
