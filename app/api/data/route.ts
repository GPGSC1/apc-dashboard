import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { query } from "../../../lib/db/connection";
import { parseDate, todayLocal } from "../../../lib/date-utils";

/**
 * DATA ROUTE — Reads from Postgres (Neon) instead of local JSON files.
 *
 * Business logic is identical to the original JSON-based route:
 * - Triple gate: mail4 + list membership + queue recency
 * - AIM phone history tiebreaker for multi-list attribution
 * - Agent grid with proportional min/cost allocation
 *
 * Fallback: If POSTGRES_URL is not set, falls back to JSON files.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const CAMPAIGN_START = "2026-02-25";

const DEFAULT_LISTS: Record<string, number> = {
  RT: 0,
  JL021926LP: 8000,
  BL021926BO: 8000,
  JH022326MN: 8000,
  JL021926CR: 8000,
  DG021726SC: 5000,
  JL022526RS: 6000,
};

// ─── UTILITIES ───────────────────────────────────────────────────────────
function cleanPhone(raw: unknown): string {
  let s = String(raw || "").replace(/^=/, "").replace(/^"/, "").replace(/"$/, "");
  const d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

function loadListCosts(): Record<string, number> {
  const costFile = path.join(DATA_DIR, "list_costs.json");
  if (fs.existsSync(costFile)) {
    try { return JSON.parse(fs.readFileSync(costFile, "utf8")); } catch { /* fall */ }
  }
  return DEFAULT_LISTS;
}

// ─── LIST ATTRIBUTION WITH AIM TIEBREAKER ────────────────────────────────
function attributeToList(
  phone: string,
  phoneToLists: Map<string, string[]>,
  aimPhoneHistory: Map<string, string[]>
): string | null {
  const lists = phoneToLists.get(phone) || [];
  if (lists.length === 1) return lists[0];
  if (lists.length === 0) return null;

  // Multiple lists: use AIM history (most recent call)
  const history = aimPhoneHistory.get(phone) || [];
  if (history.length > 0) return history[0];

  // Fallback to first list
  return lists[0];
}

// ─── MAIN ROUTE HANDLER ──────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const startMs = Date.now();
    const { searchParams } = new URL(request.url);
    const fromDate = searchParams.get("start") ?? CAMPAIGN_START;
    const toDate = searchParams.get("end") ?? todayLocal();

    const listCosts = loadListCosts();
    const loadedFiles: string[] = [];

    // ─── 1. LOAD LIST PHONES (phone → list mappings) ────────────────────
    const phoneToLists: Map<string, string[]> = new Map();
    const listPhones: Record<string, Set<string>> = {};

    const listResult = await query("SELECT phone, list_key FROM list_phones");
    for (const row of listResult.rows) {
      const phone = row.phone.trim();
      const listKey = row.list_key.trim();
      if (!phoneToLists.has(phone)) phoneToLists.set(phone, []);
      phoneToLists.get(phone)!.push(listKey);
      if (!listPhones[listKey]) listPhones[listKey] = new Set();
      listPhones[listKey].add(phone);
    }
    loadedFiles.push("list_phones (postgres)");

    // ─── 2. BUILD AIM PHONE HISTORY FOR TIEBREAKER ──────────────────────
    const aimPhoneHistory: Map<string, string[]> = new Map();

    // Get all phones that appear in transfers for the history lookup
    const historyResult = await query(
      "SELECT phone, list_key FROM aim_phone_history ORDER BY call_date DESC"
    );
    for (const row of historyResult.rows) {
      const phone = row.phone.trim();
      const listKey = row.list_key.trim();
      if (!aimPhoneHistory.has(phone)) aimPhoneHistory.set(phone, []);
      aimPhoneHistory.get(phone)!.push(listKey);
    }

    // ─── Phone-to-agent map (from all calls, not just transfers) ────────
    const phoneToAgent: Map<string, string> = new Map();

    // First: transfer agents take priority (loaded from aim_transfers)
    const transferAgentsResult = await query(
      "SELECT DISTINCT ON (phone) phone, agent FROM aim_transfers ORDER BY phone, call_date DESC"
    );
    for (const row of transferAgentsResult.rows) {
      const phone = row.phone.trim();
      if (row.agent) phoneToAgent.set(phone, row.agent);
    }

    // Then: all-call agents as fallback
    const allAgentsResult = await query(
      "SELECT phone, agent FROM aim_phone_agent"
    );
    for (const row of allAgentsResult.rows) {
      const phone = row.phone.trim();
      if (!phoneToAgent.has(phone) && row.agent) {
        phoneToAgent.set(phone, row.agent);
      }
    }

    // ─── AIM transfers in range (for aimTransferPhones set + agent grid) ─
    const aimTransferPhones: Set<string> = new Set();
    const aimRangePhonesByList: Record<string, string[]> = {};

    const transfersInRangeResult = await query(
      "SELECT phone, list_key, agent FROM aim_transfers WHERE call_date BETWEEN $1 AND $2",
      [fromDate, toDate]
    );
    for (const row of transfersInRangeResult.rows) {
      const phone = row.phone.trim();
      const listKey = row.list_key?.trim() || "";
      aimTransferPhones.add(phone);
      if (listKey) {
        if (!aimRangePhonesByList[listKey]) aimRangePhonesByList[listKey] = [];
        aimRangePhonesByList[listKey].push(phone);
      }
    }

    // Also add all-time transfer phones (for the transfer check on list phones)
    const allTransferPhonesResult = await query(
      "SELECT DISTINCT phone FROM aim_transfers"
    );
    for (const row of allTransferPhonesResult.rows) {
      aimTransferPhones.add(row.phone.trim());
    }

    // ─── AIM max date ───────────────────────────────────────────────────
    const aimMaxResult = await query(
      "SELECT max_date FROM seed_metadata WHERE source = 'aim'"
    );
    const aimMaxDate = aimMaxResult.rows[0]?.max_date
      ? String(aimMaxResult.rows[0].max_date).slice(0, 10)
      : null;

    // ─── AIM daily costs by list (summed in date range) ─────────────────
    const aimByList: Record<string, { min: number; cost: number }> = {};
    const dcResult = await query(
      "SELECT list_key, SUM(minutes) as min, SUM(cost) as cost FROM aim_daily_costs WHERE call_date BETWEEN $1 AND $2 GROUP BY list_key",
      [fromDate, toDate]
    );
    for (const row of dcResult.rows) {
      const listKey = row.list_key.trim();
      aimByList[listKey] = {
        min: Math.round(parseFloat(row.min)),
        cost: Math.round(parseFloat(row.cost) * 100) / 100,
      };
    }

    // ─── AIM agent daily costs (summed in date range) + agent transfer counts ─
    const aimByAgent: Record<string, { min: number; cost: number; t: number }> = {};
    const adcResult = await query(
      "SELECT agent, SUM(minutes) as min, SUM(cost) as cost FROM aim_agent_daily_costs WHERE call_date BETWEEN $1 AND $2 GROUP BY agent",
      [fromDate, toDate]
    );
    for (const row of adcResult.rows) {
      aimByAgent[row.agent] = {
        min: Math.round(parseFloat(row.min)),
        cost: Math.round(parseFloat(row.cost) * 100) / 100,
        t: 0,
      };
    }

    // Count transfers per agent in range
    const agentTransferResult = await query(
      "SELECT agent, COUNT(*) as cnt FROM aim_transfers WHERE call_date BETWEEN $1 AND $2 AND agent IS NOT NULL GROUP BY agent",
      [fromDate, toDate]
    );
    for (const row of agentTransferResult.rows) {
      if (!aimByAgent[row.agent]) {
        aimByAgent[row.agent] = { min: 0, cost: 0, t: 0 };
      }
      aimByAgent[row.agent].t = parseInt(row.cnt);
    }

    // ─── 3. LOAD 3CX ITD GATE DATA ─────────────────────────────────────
    const mail4Phones: Set<string> = new Set();
    const phoneLastQueue: Map<string, { queue: string; date: string }> = new Map();

    const mail4Result = await query("SELECT phone FROM mail4_phones");
    for (const row of mail4Result.rows) {
      mail4Phones.add(row.phone.trim());
    }

    const plqResult = await query("SELECT phone, queue, call_date FROM phone_last_queue");
    for (const row of plqResult.rows) {
      phoneLastQueue.set(row.phone.trim(), {
        queue: row.queue,
        date: String(row.call_date).slice(0, 10),
      });
    }

    const tcxMaxResult = await query(
      "SELECT max_date FROM seed_metadata WHERE source = 'tcx'"
    );
    const tcxMaxDate = tcxMaxResult.rows[0]?.max_date
      ? String(tcxMaxResult.rows[0].max_date).slice(0, 10)
      : null;

    // ─── 4. PROCESS 3CX OPENED CALLS ───────────────────────────────────
    const openedByList: Record<string, number> = {};
    let totalOpenedCalls = 0;

    const openedResult = await query(
      "SELECT phone FROM opened_calls WHERE call_date BETWEEN $1 AND $2",
      [fromDate, toDate]
    );
    for (const row of openedResult.rows) {
      const phone = row.phone.trim();
      totalOpenedCalls++;
      const listKey = attributeToList(phone, phoneToLists, aimPhoneHistory);
      if (listKey) {
        openedByList[listKey] = (openedByList[listKey] ?? 0) + 1;
      }
    }

    // ─── 5. PROCESS MOXY SALES ──────────────────────────────────────────
    interface MoxySale {
      soldDate: string | null;
      homePhone: string;
      mobilePhone: string;
      salesperson: string;
      customerId: string;
    }
    let salesRows: MoxySale[] = [];
    let moxyMaxDate: string | null = null;
    const seenDeals = new Set<string>();

    const moxyResult = await query(
      `SELECT customer_id, contract_no, sold_date, home_phone, mobile_phone, salesperson, deal_status
       FROM moxy_deals
       WHERE sold_date >= $1
         AND sold_date BETWEEN $2 AND $3
         AND deal_status IS NOT NULL
         AND TRIM(deal_status) <> ''
         AND LOWER(TRIM(deal_status)) NOT IN ('back out', 'void')`,
      [CAMPAIGN_START, fromDate, toDate]
    );

    for (const row of moxyResult.rows) {
      const soldDate = row.sold_date ? String(row.sold_date).slice(0, 10) : null;
      if (!soldDate) continue;

      const dealSt = String(row.deal_status ?? "").toLowerCase();
      if (dealSt === "back out" || dealSt === "void" || !dealSt) continue;

      const cid = String(row.customer_id ?? "").trim();
      const cno = String(row.contract_no ?? "").trim();
      const isDuplicate =
        (cid !== "" && seenDeals.has(cid)) ||
        (cno !== "" && seenDeals.has(cno));
      if (isDuplicate) continue;
      if (cid) seenDeals.add(cid);
      if (cno) seenDeals.add(cno);

      const hp = cleanPhone(row.home_phone ?? "");
      const mp = cleanPhone(row.mobile_phone ?? "");

      salesRows.push({
        soldDate,
        homePhone: hp,
        mobilePhone: mp,
        salesperson: String(row.salesperson ?? ""),
        customerId: cid,
      });
      if (!moxyMaxDate || soldDate > moxyMaxDate) moxyMaxDate = soldDate;
    }

    // ─── 6. COMPUTE METRICS ─────────────────────────────────────────────
    const allListKeys = new Set([...Object.keys(DEFAULT_LISTS), ...Object.keys(listPhones)]);

    const byList: Record<string, { t: number; o: number; s: number; min: number; cost: number; listCost: number }> = {};
    for (const listKey of allListKeys) {
      byList[listKey as string] = {
        t: 0,
        o: 0,
        s: 0,
        min: aimByList[listKey as string]?.min ?? 0,
        cost: aimByList[listKey as string]?.cost ?? 0,
        listCost: listCosts[listKey as string] ?? 0,
      };
    }

    // TRANSFERS: phone in source list AND in AIM transfers
    for (const [listKey, phones] of Object.entries(listPhones)) {
      phones.forEach((phone) => {
        if (aimTransferPhones.has(phone)) byList[listKey].t++;
      });
    }

    // OPENED: raw call counts per list
    for (const [listKey, count] of Object.entries(openedByList)) {
      if (byList[listKey]) byList[listKey].o += count;
    }

    // SALES: apply sales attribution logic
    const nonListSales: Array<MoxySale & { onOpened: boolean }> = [];
    const seenSalesKeys = new Set<string>();

    for (const s of salesRows) {
      const key = s.customerId || `${s.homePhone}|${s.mobilePhone}`;
      if (seenSalesKeys.has(key)) continue;
      seenSalesKeys.add(key);

      if (!s.salesperson || s.salesperson.toLowerCase().includes("fishbein")) {
        continue;
      }

      const phones = [s.homePhone, s.mobilePhone].filter((p) => p.length === 10);
      if (phones.length === 0) continue;

      const phoneInMail4 = phones.find((p) => mail4Phones.has(p));
      if (!phoneInMail4) continue;

      const allPhonesHaveRecencyCheck = phones.every((p) => {
        const lastQueue = phoneLastQueue.get(p);
        if (!lastQueue) return true;
        return lastQueue.queue.includes("mail 4") || lastQueue.queue.includes("home");
      });

      if (!allPhonesHaveRecencyCheck) {
        const onOpened = phones.some((p) => {
          const lists = phoneToLists.get(p);
          return lists && lists.length > 0;
        });
        nonListSales.push({ ...s, onOpened });
        continue;
      }

      const attributedPhone = phones.find((p) => {
        const list = attributeToList(p, phoneToLists, aimPhoneHistory);
        return list !== null;
      });

      if (!attributedPhone) {
        const onOpened = phones.some((p) => {
          const lists = phoneToLists.get(p);
          return lists && lists.length > 0;
        });
        nonListSales.push({ ...s, onOpened });
        continue;
      }

      const listKey = attributeToList(attributedPhone, phoneToLists, aimPhoneHistory);
      if (listKey && byList[listKey]) {
        byList[listKey].s++;
      }
    }

    // ─── 7. BUILD AGENT METRICS ─────────────────────────────────────────
    const byAgent: Record<string, { calls: number; min: number; cost: number; t: number; deals: number }> = {};

    for (const [agent, stats] of Object.entries(aimByAgent)) {
      byAgent[agent] = {
        calls: 0,
        min: stats.min,
        cost: stats.cost,
        t: stats.t,
        deals: 0,
      };
    }

    // Count deals per agent (using ITD phone→agent map)
    for (const s of salesRows) {
      if (!s.salesperson || s.salesperson.toLowerCase().includes("fishbein")) continue;

      const phones = [s.homePhone, s.mobilePhone].filter((p) => p.length === 10);
      const phoneInMail4 = phones.find((p) => mail4Phones.has(p));
      if (!phoneInMail4) continue;

      const allPhonesOk = phones.every((p) => {
        const lastQueue = phoneLastQueue.get(p);
        if (!lastQueue) return true;
        return lastQueue.queue.includes("mail 4") || lastQueue.queue.includes("home");
      });
      if (!allPhonesOk) continue;

      const attributedPhone = phones.find((p) =>
        attributeToList(p, phoneToLists, aimPhoneHistory)
      );
      if (!attributedPhone) continue;

      const agent = phoneToAgent.get(attributedPhone);
      if (agent) {
        if (!byAgent[agent]) {
          byAgent[agent] = { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
        }
        byAgent[agent].deals++;
      }
    }

    // ─── 8. BUILD aimByAgentGrid ────────────────────────────────────────
    const allAgents = Object.keys(byAgent);
    const allLists = Array.from(allListKeys);

    const matrix: Record<string, Record<string, { t: number; d: number }>> = {};
    for (const agent of allAgents) {
      matrix[agent] = {};
      for (const listKey of allLists) {
        matrix[agent][listKey as string] = { t: 0, d: 0 };
      }
    }

    // Transfer counts — use date-filtered AIM phones
    for (const [listKey, phones] of Object.entries(aimRangePhonesByList)) {
      for (const phone of phones) {
        const agent = phoneToAgent.get(phone);
        if (agent && matrix[agent]?.[listKey]) {
          matrix[agent][listKey].t++;
        }
      }
    }

    // Deal counts
    for (const s of salesRows) {
      if (!s.salesperson || s.salesperson.toLowerCase().includes("fishbein")) continue;
      const phones = [s.homePhone, s.mobilePhone].filter((p) => p.length === 10);
      const phoneInMail4 = phones.find((p) => mail4Phones.has(p));
      if (!phoneInMail4) continue;
      const allPhonesOk = phones.every((p) => {
        const lastQueue = phoneLastQueue.get(p);
        if (!lastQueue) return true;
        return lastQueue.queue.includes("mail 4") || lastQueue.queue.includes("home");
      });
      if (!allPhonesOk) continue;
      const attributedPhone = phones.find((p) =>
        attributeToList(p, phoneToLists, aimPhoneHistory)
      );
      if (!attributedPhone) continue;
      const listKey = attributeToList(attributedPhone, phoneToLists, aimPhoneHistory);
      const agent = phoneToAgent.get(attributedPhone);
      if (agent && listKey && matrix[agent]?.[listKey]) {
        matrix[agent][listKey].d++;
      }
    }

    // Allocate agent's min/cost proportionally by transfers
    const aimByAgentGrid: Record<
      string,
      Record<string, { min: number; cost: number; t: number; s: number }>
    > = {};
    for (const agent of allAgents) {
      aimByAgentGrid[agent] = {};
      const totalMin = aimByAgent[agent]?.min ?? 0;
      const totalCost = aimByAgent[agent]?.cost ?? 0;

      let totalTransfers = 0;
      for (const listKey of allLists) {
        totalTransfers += matrix[agent]?.[listKey as string]?.t ?? 0;
      }

      for (const listKey of allLists) {
        const transfers = matrix[agent]?.[listKey as string]?.t ?? 0;
        const deals = matrix[agent]?.[listKey as string]?.d ?? 0;
        let allocMin = 0,
          allocCost = 0;

        if (transfers > 0 && totalTransfers > 0) {
          const ratio = transfers / totalTransfers;
          allocMin = totalMin * ratio;
          allocCost = totalCost * ratio;
        }

        aimByAgentGrid[agent][listKey as string] = {
          min: allocMin,
          cost: allocCost,
          t: transfers,
          s: deals,
        };
      }
    }

    const elapsedMs = Date.now() - startMs;

    return NextResponse.json({
      byList,
      byAgent,
      nonListSales,
      totalSales: Object.values(byList).reduce((a, r) => a + r.s, 0),
      listCosts,
      allLists: Array.from(allListKeys),
      allAgents,
      loadedFiles,
      lastUpdated: new Date().toISOString(),
      hasData: aimTransferPhones.size > 0 || totalOpenedCalls > 0,
      aimByAgent: aimByAgentGrid,
      staleness: {
        cx: tcxMaxDate,
        aim: aimMaxDate,
        moxy: moxyMaxDate,
      },
      apiSources: {
        aimTransfers: aimTransferPhones.size,
        openedCount: totalOpenedCalls,
        totalOpenedCalls,
        unattributedCalls: 0,
        salesCount: salesRows.length,
        listFilesLoaded: loadedFiles.length,
        dateRange: { from: fromDate, to: toDate },
        mode: "postgres",
        elapsedMs,
      },
    });
  } catch (err) {
    console.error("[data/route]", err);
    return NextResponse.json({ error: String(err), hasData: false }, { status: 500 });
  }
}
