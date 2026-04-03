import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";

export async function GET() {
  const from = "2026-04-01";
  const to = "2026-04-02";

  // Query 1: dest_name vs agent_name counts
  const counts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE TRIM(dest_name) = 'Steven Garner') AS dest_name_count,
       COUNT(*) FILTER (WHERE TRIM(agent_name) = 'Steven Garner') AS agent_name_count,
       COUNT(*) FILTER (WHERE TRIM(dest_name) = 'Steven Garner' OR TRIM(agent_name) = 'Steven Garner') AS either_count
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'`,
    [from, to]
  );

  // Query 2: Transfers TO Steven (dest_name=Steven, agent_name=someone else)
  const transfersTo = await query(
    `SELECT agent_name, dest_name, phone, queue, call_date
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'
       AND TRIM(dest_name) = 'Steven Garner'
       AND TRIM(agent_name) != 'Steven Garner' AND TRIM(agent_name) != ''
     ORDER BY call_date, phone`,
    [from, to]
  );

  // Query 3: Transfers FROM Steven (agent_name=Steven, dest_name=someone else)
  const transfersFrom = await query(
    `SELECT agent_name, dest_name, phone, queue, call_date
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'
       AND TRIM(agent_name) = 'Steven Garner'
       AND TRIM(dest_name) != 'Steven Garner' AND TRIM(dest_name) != ''
     ORDER BY call_date, phone`,
    [from, to]
  );

  // Query 4: Per-queue breakdown with both methods
  const byQueue = await query(
    `SELECT
       CASE
         WHEN LOWER(queue) LIKE '%mail 1%' THEN 'A1'
         WHEN LOWER(queue) LIKE '%mail 2%' THEN 'A2'
         WHEN LOWER(queue) LIKE '%mail 3%' THEN 'A3'
         WHEN LOWER(queue) LIKE '%mail 4%' THEN 'A4'
         WHEN LOWER(queue) LIKE '%mail 5%' THEN 'A5'
         WHEN LOWER(queue) LIKE '%mail 6%' THEN 'A6'
         WHEN LOWER(queue) LIKE '%home 1%' THEN 'H1'
         WHEN LOWER(queue) LIKE '%home 2%' THEN 'H2'
         WHEN LOWER(queue) LIKE '%home 3%' THEN 'H3'
         ELSE queue
       END AS mapped_queue,
       COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(dest_name),''), agent_name) = 'Steven Garner') AS dest_name_method,
       COUNT(*) FILTER (WHERE TRIM(agent_name) = 'Steven Garner') AS agent_name_method
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'
     GROUP BY mapped_queue
     HAVING COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(dest_name),''), agent_name) = 'Steven Garner') > 0
        OR COUNT(*) FILTER (WHERE TRIM(agent_name) = 'Steven Garner') > 0
     ORDER BY mapped_queue`,
    [from, to]
  );

  // Query 5: Distinct phones — does Sara dedup by phone globally?
  const phoneCounts = await query(
    `SELECT
       COUNT(*) AS total_calls,
       COUNT(DISTINCT phone) AS unique_phones,
       COUNT(*) - COUNT(DISTINCT phone) AS dupes_lost_if_global_dedup
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'
       AND TRIM(agent_name) = 'Steven Garner'
       AND LOWER(queue) NOT LIKE '%spanish%'`,
    [from, to]
  );

  // Query 5b: Show Steven's phones that appear in multiple queues
  const multiQueuePhones = await query(
    `SELECT phone, COUNT(DISTINCT queue) as queue_count, array_agg(DISTINCT queue) as queues
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'
       AND TRIM(agent_name) = 'Steven Garner'
       AND LOWER(queue) NOT LIKE '%spanish%'
     GROUP BY phone
     HAVING COUNT(DISTINCT queue) > 1
     ORDER BY queue_count DESC`,
    [from, to]
  );

  // Query 6: first_ext breakdown for Steven's calls in sales queues
  const extBreakdown = await query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE first_ext IS NOT NULL AND first_ext != ''
         AND LENGTH(TRIM(first_ext)) <= 4 AND TRIM(first_ext) NOT LIKE '99%') AS human_ext,
       COUNT(*) FILTER (WHERE first_ext IS NULL OR first_ext = '') AS empty_ext,
       COUNT(*) FILTER (WHERE first_ext IS NOT NULL AND first_ext != ''
         AND TRIM(first_ext) LIKE '99%') AS ai_ext,
       COUNT(*) FILTER (WHERE first_ext IS NOT NULL AND first_ext != ''
         AND LENGTH(TRIM(first_ext)) > 4 AND TRIM(first_ext) NOT LIKE '99%') AS long_ext
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'
       AND TRIM(agent_name) = 'Steven Garner'
       AND LOWER(queue) NOT LIKE '%spanish%'`,
    [from, to]
  );

  // Query 6: Show the actual first_ext values for Steven's non-human-ext calls
  const nonHumanCalls = await query(
    `SELECT phone, queue, call_date, first_ext, agent_name, dest_name, status
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'
       AND TRIM(agent_name) = 'Steven Garner'
       AND LOWER(queue) NOT LIKE '%spanish%'
       AND (first_ext IS NULL OR first_ext = ''
         OR LENGTH(TRIM(first_ext)) > 4
         OR TRIM(first_ext) LIKE '99%')
     ORDER BY call_date, queue`,
    [from, to]
  );

  return NextResponse.json({
    dateRange: { from, to },
    summary: counts.rows[0],
    perQueue: byQueue.rows,
    transfersTO_Steven: { count: transfersTo.rows.length, rows: transfersTo.rows },
    transfersFROM_Steven: { count: transfersFrom.rows.length, rows: transfersFrom.rows },
    phoneDedupAnalysis: phoneCounts.rows[0],
    multiQueuePhones: { count: multiQueuePhones.rows.length, rows: multiQueuePhones.rows },
    firstExtBreakdown: extBreakdown.rows[0],
    nonHumanExtCalls: { count: nonHumanCalls.rows.length, rows: nonHumanCalls.rows },
  });
}
