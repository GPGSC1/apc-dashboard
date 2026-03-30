import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";

/**
 * Diagnostic endpoint to compare call counts against manager's 3CX report.
 * Temporary — remove after debugging.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const start = url.searchParams.get("start") || "2026-03-02";
  const end = url.searchParams.get("end") || "2026-03-26";

  const NORM = `CASE
    WHEN LOWER(queue) LIKE '%mail 1%' THEN 'A1'
    WHEN LOWER(queue) LIKE '%mail 2%' THEN 'A2'
    WHEN LOWER(queue) LIKE '%mail 3%' THEN 'A3'
    WHEN LOWER(queue) LIKE '%mail 4%' THEN 'A4'
    WHEN LOWER(queue) LIKE '%mail 5%' THEN 'A5'
    WHEN LOWER(queue) LIKE '%mail 6%' THEN 'A6'
    WHEN LOWER(queue) LIKE '%home 1%' THEN 'H1'
    WHEN LOWER(queue) LIKE '%home 2%' THEN 'H2'
    WHEN LOWER(queue) LIKE '%home 3%' THEN 'H3'
    WHEN LOWER(queue) LIKE '%home 4%' THEN 'H4'
    WHEN LOWER(queue) LIKE '%home 5%' THEN 'H5'
    ELSE LOWER(TRIM(queue))
  END`;

  const HUMAN = `first_ext IS NOT NULL AND first_ext != '' AND LENGTH(TRIM(first_ext)) <= 4 AND TRIM(first_ext) NOT LIKE '99%'`;

  // 1. All distinct raw queue names
  const allQueues = await query(
    `SELECT queue, COUNT(*) as cnt FROM queue_calls WHERE call_date BETWEEN $1 AND $2 GROUP BY queue ORDER BY cnt DESC`,
    [start, end]
  );

  // 2. Human-answered: total rows vs distinct phones per normalized queue
  const humanCounts = await query(
    `SELECT ${NORM} as nq, COUNT(*) as total_rows, COUNT(DISTINCT phone) as distinct_phones
     FROM queue_calls WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
     GROUP BY nq ORDER BY nq`,
    [start, end]
  );

  // 3. Phones appearing in multiple raw queue variants for same normalized queue
  const dupeQueueVariants = await query(
    `WITH normed AS (
       SELECT phone, queue, ${NORM} as nq
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
     )
     SELECT nq, COUNT(*) as phones_with_dupes
     FROM (SELECT phone, nq FROM normed GROUP BY phone, nq HAVING COUNT(DISTINCT queue) > 1) sub
     GROUP BY nq`,
    [start, end]
  );

  // 4. Daily human-answered call counts (rows, not distinct) per normalized queue
  const dailyCounts = await query(
    `SELECT call_date, ${NORM} as nq, COUNT(*) as cnt
     FROM queue_calls WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
     GROUP BY call_date, nq ORDER BY call_date, nq`,
    [start, end]
  );

  // 5. Repeat callers per queue (phones with >1 call date in same norm queue)
  const repeatCallers = await query(
    `WITH normed AS (
       SELECT phone, call_date, ${NORM} as nq
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
     )
     SELECT nq, COUNT(*) as repeat_phone_count, SUM(call_days) as total_extra_rows
     FROM (SELECT phone, nq, COUNT(*) as call_days FROM normed GROUP BY phone, nq HAVING COUNT(*) > 1) sub
     GROUP BY nq`,
    [start, end]
  );

  // 6. Extension patterns for sanity check
  const extPatterns = await query(
    `SELECT
       COUNT(*) FILTER (WHERE TRIM(first_ext) LIKE '6%') as ext_6xxx,
       COUNT(*) FILTER (WHERE TRIM(first_ext) LIKE '7%') as ext_7xxx,
       COUNT(*) FILTER (WHERE TRIM(first_ext) LIKE '1%') as ext_1xxx,
       COUNT(*) FILTER (WHERE TRIM(first_ext) LIKE '99%') as ext_99xx,
       COUNT(*) FILTER (WHERE LENGTH(TRIM(first_ext)) = 3) as ext_3digit,
       COUNT(*) FILTER (WHERE LENGTH(TRIM(first_ext)) = 4) as ext_4digit,
       COUNT(*) FILTER (WHERE LENGTH(TRIM(first_ext)) > 4) as ext_5plus
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2
       AND first_ext IS NOT NULL AND first_ext != ''`,
    [start, end]
  );

  return NextResponse.json({
    dateRange: { start, end },
    allQueues: allQueues.rows,
    humanCounts: humanCounts.rows,
    dupeQueueVariants: dupeQueueVariants.rows,
    repeatCallers: repeatCallers.rows,
    dailyCounts: dailyCounts.rows,
    extPatterns: extPatterns.rows[0],
  });
}
