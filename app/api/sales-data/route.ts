import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";
import { todayLocal } from "../../../lib/date-utils";
import { mapQueue, mapAnyQueue, isAutoQueue, isHomeQueue, ALL_QUEUES } from "../../../lib/queue-map";
import { isExcludedSalesperson } from "../../../lib/teams";

/**
 * SALES DATA ROUTE — Powers the /sales dashboard.
 * Attribution: For each Moxy deal, find the most recent 3CX queue visit
 * ON or BEFORE the sold date. No AIM data used.
 *
 * Calls: Unique phones per queue within the selected date range.
 * Same phone in different queues counts for each queue.
 * Same phone calling the same queue twice in the range counts once.
 */

/**
 * Fallback queue attribution using campaign/promo rules when phone
 * is not found in queue_calls. Rules are applied by priority.
 */
function applyQueueRules(
  campaign: string,
  promoCode: string,
  product: "auto" | "home",
  customerId?: string
): string | null {
  const rawCampaign = (campaign ?? "").trim().toUpperCase();
  const cid = (customerId ?? "").trim().toUpperCase();
  const pc = (promoCode ?? "").trim().toUpperCase();

  // Try campaign first, then customer_id — check BOTH independently
  const candidates = [rawCampaign, cid].filter(Boolean);

  // PromoCode check outside the loop (not candidate-dependent)
  if (product === "auto" && pc === "API") return "A4";
  if (product === "auto" && pc === "MAIL 3") return "A3";
  if (product === "auto" && pc === "LR-CQ") return "A3";
  if (product === "auto" && pc === "INB") return "A1";

  for (const c of candidates) {
    if (product === "auto") {
      if (c.startsWith("GPG")) return "A1";
      if (c.startsWith("FWM")) return "A3";
      if (c.startsWith("WF")) return "A3";
      if (c.startsWith("FTD")) return "A3";
      if (c.startsWith("FD")) return "A3";

      const a2Prefixes = [
        "DMW", "MKA", "DMC", "SCD", "APD", "TDM", "SDC", "TDN", "TDS", "MX",
        "2DMWTD", "PMI", "SAC TD", "TD_", "TDV", "TDSF", "TDT",
      ];
      for (const pfx of a2Prefixes) {
        if (c.startsWith(pfx)) return "A2";
      }
      if (c.includes("PMI")) return "A2";
      if (c.startsWith("TD")) return "A2";
      if (/^MKA.{3}KA/i.test(c)) return "A1";

      if (c.length >= 6) {
        const mid = c.substring(4, 6);
        const a1Mids = new Set([
          "KC", "KH", "KL", "LA", "KZ", "KQ", "PB", "KR", "KS", "KT",
          "KU", "KV", "KM", "KB", "LB", "CA", "KN", "KD", "KE", "CC",
          "PA", "SA", "KW", "KA", "LC",
        ]);
        if (a1Mids.has(mid)) return "A1";
      }
      if (/^\d{3}[A-Z]{2}$/.test(c)) return "A1";
      if (c.startsWith("CC")) return "A3";
    }

    if (product === "home") {
      if (c.startsWith("TDH")) return "H2";
      if (c.startsWith("TAB")) return "H3";
      if (/^\d{3}[A-Z]{2}$/.test(c)) return "H1";
      if (c.startsWith("132883-GPGH")) return "H1";
      if (c.startsWith("GPGH")) return "H1";
    }
  } // end for loop over candidates

  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fromDate = url.searchParams.get("start") ?? todayLocal();
  const toDate = url.searchParams.get("end") ?? todayLocal();
  const soldOnly = url.searchParams.get("soldOnly") === "true";
  const statusFilter = soldOnly
    ? "AND deal_status = 'Sold'"
    : "AND deal_status != ''";

  try {
    // ── 0. BUILD SALES AGENT SET ────────────────────────────────────
    // Excluded teams: T.O., Spanish, Customer Service, Unassigned
    // Everything else = sales team whose calls count
    const EXCLUDED_PATTERNS = ['t.o.', 'to.', 'spanish', 'customer service', 'unassigned'];
    function isExcludedTeam(teamName: string): boolean {
      const lower = teamName.toLowerCase().trim();
      return EXCLUDED_PATTERNS.some(p => lower === p || lower.includes(p));
    }

    const allTeamMembersResult = await query(
      `SELECT t.name as team_name, tm.agent_name
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.agent_name IS NOT NULL AND tm.agent_name != ''`
    );
    const salesAgentNames = new Set<string>();
    for (const row of allTeamMembersResult.rows) {
      if (!isExcludedTeam(row.team_name)) {
        salesAgentNames.add(row.agent_name.trim().toLowerCase());
      }
    }

    // ── 1. DEALS from Moxy Auto + Moxy Home ─────────────────────────
    const autoDealsResult = await query(
      `SELECT DISTINCT ON (customer_id || '|' || contract_no)
         customer_id, contract_no, salesperson, owner, home_phone, mobile_phone, sold_date, deal_status, make, model, campaign, promo_code, first_name, last_name
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         ${statusFilter}
       ORDER BY customer_id || '|' || contract_no, sold_date DESC`,
      [fromDate, toDate]
    );
    const homeDealsResult = await query(
      `SELECT DISTINCT ON (customer_id || '|' || contract_no)
         customer_id, contract_no, salesperson, owner, home_phone, mobile_phone, sold_date, deal_status, campaign, promo_code, first_name, last_name
       FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         ${statusFilter}
       ORDER BY customer_id || '|' || contract_no, sold_date DESC`,
      [fromDate, toDate]
    );

    // Tag each deal with its product type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allDeals: any[] = [
      ...autoDealsResult.rows.map((r: any) => ({ ...r, product: "auto" })),
      ...homeDealsResult.rows.map((r: any) => ({ ...r, product: "home" })),
    ];
    const dealsResult = { rows: allDeals };

    // ── 2. For each deal, find most recent queue ON or BEFORE sold date ──
    // Batch: get all queue_calls for deal phones, then match in JS
    const dealPhones = new Set<string>();
    for (const deal of dealsResult.rows) {
      const hp = (deal.home_phone ?? "").replace(/\D/g, "").slice(-10);
      const mp = (deal.mobile_phone ?? "").replace(/\D/g, "").slice(-10);
      if (hp.length === 10) dealPhones.add(hp);
      if (mp.length === 10) dealPhones.add(mp);
    }

    // Load queue history for deal phones (all dates, sorted desc)
    const phoneArray = Array.from(dealPhones);
    let phoneQueueHistory: Map<string, { queue: string; date: string }[]> = new Map();

    if (phoneArray.length > 0) {
      // Batch query in chunks to avoid param limits
      const chunkSize = 500;
      for (let i = 0; i < phoneArray.length; i += chunkSize) {
        const chunk = phoneArray.slice(i, i + chunkSize);
        const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(",");
        const result = await query(
          `SELECT phone, queue, call_date FROM queue_calls
           WHERE phone IN (${placeholders})
           ORDER BY call_date DESC`,
          chunk
        );
        for (const row of result.rows) {
          const p = row.phone.trim();
          if (!phoneQueueHistory.has(p)) phoneQueueHistory.set(p, []);
          const cd = row.call_date instanceof Date ? row.call_date.toISOString().slice(0, 10) : String(row.call_date).slice(0, 10);
          phoneQueueHistory.get(p)!.push({
            queue: row.queue,
            date: cd,
          });
        }
      }
    }

    // Helper: find most recent queue ON or BEFORE a given date
    function findQueueBeforeDate(phone: string, soldDate: string): string | null {
      const history = phoneQueueHistory.get(phone);
      if (!history) return null;
      for (const entry of history) {
        // history is sorted desc, so first entry <= soldDate is the answer
        if (entry.date <= soldDate) {
          return mapQueue(entry.queue);
        }
      }
      return null;
    }

    // ── 3. CALLS: month-to-date first-chronological dedup ────────────
    // SQL CASE for normalizing queue names (reused across all call queries)
    // Spanish checked BEFORE T.O. to avoid "Spanish - Auto" matching "to" substring
    const NORM_QUEUE_SQL = `CASE
           WHEN LOWER(queue) LIKE '%spanish%' THEN 'spanish'
           WHEN LOWER(queue) LIKE '%mail 1%' THEN 'mail 1'
           WHEN LOWER(queue) LIKE '%mail 2%' THEN 'mail 2'
           WHEN LOWER(queue) LIKE '%mail 3%' THEN 'mail 3'
           WHEN LOWER(queue) LIKE '%mail 4%' THEN 'mail 4'
           WHEN LOWER(queue) LIKE '%mail 5%' THEN 'mail 5'
           WHEN LOWER(queue) LIKE '%mail 6%' THEN 'mail 6'
           WHEN LOWER(queue) LIKE '%home 1%' THEN 'home 1'
           WHEN LOWER(queue) LIKE '%home 2%' THEN 'home 2'
           WHEN LOWER(queue) LIKE '%home 3%' THEN 'home 3'
           WHEN LOWER(queue) LIKE '%home 4%' THEN 'home 4'
           WHEN LOWER(queue) LIKE '%home 5%' THEN 'home 5'
           WHEN TRIM(LOWER(queue)) = 'to' OR LOWER(queue) LIKE '% to' OR LOWER(queue) LIKE 'to %' THEN 'to'
           ELSE LOWER(TRIM(queue))
         END`;

    // Relaxed filter: only require answered status. The old first_ext conditions
    // (non-empty, ≤4 digits, not 99xx) were too restrictive — calls can have a
    // dest_name (routed to a human) even when first_ext is blank or AI (99xx).
    // Agent attribution uses dest_name anyway, so first_ext doesn't matter.
    const HUMAN_FILTER = `LOWER(status) = 'answered'`;

    // Dedup CTE: first chronological phone per queue per month for sales queues only
    // Uses dest_name (Destination Name = who the call was routed to) for agent attribution,
    // falling back to agent_name (First Ext Name) when dest_name is empty.
    // This matches the user's COUNTIFS methodology on 3CX column L (Destination Name).
    const DEDUP_CTE = `
      WITH answered AS (
        SELECT phone, call_date,
          COALESCE(NULLIF(TRIM(dest_name), ''), agent_name) as attr_agent,
          ${NORM_QUEUE_SQL} as norm_queue
        FROM queue_calls
        WHERE call_date BETWEEN $1 AND $2
          AND ${HUMAN_FILTER}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY phone, norm_queue
          ORDER BY call_date ASC
        ) as rn
        FROM answered
      ),
      deduped AS (
        SELECT phone, norm_queue, call_date, attr_agent FROM ranked
        WHERE rn = 1
          AND norm_queue IN ('mail 1','mail 2','mail 3','mail 4','mail 5','mail 6',
                             'home 1','home 2','home 3','home 4','home 5')
      )`;

    // queueCalls and totalCalls are computed AFTER agentQueueCalls is built,
    // filtered to sales agents only (bottom-up counting)
    const queueCalls: Record<string, number> = {};
    let totalCalls = 0;

    // T.O. call count — identified by dest_name matching T.O. team members
    // These do NOT get added to main sales call totals
    // Every answered call transferred to a T.O. rep counts (no dedup)
    let toCallCount = 0;

    // Spanish agent attribution: count how many times Spanish team members
    // appear in dest_name across ALL transfers. Never deduped.
    // First get Spanish team member names, then count their occurrences in dest_name
    const spanishTeamResult = await query(
      `SELECT tm.agent_name FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE LOWER(t.name) = 'spanish'`,
      []
    );
    const spanishNames = new Set(spanishTeamResult.rows.map((r: { agent_name: string }) => r.agent_name.trim().toLowerCase()));
    const _spDebug = { spanishTeamNames: [...spanishNames], spanishTeamCount: spanishNames.size };

    // Spanish: count dest_name occurrences across ALL queues, ALL calls (no status filter)
    // Matches user's COUNTIF on Destination Name column L across entire raw 3CX report
    const spanishCountResult = await query(
      `SELECT dest_name, COUNT(*) as cnt
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2
         AND dest_name IS NOT NULL AND dest_name != ''
       GROUP BY dest_name`,
      [fromDate, toDate]
    );
    const spanishByAgent: Record<string, number> = {};
    let spanishTotal = 0;
    for (const row of spanishCountResult.rows) {
      const name = (row.dest_name ?? "").trim();
      if (name && spanishNames.has(name.toLowerCase())) {
        const cnt = parseInt(row.cnt);
        spanishByAgent[name] = cnt;
        spanishTotal += cnt;
      }
    }

    // T.O. agent attribution: count how many times T.O. team members
    // appear in dest_name across ALL transfers. Never deduped.
    const toTeamResult = await query(
      `SELECT tm.agent_name FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       WHERE LOWER(t.name) IN ('to.', 't.o.')`,
      []
    );
    const toNames = new Set(toTeamResult.rows.map((r: { agent_name: string }) => r.agent_name.trim().toLowerCase()));

    // T.O.: count dest_name occurrences across ALL queues, ALL calls (no status filter)
    // Matches user's COUNTIF on Destination Name column L across entire raw 3CX report
    // Reuse the same broad dest_name query result from Spanish counting
    const toByAgent: Record<string, number> = {};
    for (const row of spanishCountResult.rows) {
      const name = (row.dest_name ?? "").trim();
      if (name && toNames.has(name.toLowerCase())) {
        const cnt = parseInt(row.cnt);
        toByAgent[name] = cnt;
        toCallCount += cnt;
      }
    }

    // AI-forwarded calls: either ext starts with 99, OR blank ext with 11-digit destination (forwarded to AI)
    const aiFwdResult = await query(
      `SELECT ${NORM_QUEUE_SQL} as norm_queue, COUNT(DISTINCT phone) as cnt
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2
         AND (
           (first_ext IS NOT NULL AND first_ext != '' AND TRIM(first_ext) LIKE '99%')
           OR
           ((first_ext IS NULL OR first_ext = '') AND destination IS NOT NULL AND LENGTH(TRIM(destination)) = 11 AND TRIM(destination) LIKE '1%')
         )
       GROUP BY norm_queue`,
      [fromDate, toDate]
    );
    const queueAiFwd: Record<string, number> = {};
    for (const row of aiFwdResult.rows) {
      const mapped = mapQueue(row.norm_queue);
      if (mapped) {
        queueAiFwd[mapped] = (queueAiFwd[mapped] ?? 0) + parseInt(row.cnt);
      }
    }

    // Dropped calls: blank ext, NOT forwarded to AI (no 11-digit destination),
    // and phone was NEVER answered in that queue during the entire date range.
    // Use normalized queue for grouping to avoid double-counting
    const droppedResult = await query(
      `SELECT ${NORM_QUEUE_SQL} as norm_queue, COUNT(DISTINCT phone) as cnt
       FROM queue_calls d
       WHERE d.call_date BETWEEN $1 AND $2
         AND (d.first_ext = '' OR d.first_ext IS NULL)
         AND (d.destination IS NULL OR LENGTH(TRIM(d.destination)) != 11 OR TRIM(d.destination) NOT LIKE '1%')
         AND NOT EXISTS (
           SELECT 1 FROM queue_calls a
           WHERE a.phone = d.phone
             AND a.call_date BETWEEN $1 AND $2
             AND (
               (a.first_ext IS NOT NULL AND a.first_ext != '')
               OR (a.destination IS NOT NULL AND LENGTH(TRIM(a.destination)) = 11 AND TRIM(a.destination) LIKE '1%')
             )
         )
       GROUP BY norm_queue`,
      [fromDate, toDate]
    );
    const queueDropped: Record<string, number> = {};
    for (const row of droppedResult.rows) {
      const mapped = mapQueue(row.norm_queue);
      if (mapped) {
        queueDropped[mapped] = (queueDropped[mapped] ?? 0) + parseInt(row.cnt);
      }
    }

    // ── 3b. CALLS per agent per queue (deduped) ─────────────────────
    // Uses attr_agent (dest_name with agent_name fallback) to match user's
    // COUNTIFS on Destination Name column
    const agentCallsResult = await query(
      `${DEDUP_CTE}
       SELECT attr_agent, norm_queue, COUNT(*) as cnt
       FROM deduped
       GROUP BY attr_agent, norm_queue`,
      [fromDate, toDate]
    );

    // DEBUG: count funnel steps to find where calls are lost
    const _dbgRawAnswered = await query(
      `SELECT COUNT(*) as cnt FROM queue_calls WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'`,
      [fromDate, toDate]
    );
    const _dbgSalesQueuesOnly = await query(
      `SELECT COUNT(*) as cnt FROM queue_calls WHERE call_date BETWEEN $1 AND $2 AND LOWER(status) = 'answered'
       AND ${NORM_QUEUE_SQL} IN ('mail 1','mail 2','mail 3','mail 4','mail 5','mail 6','home 1','home 2','home 3','home 4','home 5')`,
      [fromDate, toDate]
    );
    const _dbgAfterDedup = await query(
      `${DEDUP_CTE} SELECT COUNT(*) as cnt FROM deduped`,
      [fromDate, toDate]
    );
    const _dbgDedupAllAgents = await query(
      `${DEDUP_CTE} SELECT SUM(cnt)::int as total FROM (SELECT attr_agent, COUNT(*) as cnt FROM deduped GROUP BY attr_agent) x`,
      [fromDate, toDate]
    );

    // Map: agentName -> queue -> calls
    const agentQueueCalls: Map<string, Record<string, number>> = new Map();
    let _dbgTotalBeforeFilter = 0;
    for (const row of agentCallsResult.rows) {
      const agent = (row.attr_agent ?? "").trim();
      const mapped = mapQueue(row.norm_queue);
      if (!agent || !mapped) continue;
      _dbgTotalBeforeFilter += parseInt(row.cnt);
      if (!agentQueueCalls.has(agent)) agentQueueCalls.set(agent, {});
      const rec = agentQueueCalls.get(agent)!;
      rec[mapped] = (rec[mapped] ?? 0) + parseInt(row.cnt);
    }

    // DEBUG: find agents NOT in salesAgentNames that have calls
    const _dbgExcludedAgents: Record<string, number> = {};
    for (const [agent, queueCallMap] of agentQueueCalls) {
      if (!salesAgentNames.has(agent.toLowerCase())) {
        let total = 0;
        for (const cnt of Object.values(queueCallMap)) total += cnt;
        _dbgExcludedAgents[agent] = total;
      }
    }

    // ── 3b2. Compute queue call totals from sales agents only ────────
    for (const [agent, queueCallMap] of agentQueueCalls) {
      if (!salesAgentNames.has(agent.toLowerCase())) continue;
      for (const [q, cnt] of Object.entries(queueCallMap)) {
        queueCalls[q] = (queueCalls[q] ?? 0) + cnt;
        totalCalls += cnt;
      }
    }

    // ── 3c. LOAD deal overrides for manual T.O. reassignment ────────
    let overrideByContract = new Map<string, string>();
    let overrideByCid = new Map<string, string>();
    try {
      const overrideResult = await query(`SELECT contract_no, customer_id, corrected_owner FROM deal_overrides`);
      for (const row of overrideResult.rows) {
        if (row.contract_no) overrideByContract.set(row.contract_no, row.corrected_owner);
        if (row.customer_id) overrideByCid.set(row.customer_id, row.corrected_owner);
      }
    } catch {
      // Table may not exist yet — ignore
    }

    // ── 4. ATTRIBUTE deals to queues and salespersons ────────────────
    const bySalesperson: Record<string, {
      totalDeals: number;
      totalCalls: number;
      closeRate: number;
      queues: Record<string, { deals: number; calls: number }>;
    }> = {};

    const byQueue: Record<string, { deals: number; calls: number; closeRate: number; aiFwd: number; dropped: number }> = {};
    let companyDeals = 0;
    let autoDeals = 0, homeDealCount = 0;
    let csDeals = 0, csAutoDeals = 0, csHomeDeals = 0;
    let aiDeals = 0, aiAutoDeals = 0, aiHomeDeals = 0;
    let spDeals = 0, spAutoDeals = 0, spHomeDeals = 0;
    // F/B 4-corner breakdown (computed after main loop)
    let autoFlip = 0;    // Home queue → auto policy only (no home for that phone)
    let autoBundle = 0;  // Home queue → auto + home policy
    let homeFlip = 0;    // Auto queue → home policy only (no auto for that phone)
    let homeBundle = 0;  // Auto queue → auto + home policy
    let fbDeals = 0, fbInAutoDeals = 0, fbInHomeDeals = 0;
    let autoCalls = 0, homeCallCount = 0;
    // Collect F/B deals for post-loop 4-corner classification
    const fbDealEntries: { phone: string; product: string; queueIsAuto: boolean; queueIsHome: boolean }[] = [];

    const AI_SALESPERSONS = new Set(["jeremy fishbein"]);
    function isAiDeal(sp: string) { return AI_SALESPERSONS.has(sp.toLowerCase()); }

    // T.O. team members already loaded above (toNames set) — reuse for deal attribution
    function isTO(name: string) { return toNames.has(name.toLowerCase()); }

    // Load Spanish team members for Spanish deal identification
    const spTeamResult = await query(
      `SELECT tm.agent_name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE LOWER(t.name) = 'spanish'`
    );
    const spNames = new Set(spTeamResult.rows.map((r: { agent_name: string }) => r.agent_name.toLowerCase()));
    function isSpanishRep(name: string) { return spNames.has(name.toLowerCase()); }

    // Build phone → agent lookup from queue_calls (most recent human-answered call per phone)
    // Only needed if there are T.O.s
    const phoneToAgent = new Map<string, string>();
    if (toNames.size > 0) {
      const phoneAgentResult = await query(
        `SELECT DISTINCT ON (phone) phone, agent_name, call_date
         FROM queue_calls
         WHERE first_ext IS NOT NULL AND first_ext != ''
           AND LENGTH(TRIM(first_ext)) <= 4
           AND TRIM(first_ext) NOT LIKE '99%'
           AND agent_name IS NOT NULL AND agent_name != ''
         ORDER BY phone, call_date DESC`
      );
      for (const row of phoneAgentResult.rows) {
        const p = (row.phone ?? "").trim();
        const agent = (row.agent_name ?? "").trim();
        if (p && agent && !isTO(agent)) {
          phoneToAgent.set(p, agent);
        }
      }
    }

    // Initialize queues
    for (const q of ALL_QUEUES) {
      byQueue[q] = { deals: 0, calls: queueCalls[q] ?? 0, closeRate: 0, aiFwd: queueAiFwd[q] ?? 0, dropped: queueDropped[q] ?? 0 };
      if (isAutoQueue(q)) autoCalls += byQueue[q].calls;
      if (isHomeQueue(q)) homeCallCount += byQueue[q].calls;
    }

    // Track phones that have BOTH auto and home deals in the same month (bundles)
    const phoneProductSet = new Map<string, Set<string>>();

    // Collect T.O. deals that have no override (for the override popup)
    interface TODeal {
      contractNo: string;
      customerId: string;
      firstName: string;
      lastName: string;
      soldDate: string;
      phone: string;
      originalOwner: string;
      suggestedAgent: string | null;
    }
    const toDealsList: TODeal[] = [];

    for (const deal of dealsResult.rows) {
      const closer = deal.salesperson?.trim() || "";  // T.O. / closer
      let salesRep = deal.owner?.trim() || closer;  // Sales Rep (falls back to closer if no owner)

      // Check for manual override FIRST (highest priority)
      const override = overrideByContract.get(deal.contract_no) || overrideByCid.get(deal.customer_id);
      if (override) {
        salesRep = override;
      } else if (isTO(salesRep)) {
        // T.O. fallback: if owner is a known T.O., look up 3CX to find the real sales rep
        const dealPhonesList = [deal.home_phone, deal.mobile_phone]
          .map((p: string) => (p ?? "").replace(/\D/g, "").slice(-10))
          .filter((p: string) => p.length === 10);
        let found3cx = false;
        for (const ph of dealPhonesList) {
          const realAgent = phoneToAgent.get(ph);
          if (realAgent) {
            salesRep = realAgent;
            found3cx = true;
            break;
          }
        }
        // If still a T.O. after 3CX lookup (no agent found), collect for override popup
        if (!found3cx) {
          const soldDate = deal.sold_date instanceof Date ? deal.sold_date.toISOString().slice(0, 10) : String(deal.sold_date).slice(0, 10);
          const phones = dealPhonesList;
          toDealsList.push({
            contractNo: deal.contract_no || '',
            customerId: deal.customer_id || '',
            firstName: deal.first_name || '',
            lastName: deal.last_name || '',
            soldDate,
            phone: phones[0] || '',
            originalOwner: deal.owner || '',
            suggestedAgent: phones.length > 0 ? (phoneToAgent.get(phones[0]) || null) : null,
          });
        }
      }

      const product: string = deal.product; // "auto" or "home"

      const pcEarly = ((deal.promo_code ?? "") as string).trim().toUpperCase();

      // CS, AI, and SP deals count ONLY in Additional Sales — not in queue breakdown
      if (pcEarly === "CS") {
        csDeals++;
        if (product === "auto") csAutoDeals++; else csHomeDeals++;
        companyDeals++;
        if (product === "auto") autoDeals++; else homeDealCount++;
        continue;
      }
      const cidUpper = ((deal.customer_id ?? "") as string).trim().toUpperCase();
      if (isAiDeal(closer) || cidUpper.startsWith("OR")) {
        aiDeals++;
        if (product === "auto") aiAutoDeals++; else aiHomeDeals++;
        companyDeals++;
        if (product === "auto") autoDeals++; else homeDealCount++;
        continue;
      }
      const originalOwner = (deal.owner ?? "").trim();
      const isSpanishDeal = pcEarly === "SP" || isSpanishRep(salesRep) || isSpanishRep(closer) || isSpanishRep(originalOwner);
      if (isSpanishDeal) {
        spDeals++;
        if (product === "auto") spAutoDeals++; else spHomeDeals++;
        companyDeals++;
        if (product === "auto") autoDeals++; else homeDealCount++;
        // Don't continue — fall through to bySalesperson attribution so Spanish reps get credit on Performance tab
        // But mark as Spanish so we skip queue breakdown
        if (salesRep) {
          if (!bySalesperson[salesRep]) {
            bySalesperson[salesRep] = { totalDeals: 0, totalCalls: 0, closeRate: 0, queues: {} };
          }
          bySalesperson[salesRep].totalDeals++;
        }
        continue; // skip queue breakdown
      }

      if (isExcludedSalesperson(salesRep) && isExcludedSalesperson(closer)) continue;

      const soldDate = deal.sold_date instanceof Date ? deal.sold_date.toISOString().slice(0, 10) : String(deal.sold_date).slice(0, 10);
      const phones = [deal.home_phone, deal.mobile_phone]
        .map((p: string) => (p ?? "").replace(/\D/g, "").slice(-10))
        .filter((p: string) => p.length === 10);

      // Find most recent queue ON or BEFORE the sold date
      let dealQueue: string | null = null;
      for (const p of phones) {
        const q = findQueueBeforeDate(p, soldDate);
        if (q) { dealQueue = q; break; }
      }

      // Fallback: apply campaign/promo queue rules
      if (!dealQueue) {
        dealQueue = applyQueueRules(
          deal.campaign || "",
          deal.promo_code || "",
          product as "auto" | "home",
          deal.customer_id || ""
        );
      }

      // CS/AI/SP already handled above via continue — remaining deals need a queue
      if (!dealQueue) continue;

      // Determine category: Auto, Home, or F/B (Flip/Bundle)
      const queueIsAuto = isAutoQueue(dealQueue);
      const queueIsHome = isHomeQueue(dealQueue);
      let category: "auto" | "home" | "fb";

      if (product === "auto" && queueIsAuto) {
        category = "auto";
      } else if (product === "home" && queueIsHome) {
        category = "home";
      } else {
        // Flip: product doesn't match queue division
        category = "fb";
      }

      // Track bundle detection (same phone, both products)
      for (const p of phones) {
        if (!phoneProductSet.has(p)) phoneProductSet.set(p, new Set());
        phoneProductSet.get(p)!.add(product);
      }

      companyDeals++;
      // Only count deal in the queue row if product matches division (not F/B)
      if (category !== "fb" && byQueue[dealQueue]) byQueue[dealQueue].deals++;

      if (category === "auto") autoDeals++;
      else if (category === "home") homeDealCount++;
      else {
        // F/B: product doesn't match queue division
        fbDeals++;
        if (queueIsAuto) {
          fbInHomeDeals++;
          homeDealCount++;
        }
        if (queueIsHome) {
          fbInAutoDeals++;
          autoDeals++;
        }
        // Collect for post-loop 4-corner classification
        const bestPhone = phones[0] || "";
        if (bestPhone) {
          fbDealEntries.push({ phone: bestPhone, product, queueIsAuto, queueIsHome });
        }
      }

      // Track per salesperson using owner (Sales Rep), not closer (T.O.)
      if (dealQueue && salesRep) {
        if (!bySalesperson[salesRep]) {
          bySalesperson[salesRep] = { totalDeals: 0, totalCalls: 0, closeRate: 0, queues: {} };
        }
        bySalesperson[salesRep].totalDeals++;
        if (!bySalesperson[salesRep].queues[dealQueue]) {
          bySalesperson[salesRep].queues[dealQueue] = { deals: 0, calls: 0 };
        }
        bySalesperson[salesRep].queues[dealQueue].deals++;
      }
    }

    // Count bundles (phones with both auto AND home deals)
    let bundleCount = 0;
    for (const [, products] of phoneProductSet) {
      if (products.has("auto") && products.has("home")) bundleCount++;
    }

    // F/B 4-corner classification using phoneProductSet
    for (const entry of fbDealEntries) {
      const products = phoneProductSet.get(entry.phone);
      const hasBoth = products && products.has("auto") && products.has("home");

      if (entry.queueIsHome && entry.product === "auto") {
        // Auto product sold through home queue
        if (hasBoth) autoBundle++; else autoFlip++;
      }
      if (entry.queueIsAuto && entry.product === "home") {
        // Home product sold through auto queue
        if (hasBoth) homeBundle++; else homeFlip++;
      }
    }

    // Populate agent-level calls from agentQueueCalls into bySalesperson
    // Only sales agents get call counts — excluded teams (T.O., Spanish, CS, Unassigned) don't
    for (const [agent, queueCallMap] of agentQueueCalls) {
      if (!salesAgentNames.has(agent.toLowerCase())) continue;
      if (!bySalesperson[agent]) {
        bySalesperson[agent] = { totalDeals: 0, totalCalls: 0, closeRate: 0, queues: {} };
      }
      let agentTotalCalls = 0;
      for (const [q, cnt] of Object.entries(queueCallMap)) {
        if (!bySalesperson[agent].queues[q]) {
          bySalesperson[agent].queues[q] = { deals: 0, calls: 0 };
        }
        bySalesperson[agent].queues[q].calls = cnt;
        agentTotalCalls += cnt;
      }
      bySalesperson[agent].totalCalls = agentTotalCalls;
      bySalesperson[agent].closeRate = agentTotalCalls > 0 ? bySalesperson[agent].totalDeals / agentTotalCalls : 0;
    }
    // For agents with deals but no calls data, ensure totalCalls/closeRate are set
    for (const sp of Object.keys(bySalesperson)) {
      if (!agentQueueCalls.has(sp)) {
        bySalesperson[sp].totalCalls = 0;
        bySalesperson[sp].closeRate = 0;
      }
    }

    // Count closer deals for T.O. agents (deals where they are the salesperson/closer)
    const toCloserStats: Record<string, { deals: number }> = {};
    for (const deal of dealsResult.rows) {
      const closer = (deal.salesperson ?? "").trim();
      if (closer && isTO(closer)) {
        if (!toCloserStats[closer]) toCloserStats[closer] = { deals: 0 };
        toCloserStats[closer].deals++;
      }
    }

    // Compute close rates
    for (const q of ALL_QUEUES) {
      const qs = byQueue[q];
      qs.closeRate = qs.calls > 0 ? qs.deals / qs.calls : 0;
    }

    // ── 5. DAILY TRENDS ─────────────────────────────────────────────
    const trendsResult = await query(
      `SELECT sold_date, COUNT(DISTINCT contract_no) as cnt FROM (
         SELECT sold_date, contract_no FROM moxy_deals WHERE sold_date BETWEEN $1 AND $2 AND deal_status NOT IN ('Back Out', 'VOID', '')
         UNION ALL
         SELECT sold_date, contract_no FROM moxy_home_deals WHERE sold_date BETWEEN $1 AND $2 AND deal_status NOT IN ('Back Out', 'VOID', '')
       ) combined
       GROUP BY sold_date
       ORDER BY sold_date`,
      [fromDate, toDate]
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dailyTrends = trendsResult.rows.map((r: any) => ({
      date: r.sold_date instanceof Date ? r.sold_date.toISOString().slice(0, 10) : String(r.sold_date).slice(0, 10),
      deals: parseInt(r.cnt),
    }));

    // ── 6. STALENESS ────────────────────────────────────────────────
    const metaResult = await query(
      "SELECT source, max_date FROM seed_metadata WHERE source IN ('moxy', 'moxy_home', 'tcx')"
    );
    const staleness: Record<string, string | null> = { moxy: null, moxyHome: null, cx: null };
    for (const row of metaResult.rows) {
      if (row.source === "moxy") staleness.moxy = row.max_date ? String(row.max_date).slice(0, 10) : null;
      if (row.source === "moxy_home") staleness.moxyHome = row.max_date ? String(row.max_date).slice(0, 10) : null;
      if (row.source === "tcx") staleness.cx = row.max_date ? String(row.max_date).slice(0, 10) : null;
    }

    return NextResponse.json({
      companyTotal: {
        deals: companyDeals,
        calls: totalCalls,
        closeRate: totalCalls > 0 ? companyDeals / totalCalls : 0,
      },
      autoTotal: {
        deals: autoDeals,
        calls: autoCalls,
        closeRate: autoCalls > 0 ? autoDeals / autoCalls : 0,
      },
      homeTotal: {
        deals: homeDealCount,
        calls: homeCallCount,
        closeRate: homeCallCount > 0 ? homeDealCount / homeCallCount : 0,
      },
      csDeals: { total: csDeals, auto: csAutoDeals, home: csHomeDeals },
      aiDeals: { total: aiDeals, auto: aiAutoDeals, home: aiHomeDeals },
      spDeals: { total: spDeals, auto: spAutoDeals, home: spHomeDeals },
      fb: {
        autoFlip,
        autoBundle,
        homeFlip,
        homeBundle,
        total: fbDeals,
      },
      fbTotal: {
        deals: fbDeals,
        bundles: bundleCount,
        inAuto: fbInAutoDeals,
        inHome: fbInHomeDeals,
        label: "F/B (Flip / Bundle)",
      },
      byQueue,
      bySalesperson,
      teams: await (async () => {
        try {
          const teamsResult = await query(
            `SELECT t.name as team_name, tm.agent_name
             FROM teams t
             LEFT JOIN team_members tm ON tm.team_id = t.id
             ORDER BY t.id`
          );
          const teams: Record<string, string[]> = {};
          for (const row of teamsResult.rows) {
            if (!teams[row.team_name]) teams[row.team_name] = [];
            if (row.agent_name) teams[row.team_name].push(row.agent_name);
          }
          return teams;
        } catch {
          return {};
        }
      })(),
      dailyTrends,
      staleness,
      dateRange: { from: fromDate, to: toDate },
      toDeals: toDealsList,
      toCloserStats,
      toCalls: { total: toCallCount, byAgent: toByAgent },
      spanishCalls: { total: spanishTotal, byAgent: spanishByAgent, _debug: _spDebug },
      _callDebug: {
        rawAnsweredInDB: parseInt(_dbgRawAnswered.rows[0]?.cnt ?? 0),
        salesQueuesOnly: parseInt(_dbgSalesQueuesOnly.rows[0]?.cnt ?? 0),
        afterPhoneQueueDedup: parseInt(_dbgAfterDedup.rows[0]?.cnt ?? 0),
        allAgentsSumAfterDedup: parseInt(_dbgDedupAllAgents.rows[0]?.total ?? 0),
        totalBeforeSalesFilter: _dbgTotalBeforeFilter,
        totalAfterSalesFilter: totalCalls,
        salesAgentCount: salesAgentNames.size,
        excludedAgentsWithCalls: _dbgExcludedAgents,
      },
    });
  } catch (err) {
    console.error("[sales-data] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
