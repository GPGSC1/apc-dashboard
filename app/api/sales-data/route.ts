import { NextResponse } from "next/server";
import { query } from "../../../lib/db/connection";
import { todayLocal } from "../../../lib/date-utils";
import { mapQueue, isAutoQueue, isHomeQueue, ALL_QUEUES } from "../../../lib/queue-map";
import { TEAMS, isExcludedSalesperson } from "../../../lib/teams";

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
  product: "auto" | "home"
): string | null {
  const c = (campaign ?? "").trim().toUpperCase();
  const pc = (promoCode ?? "").trim().toUpperCase();

  if (product === "auto") {
    // Priority 1: PromoCode exact "API"
    if (pc === "API") return "A4";

    // Priority 5-8: Campaign starts with FWM / WF / FTD / FD
    if (c.startsWith("FWM")) return "A3";
    if (c.startsWith("WF")) return "A3";
    if (c.startsWith("FTD")) return "A3";
    if (c.startsWith("FD")) return "A3";

    // Priority 20-37: Various campaign prefixes → A2
    const a2Prefixes = [
      "DMW", "MKA", "DMC", "SCD", "APD", "TDM", "SDC", "TDN", "TDS", "MX",
      "2DMWTD", "PMI", "SAC TD", "TD_", "TDV", "TDSF", "TDT",
    ];
    for (const pfx of a2Prefixes) {
      if (c.startsWith(pfx)) return "A2";
    }
    if (c.includes("PMI")) return "A2";

    // Campaign REGEX /^MKA.{3}KA/ → A1
    if (/^MKA.{3}KA/i.test(c)) return "A1";

    // Campaign MID(4,2) exact matches → A1
    if (c.length >= 6) {
      const mid = c.substring(4, 6);
      const a1Mids = new Set([
        "KC", "KH", "KL", "LA", "KZ", "KQ", "PB", "KR", "KS", "KT",
        "KU", "KV", "KM", "KB", "LB", "CA", "KN", "KD", "KE", "CC",
        "PA", "SA", "KW", "KA", "LC",
      ]);
      if (a1Mids.has(mid)) return "A1";
    }

    // Campaign REGEX /^\d{3}[A-Z]{2}$/ → A1
    if (/^\d{3}[A-Z]{2}$/.test(c)) return "A1";
  }

  if (product === "home") {
    if (c.startsWith("TDH")) return "H2";
    if (c.startsWith("TAB")) return "H3";
    if (/^\d{3}[A-Z]{2}$/.test(c)) return "H1";
    if (c.startsWith("132883-GPGH")) return "H1";
  }

  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fromDate = url.searchParams.get("start") ?? todayLocal();
  const toDate = url.searchParams.get("end") ?? todayLocal();

  try {
    // ── 1. DEALS from Moxy Auto + Moxy Home ─────────────────────────
    const autoDealsResult = await query(
      `SELECT DISTINCT ON (customer_id || '|' || contract_no)
         customer_id, contract_no, salesperson, home_phone, mobile_phone, sold_date, deal_status, make, model, campaign, promo_code
       FROM moxy_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')
       ORDER BY customer_id || '|' || contract_no, sold_date DESC`,
      [fromDate, toDate]
    );
    const homeDealsResult = await query(
      `SELECT DISTINCT ON (customer_id || '|' || contract_no)
         customer_id, contract_no, salesperson, home_phone, mobile_phone, sold_date, deal_status, campaign, promo_code
       FROM moxy_home_deals
       WHERE sold_date BETWEEN $1 AND $2
         AND deal_status NOT IN ('Back Out', 'VOID', '')
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

    // ── 3. CALLS: unique phones per queue in date range ─────────────
    // Human answered: has 4-digit extension NOT starting with 99
    const callsResult = await query(
      `SELECT queue, COUNT(DISTINCT phone) as cnt
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2
         AND first_ext IS NOT NULL AND first_ext != ''
         AND LENGTH(TRIM(first_ext)) <= 4
         AND TRIM(first_ext) NOT LIKE '99%'
       GROUP BY queue`,
      [fromDate, toDate]
    );
    const queueCalls: Record<string, number> = {};
    let totalCalls = 0;
    for (const row of callsResult.rows) {
      const mapped = mapQueue(row.queue);
      if (mapped) {
        const cnt = parseInt(row.cnt);
        queueCalls[mapped] = (queueCalls[mapped] ?? 0) + cnt;
        totalCalls += cnt;
      }
    }

    // AI-forwarded calls: either ext starts with 99, OR blank ext with 11-digit destination (forwarded to AI)
    const aiFwdResult = await query(
      `SELECT queue, COUNT(DISTINCT phone) as cnt
       FROM queue_calls
       WHERE call_date BETWEEN $1 AND $2
         AND (
           (first_ext IS NOT NULL AND first_ext != '' AND TRIM(first_ext) LIKE '99%')
           OR
           ((first_ext IS NULL OR first_ext = '') AND destination IS NOT NULL AND LENGTH(TRIM(destination)) = 11 AND TRIM(destination) LIKE '1%')
         )
       GROUP BY queue`,
      [fromDate, toDate]
    );
    const queueAiFwd: Record<string, number> = {};
    for (const row of aiFwdResult.rows) {
      const mapped = mapQueue(row.queue);
      if (mapped) {
        queueAiFwd[mapped] = (queueAiFwd[mapped] ?? 0) + parseInt(row.cnt);
      }
    }

    // Dropped calls: blank ext, NOT forwarded to AI (no 11-digit destination),
    // and phone was NEVER answered in that queue during the entire date range.
    const droppedResult = await query(
      `SELECT queue, COUNT(DISTINCT phone) as cnt
       FROM queue_calls d
       WHERE d.call_date BETWEEN $1 AND $2
         AND (d.first_ext = '' OR d.first_ext IS NULL)
         AND (d.destination IS NULL OR LENGTH(TRIM(d.destination)) != 11 OR TRIM(d.destination) NOT LIKE '1%')
         AND NOT EXISTS (
           SELECT 1 FROM queue_calls a
           WHERE a.phone = d.phone
             AND a.queue = d.queue
             AND a.call_date BETWEEN $1 AND $2
             AND (
               (a.first_ext IS NOT NULL AND a.first_ext != '')
               OR (a.destination IS NOT NULL AND LENGTH(TRIM(a.destination)) = 11 AND TRIM(a.destination) LIKE '1%')
             )
         )
       GROUP BY queue`,
      [fromDate, toDate]
    );
    const queueDropped: Record<string, number> = {};
    for (const row of droppedResult.rows) {
      const mapped = mapQueue(row.queue);
      if (mapped) {
        queueDropped[mapped] = (queueDropped[mapped] ?? 0) + parseInt(row.cnt);
      }
    }

    // ── 4. ATTRIBUTE deals to queues and salespersons ────────────────
    const bySalesperson: Record<string, {
      totalDeals: number;
      queues: Record<string, { deals: number }>;
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

    // Initialize queues
    for (const q of ALL_QUEUES) {
      byQueue[q] = { deals: 0, calls: queueCalls[q] ?? 0, closeRate: 0, aiFwd: queueAiFwd[q] ?? 0, dropped: queueDropped[q] ?? 0 };
      if (isAutoQueue(q)) autoCalls += byQueue[q].calls;
      if (isHomeQueue(q)) homeCallCount += byQueue[q].calls;
    }

    // Track phones that have BOTH auto and home deals in the same month (bundles)
    const phoneProductSet = new Map<string, Set<string>>();

    for (const deal of dealsResult.rows) {
      const sp = deal.salesperson?.trim();
      if (!sp) continue;

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
      if (isAiDeal(sp)) {
        aiDeals++;
        if (product === "auto") aiAutoDeals++; else aiHomeDeals++;
        companyDeals++;
        if (product === "auto") autoDeals++; else homeDealCount++;
        continue;
      }
      if (pcEarly === "SP") {
        spDeals++;
        if (product === "auto") spAutoDeals++; else spHomeDeals++;
        companyDeals++;
        if (product === "auto") autoDeals++; else homeDealCount++;
        continue;
      }

      if (isExcludedSalesperson(sp)) continue;

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
          product as "auto" | "home"
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

      // Track per salesperson (only if deal has a queue)
      if (dealQueue) {
        if (!bySalesperson[sp]) {
          bySalesperson[sp] = { totalDeals: 0, queues: {} };
        }
        bySalesperson[sp].totalDeals++;
        if (!bySalesperson[sp].queues[dealQueue]) {
          bySalesperson[sp].queues[dealQueue] = { deals: 0 };
        }
        bySalesperson[sp].queues[dealQueue].deals++;
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
      teams: TEAMS,
      dailyTrends,
      staleness,
      dateRange: { from: fromDate, to: toDate },
    });
  } catch (err) {
    console.error("[sales-data] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
