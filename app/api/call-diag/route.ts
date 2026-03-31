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

  const HUMAN = `first_ext IS NOT NULL AND first_ext != '' AND LENGTH(TRIM(first_ext)) <= 4 AND TRIM(first_ext) NOT LIKE '99%' AND LOWER(status) = 'answered'`;

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

  // 7. Per-date totals (human answered, sales queues only) for comparison
  const salesQueues = ['A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5'];
  const dailySalesTotal = await query(
    `SELECT call_date, COUNT(*) as total_rows, COUNT(DISTINCT phone) as distinct_phones
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
       AND ${NORM} IN ('A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5')
     GROUP BY call_date ORDER BY call_date`,
    [start, end]
  );

  // 8. 1xxx extensions in sales queues specifically
  const ext1xxxInSales = await query(
    `SELECT ${NORM} as nq, COUNT(*) as cnt, COUNT(DISTINCT phone) as dist
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2
       AND first_ext IS NOT NULL AND first_ext != ''
       AND TRIM(first_ext) LIKE '1%'
       AND LENGTH(TRIM(first_ext)) = 4
       AND ${NORM} IN ('A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5')
     GROUP BY nq ORDER BY nq`,
    [start, end]
  );

  // 9. Sample phones with 1xxx ext in sales queues
  const sample1xxx = await query(
    `SELECT phone, first_ext, agent_name, queue, call_date
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2
       AND first_ext IS NOT NULL AND first_ext != ''
       AND TRIM(first_ext) LIKE '1%'
       AND LENGTH(TRIM(first_ext)) = 4
       AND ${NORM} IN ('A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5')
     LIMIT 20`,
    [start, end]
  );

  // 10. Status breakdown for human-ext calls per queue (are there non-"answered" calls with first_ext?)
  const statusBreakdown = await query(
    `SELECT ${NORM} as nq, status, COUNT(*) as cnt, COUNT(DISTINCT phone) as dist
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
     GROUP BY nq, status ORDER BY nq, status`,
    [start, end]
  );

  // 11. A4 specifically: daily total_rows vs Sarah's expectation
  const a4Daily = await query(
    `SELECT call_date, status, COUNT(*) as cnt, COUNT(DISTINCT phone) as dist
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
       AND ${NORM} = 'A4'
     GROUP BY call_date, status ORDER BY call_date, status`,
    [start, end]
  );

  // 12. A4 phones that also appear in other queues (same date range, human-answered)
  const a4CrossQueue = await query(
    `WITH a4_phones AS (
       SELECT DISTINCT phone FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2
         AND ${HUMAN}
         AND LOWER(queue) LIKE '%mail 4%'
     )
     SELECT CASE
         WHEN LOWER(q.queue) LIKE '%mail 1%' THEN 'A1'
         WHEN LOWER(q.queue) LIKE '%mail 2%' THEN 'A2'
         WHEN LOWER(q.queue) LIKE '%mail 3%' THEN 'A3'
         WHEN LOWER(q.queue) LIKE '%mail 5%' THEN 'A5'
         WHEN LOWER(q.queue) LIKE '%mail 6%' THEN 'A6'
         WHEN LOWER(q.queue) LIKE '%home 1%' THEN 'H1'
         WHEN LOWER(q.queue) LIKE '%home 2%' THEN 'H2'
         WHEN LOWER(q.queue) LIKE '%home 3%' THEN 'H3'
         ELSE LOWER(TRIM(q.queue))
       END as other_queue,
       COUNT(DISTINCT q.phone) as phone_count
     FROM queue_calls q
     JOIN a4_phones ap ON q.phone = ap.phone
     WHERE q.call_date BETWEEN $1 AND $2
       AND ${HUMAN}
       AND NOT LOWER(q.queue) LIKE '%mail 4%'
     GROUP BY other_queue ORDER BY phone_count DESC`,
    [start, end]
  );

  // 13. Single-agent deep dive (pass ?agent=Name to drill in)
  const agentParam = url.searchParams.get("agent") || "";
  let agentDetail: any[] = [];
  let agentByQueue: any[] = [];
  let agentByStatus: any[] = [];
  if (agentParam) {
    agentDetail = (await query(
      `SELECT phone, queue, call_date, first_ext, status, direction, destination
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2
         AND agent_name = $3
         AND ${NORM} IN ('A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5')
       ORDER BY call_date, queue
       LIMIT 20`,
      [start, end, agentParam]
    )).rows;
    agentByQueue = (await query(
      `SELECT ${NORM} as nq, status, COUNT(*) as total_rows, COUNT(DISTINCT phone) as distinct_phones
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2
         AND agent_name = $3
         AND ${HUMAN}
         AND ${NORM} IN ('A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5')
       GROUP BY nq, status ORDER BY nq, status`,
      [start, end, agentParam]
    )).rows;
    agentByStatus = (await query(
      `SELECT status, COUNT(*) as total_rows, COUNT(DISTINCT phone) as distinct_phones
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2
         AND agent_name = $3
         AND ${NORM} IN ('A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5')
       GROUP BY status ORDER BY status`,
      [start, end, agentParam]
    )).rows;
  }

  // 14. Per-agent call counts — first-chronological dedup per phone per queue per month
  const DEDUP_CTE = `
    WITH answered AS (
      SELECT phone, call_date, agent_name, ${NORM} as nq
      FROM queue_calls
      WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY phone, nq ORDER BY call_date ASC
      ) as rn
      FROM answered
    ),
    deduped AS (
      SELECT phone, nq, call_date, agent_name FROM ranked
      WHERE rn = 1 AND nq IN ('A1','A2','A3','A4','A5','A6','H1','H2','H3','H4','H5')
    )`;

  const agentCounts = await query(
    `${DEDUP_CTE}
     SELECT agent_name, SUM(cnt) as distinct_phones
     FROM (
       SELECT agent_name, nq, COUNT(*) as cnt FROM deduped GROUP BY agent_name, nq
     ) sub
     GROUP BY agent_name ORDER BY agent_name`,
    [start, end]
  );

  // 14. Repeat callers detail for A4: phones with most repeat days
  const a4TopRepeats = await query(
    `SELECT phone, COUNT(DISTINCT call_date) as days, array_agg(DISTINCT call_date ORDER BY call_date) as dates
     FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND ${HUMAN}
       AND ${NORM} = 'A4'
     GROUP BY phone HAVING COUNT(DISTINCT call_date) > 1
     ORDER BY COUNT(DISTINCT call_date) DESC
     LIMIT 15`,
    [start, end]
  );

  // 15. Dest_name diagnostic — check what dest_names exist and T.O. team member matching
  const destNameSample = await query(
    `SELECT dest_name, COUNT(*) as cnt FROM queue_calls
     WHERE call_date BETWEEN $1 AND $2 AND dest_name IS NOT NULL AND dest_name != ''
     GROUP BY dest_name ORDER BY cnt DESC LIMIT 30`,
    [start, end]
  );

  const toTeamMembers = await query(
    `SELECT tm.agent_name, t.name as team_name FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     WHERE LOWER(t.name) IN ('to.', 't.o.')`
  );

  const toTransferMatch = await query(
    `SELECT qc.dest_name, COUNT(*) as cnt
     FROM queue_calls qc
     JOIN team_members tm ON LOWER(TRIM(qc.dest_name)) = LOWER(TRIM(tm.agent_name))
     JOIN teams t ON t.id = tm.team_id
     WHERE qc.call_date BETWEEN $1 AND $2
       AND LOWER(t.name) IN ('to.', 't.o.')
       AND qc.dest_name IS NOT NULL AND qc.dest_name != ''
       AND LOWER(qc.status) = 'answered'
     GROUP BY qc.dest_name`,
    [start, end]
  );

  return NextResponse.json({
    dateRange: { start, end },
    allQueues: allQueues.rows,
    humanCounts: humanCounts.rows,
    dupeQueueVariants: dupeQueueVariants.rows,
    repeatCallers: repeatCallers.rows,
    dailySalesTotal: dailySalesTotal.rows,
    extPatterns: extPatterns.rows[0],
    ext1xxxInSales: ext1xxxInSales.rows,
    sample1xxx: sample1xxx.rows,
    statusBreakdown: statusBreakdown.rows,
    a4Daily: a4Daily.rows,
    a4CrossQueue: a4CrossQueue.rows,
    a4TopRepeats: a4TopRepeats.rows,
    agentCounts: agentCounts.rows,
    agentDetail: agentDetail,
    agentByQueue: agentByQueue,
    agentByStatus: agentByStatus,
    destNameSample: destNameSample.rows,
    toTeamMembers: toTeamMembers.rows,
    toTransferMatch: toTransferMatch.rows,
  });
}
