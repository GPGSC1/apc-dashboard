import { query } from "./connection";

/**
 * Sales Dashboard — Phase 1 Views
 *
 * Encapsulates per-row normalization and dedup logic that previously lived
 * inline in `app/api/sales-data/route.ts`. The route still applies per-request
 * filters (date range, soldOnly, F/B classification) on top of these views.
 *
 * IDEMPOTENT: every object uses CREATE OR REPLACE. Safe to call on every cold start.
 *
 * !!! DO NOT introduce non-IMMUTABLE behavior into normalize_queue() !!!
 * It must remain a pure string transformation so the planner can use it
 * in indexed expressions (Phase 2 prep).
 */

let _installed = false;

export async function ensureSalesViews(): Promise<void> {
  if (_installed) return;
  try {
    // ── 1. normalize_queue() — drop-in for the NORM_QUEUE_SQL CASE block ──
    // Spanish checked BEFORE T.O. to avoid "Spanish - Auto" matching "to" substring.
    await query(`
      CREATE OR REPLACE FUNCTION normalize_queue(q TEXT) RETURNS TEXT AS $$
        SELECT CASE
          WHEN q IS NULL THEN NULL
          WHEN LOWER(q) LIKE '%spanish%' THEN 'spanish'
          WHEN LOWER(q) LIKE '%mail 1%' THEN 'mail 1'
          WHEN LOWER(q) LIKE '%mail 2%' THEN 'mail 2'
          WHEN LOWER(q) LIKE '%mail 3%' THEN 'mail 3'
          WHEN LOWER(q) LIKE '%mail 4%' THEN 'mail 4'
          WHEN LOWER(q) LIKE '%mail 5%' THEN 'mail 5'
          WHEN LOWER(q) LIKE '%mail 6%' THEN 'mail 6'
          WHEN LOWER(q) LIKE '%home 1%' THEN 'home 1'
          WHEN LOWER(q) LIKE '%home 2%' THEN 'home 2'
          WHEN LOWER(q) LIKE '%home 3%' THEN 'home 3'
          WHEN LOWER(q) LIKE '%home 4%' THEN 'home 4'
          WHEN LOWER(q) LIKE '%home 5%' THEN 'home 5'
          WHEN TRIM(LOWER(q)) = 'to' OR LOWER(q) LIKE '% to' OR LOWER(q) LIKE 'to %' THEN 'to'
          ELSE LOWER(TRIM(q))
        END
      $$ LANGUAGE SQL IMMUTABLE;
    `);

    // ── 2. v_queue_calls_attributed — DEDUP_CTE replacement ──
    // Filters: status='answered', queue ∈ sales (mail 1-6, home 1-5).
    // Adds attr_agent (dest_name with agent_name fallback) + norm_queue.
    // Route adds: WHERE call_date BETWEEN $1 AND $2.
    await query(`
      CREATE OR REPLACE VIEW v_queue_calls_attributed AS
      SELECT
        phone,
        call_date,
        COALESCE(NULLIF(TRIM(dest_name), ''), agent_name) AS attr_agent,
        normalize_queue(queue) AS norm_queue
      FROM queue_calls
      WHERE LOWER(status) = 'answered'
        AND normalize_queue(queue) IN (
          'mail 1','mail 2','mail 3','mail 4','mail 5','mail 6',
          'home 1','home 2','home 3','home 4','home 5'
        )
    `);

    // ── 3. v_queue_ai_fwd — AI-FWD source ──
    // AI-FWD: ext starts with 99, OR (blank ext + 11-digit dest starting with '1').
    // Route adds: WHERE call_date BETWEEN $1 AND $2; GROUP BY norm_queue.
    await query(`
      CREATE OR REPLACE VIEW v_queue_ai_fwd AS
      SELECT
        phone,
        call_date,
        normalize_queue(queue) AS norm_queue
      FROM queue_calls
      WHERE
        (first_ext IS NOT NULL AND first_ext != '' AND TRIM(first_ext) LIKE '99%')
        OR (
          (first_ext IS NULL OR first_ext = '')
          AND destination IS NOT NULL
          AND LENGTH(TRIM(destination)) = 11
          AND TRIM(destination) LIKE '1%'
        )
    `);

    // ── 4. v_queue_dropped_candidates — Dropped source (date-scoped NOT EXISTS stays in route) ──
    await query(`
      CREATE OR REPLACE VIEW v_queue_dropped_candidates AS
      SELECT
        phone,
        call_date,
        normalize_queue(queue) AS norm_queue
      FROM queue_calls
      WHERE (first_ext IS NULL OR first_ext = '')
        AND (
          destination IS NULL
          OR LENGTH(TRIM(destination)) != 11
          OR TRIM(destination) NOT LIKE '1%'
        )
    `);

    // ── 5. (intentionally not a view) phone queue history ──
    // The route still reads phone history via raw `queue_calls` with chunked
    // IN clauses — switching to ANY($1::text[]) on a view changed the query
    // plan and tie-broke (phone, call_date) duplicates differently, shifting
    // deals between queues. Math fidelity > query elegance. See parity script.

    // ── 6. v_to_transfers_attributed — T.O./Spanish source ──
    // Route adds: WHERE call_date BETWEEN $1 AND $2; GROUP BY dest_name, queue.
    await query(`
      CREATE OR REPLACE VIEW v_to_transfers_attributed AS
      SELECT call_date, dest_name, queue
      FROM to_transfers
      WHERE dest_name IS NOT NULL AND dest_name != ''
    `);

    // ── 7. v_sales_agent_names — bottom-up team filter ──
    // Excludes T.O., Spanish, Customer Service, Unassigned via substring match
    // (mirrors the JS EXCLUDED_PATTERNS.some() in the route).
    // Returns lowercase agent_name for case-insensitive comparison.
    await query(`
      CREATE OR REPLACE VIEW v_sales_agent_names AS
      SELECT DISTINCT LOWER(TRIM(tm.agent_name)) AS agent_name
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      WHERE tm.agent_name IS NOT NULL
        AND tm.agent_name != ''
        AND NOT (
          LOWER(TRIM(t.name)) IN ('t.o.', 'to.', 'spanish', 'customer service', 'unassigned')
          OR LOWER(t.name) LIKE '%t.o.%'
          OR LOWER(t.name) LIKE '%to.%'
          OR LOWER(t.name) LIKE '%spanish%'
          OR LOWER(t.name) LIKE '%customer service%'
          OR LOWER(t.name) LIKE '%unassigned%'
        )
    `);

    // ── 8. v_team_members_by_role — Spanish/T.O./Sales roster in one query ──
    // Replaces the separate spanishTeamResult / toTeamResult / spTeamResult queries.
    // team_role: 'spanish' | 'to' | 'sales'
    await query(`
      CREATE OR REPLACE VIEW v_team_members_by_role AS
      SELECT
        CASE
          WHEN LOWER(t.name) = 'spanish' THEN 'spanish'
          WHEN LOWER(t.name) IN ('t.o.', 'to.') THEN 'to'
          ELSE 'sales'
        END AS team_role,
        LOWER(TRIM(tm.agent_name)) AS agent_name_lower,
        tm.agent_name AS agent_name_raw
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      WHERE tm.agent_name IS NOT NULL
        AND tm.agent_name != ''
    `);

    // ── 9. v_phone_to_agent_latest — most recent human-answering agent per phone ──
    // DISTINCT ON intent: one row per phone, picking latest call_date.
    await query(`
      CREATE OR REPLACE VIEW v_phone_to_agent_latest AS
      SELECT DISTINCT ON (phone)
        phone,
        agent_name,
        call_date
      FROM queue_calls
      WHERE first_ext IS NOT NULL
        AND first_ext != ''
        AND LENGTH(TRIM(first_ext)) <= 4
        AND TRIM(first_ext) NOT LIKE '99%'
        AND agent_name IS NOT NULL
        AND agent_name != ''
      ORDER BY phone, call_date DESC
    `);

    // ── 10. v_daily_trends — daily distinct contract counts (auto + home) ──
    // Status filter (NOT IN ('Back Out', 'VOID', '')) baked in — trends always
    // exclude these regardless of caller's soldOnly param.
    // Route adds: WHERE sold_date BETWEEN $1 AND $2 ORDER BY sold_date.
    await query(`
      CREATE OR REPLACE VIEW v_daily_trends AS
      SELECT sold_date, COUNT(DISTINCT contract_no) AS cnt FROM (
        SELECT sold_date, contract_no FROM moxy_deals
         WHERE deal_status NOT IN ('Back Out', 'VOID', '')
        UNION ALL
        SELECT sold_date, contract_no FROM moxy_home_deals
         WHERE deal_status NOT IN ('Back Out', 'VOID', '')
      ) combined
      GROUP BY sold_date
    `);

    // ── 11. v_moxy_deals_deduped — auto deal dedup ──
    // Per Matt: "all dedupe and filter logic should be in Neon tables."
    // Dedups by (customer_id, deal_status, sold_date) — ONE row per customer
    // per status per day. Handles the "Moxy reassigned the contract_no"
    // pattern (4 known cases: Kia Johnson, David Fire, Hernan Silva,
    // Barbara Robbin where pre-Phase-2b refreshMoxy wrote multiple CN rows
    // for the same deal). Also drops the 41 ghost empty-CN rows by
    // preferring non-empty CN within the partition.
    //
    // Tiebreaker order within (cid, status, sold_date) bucket:
    //   1. Non-empty contract_no preferred over empty
    //   2. Higher contract_no DESC (matches Moxy's UI display for 3 of 4
    //      known multi-CN cases — David Fire is the one outlier where
    //      MAS3161115346 is alphabetically higher than the canonical
    //      GPG515890; cosmetic only, count is correct)
    //
    // Route reads: SELECT ... FROM v_moxy_deals_deduped WHERE sold_date
    // BETWEEN $1 AND $2 AND <status filter>. The date filter on top of the
    // view-level dedup is safe because the dedup partition includes
    // sold_date (a customer with deals on different days = different rows
    // kept; only same-day-multiple-CN collapses).
    await query(`
      CREATE OR REPLACE VIEW v_moxy_deals_deduped AS
      SELECT DISTINCT ON (customer_id, deal_status, sold_date)
        customer_id, contract_no, salesperson, owner,
        home_phone, mobile_phone, sold_date, deal_status,
        make, model, campaign, promo_code, first_name, last_name,
        cust_cost, dealer_cost, down_payment, finance_term, finance_company,
        admin, source, cancel_reason, state
      FROM moxy_deals
      WHERE deal_status != ''
      ORDER BY customer_id, deal_status, sold_date,
               (CASE WHEN contract_no IS NOT NULL AND contract_no != '' THEN 0 ELSE 1 END),
               contract_no DESC NULLS LAST
    `);

    // ── 12. v_moxy_home_deals_deduped — home deal dedup ──
    // Same shape and dedup rules as v_moxy_deals_deduped.
    // Note: home table has no make/model columns, plus has division column.
    await query(`
      CREATE OR REPLACE VIEW v_moxy_home_deals_deduped AS
      SELECT DISTINCT ON (customer_id, deal_status, sold_date)
        customer_id, contract_no, salesperson, owner,
        home_phone, mobile_phone, sold_date, deal_status,
        campaign, promo_code, first_name, last_name,
        cust_cost, dealer_cost, down_payment, finance_term, finance_company,
        admin, source, cancel_reason, state, division
      FROM moxy_home_deals
      WHERE deal_status != ''
      ORDER BY customer_id, deal_status, sold_date,
               (CASE WHEN contract_no IS NOT NULL AND contract_no != '' THEN 0 ELSE 1 END),
               contract_no DESC NULLS LAST
    `);

    _installed = true;
  } catch (e) {
    // Likely cause: concurrent write transaction holding ACCESS EXCLUSIVE
    // on a source table. Don't poison the cached _installed flag — the
    // next request will retry, and the views are idempotent.
    console.error("[ensureSalesViews] install failed (will retry next request):", e);
    throw e;
  }
}
