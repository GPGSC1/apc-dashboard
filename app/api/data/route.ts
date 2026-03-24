import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { parseDate, todayLocal } from "../../../lib/date-utils";

/**
 * DATA ROUTE — Pure computation on local seed JSON files.
 *
 * NO live API calls. Seeds are refreshed every 15 min by /api/seed-refresh.
 * Sources:
 *   aim_seed.json   → transfers, dailyCosts, agentDailyCosts, phoneToAgentAll
 *   tcx_gate.json   → mail4Phones, phoneLastQueue, openedByDate
 *   moxy_seed.json  → deals
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

function detectListKey(text: string): string | null {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const m10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (m10) return (m10[1] + m10[2] + m10[3]).toUpperCase();
  const m8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (m8) return (m8[1] + m8[2]).toUpperCase();
  return null;
}

// ─── CSV PARSER ──────────────────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
  const r: string[] = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { r.push(cur); cur = ""; }
    else cur += ch;
  }
  r.push(cur);
  return r;
}

function parseListFile(text: string): Set<string> {
  const phones = new Set<string>();
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return phones;

  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const phoneColIndices = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.includes("phone") || h.includes("number") || h.includes("cell") || h.includes("mobile") || h.includes("home"))
    .map(({ i }) => i);

  const colsToCheck = phoneColIndices.length > 0 ? phoneColIndices : headers.map((_, i) => i);

  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const c = parseCsvLine(l);
    for (const idx of colsToCheck) {
      const p = cleanPhone(c[idx] || "");
      if (p.length === 10) phones.add(p);
    }
  }
  return phones;
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

    const inRange = (date: string | null) => {
      if (!date) return true;
      if (fromDate && date < fromDate) return false;
      if (toDate && date > toDate) return false;
      return true;
    };

    // ─── 1. LOAD SOURCE LIST CSV FILES (phone → list mapping) ────────────
    const listPhones: Record<string, Set<string>> = {};
    const phoneToLists: Map<string, string[]> = new Map();
    const listCosts = loadListCosts();
    const loadedFiles: string[] = [];

    if (fs.existsSync(DATA_DIR)) {
      for (const file of fs.readdirSync(DATA_DIR)) {
        const lower = file.toLowerCase();
        if (lower === ".gitkeep" || !lower.match(/\.(csv|xls|xlsx)$/i)) continue;

        const baseName = file.replace(/\.(csv|xls|xlsx)$/i, "");
        const listKey = DEFAULT_LISTS[baseName.toUpperCase()] !== undefined
          ? baseName.toUpperCase()
          : detectListKey(baseName);
        if (!listKey) continue;

        let text: string;
        try {
          text = fs.readFileSync(path.join(DATA_DIR, file), "utf8");
        } catch {
          text = fs.readFileSync(path.join(DATA_DIR, file), "latin1");
        }

        const phones = parseListFile(text);
        listPhones[listKey] = phones;
        loadedFiles.push(file);

        for (const phone of phones) {
          const lists = phoneToLists.get(phone) || [];
          if (!lists.includes(listKey)) lists.push(listKey);
          phoneToLists.set(phone, lists);
        }
      }
    }

    // ─── 2. BUILD AIM PHONE HISTORY FOR TIEBREAKER ────────────────────────
    const aimPhoneHistory: Map<string, string[]> = new Map();
    const phoneToAgent: Map<string, string> = new Map();
    const aimTransferPhones: Set<string> = new Set();
    let aimMaxDate: string | null = null;

    // AIM seed aggregate data for byList / byAgent
    let aimByList: Record<string, { min: number; cost: number }> = {};
    let aimByAgent: Record<string, { min: number; cost: number; t: number }> = {};
    const aimRangePhonesByList: Record<string, string[]> = {};

    try {
      const aimSeedPath = path.join(DATA_DIR, "aim_seed.json");
      if (fs.existsSync(aimSeedPath)) {
        const aimSeed = JSON.parse(fs.readFileSync(aimSeedPath, "utf8"));

        // Build phone history for tiebreaker
        const phoneHistory: Record<string, Array<{ date: string; listKey: string }>> = {};

        for (const t of (aimSeed.transfers ?? [])) {
          const phone = t.phone as string;
          const agent = t.agent as string;
          const date = t.date as string;
          const listKey = t.listKey as string;

          if (phone && phone.length === 10) {
            aimTransferPhones.add(phone);
            if (agent && !phoneToAgent.has(phone)) {
              phoneToAgent.set(phone, agent);
            }
            if (date && (!aimMaxDate || date > aimMaxDate)) {
              aimMaxDate = date;
            }

            // Build tiebreaker history
            if (date && listKey) {
              if (!phoneHistory[phone]) phoneHistory[phone] = [];
              phoneHistory[phone].push({ date, listKey });
            }

            // Date-filtered transfers for agent grid
            if (date >= fromDate && date <= toDate) {
              if (!aimRangePhonesByList[listKey]) aimRangePhonesByList[listKey] = [];
              aimRangePhonesByList[listKey].push(phone);
            }
          }
        }

        // Sort by date desc for tiebreaker
        for (const [phone, history] of Object.entries(phoneHistory)) {
          history.sort((a, b) => b.date.localeCompare(a.date));
          aimPhoneHistory.set(phone, history.map(h => h.listKey));
        }

        // Load dailyCosts for byList (sum within date range)
        if (aimSeed.dailyCosts) {
          for (const [li, dateCosts] of Object.entries(aimSeed.dailyCosts as Record<string, Record<string, { min: number; cost: number }>>)) {
            let totalMin = 0, totalCost = 0;
            for (const [date, stats] of Object.entries(dateCosts)) {
              if (date >= fromDate && date <= toDate) {
                totalMin += stats.min;
                totalCost += stats.cost;
              }
            }
            if (totalMin > 0 || totalCost > 0) {
              aimByList[li] = { min: Math.round(totalMin), cost: Math.round(totalCost * 100) / 100 };
            }
          }
        }

        // Load agentDailyCosts for byAgent (sum within date range)
        if (aimSeed.agentDailyCosts) {
          for (const [agent, dateCosts] of Object.entries(aimSeed.agentDailyCosts as Record<string, Record<string, { min: number; cost: number }>>)) {
            let totalMin = 0, totalCost = 0;
            for (const [date, stats] of Object.entries(dateCosts)) {
              if (date >= fromDate && date <= toDate) {
                totalMin += stats.min;
                totalCost += stats.cost;
              }
            }
            // Count transfers for this agent in range
            let agentTransfers = 0;
            for (const t of (aimSeed.transfers ?? [])) {
              if (t.agent === agent && t.date >= fromDate && t.date <= toDate) {
                agentTransfers++;
              }
            }
            if (totalMin > 0 || totalCost > 0 || agentTransfers > 0) {
              aimByAgent[agent] = {
                min: Math.round(totalMin),
                cost: Math.round(totalCost * 100) / 100,
                t: agentTransfers,
              };
            }
          }
        }

        // Load all-call phone→agent as fallback (covers phones dialed but not transferred)
        const allPTA = aimSeed.phoneToAgentAll ?? {};
        for (const [phone, entry] of Object.entries(allPTA)) {
          if (phone.length === 10 && !phoneToAgent.has(phone)) {
            phoneToAgent.set(phone, (entry as any).agent);
          }
        }
      }
    } catch (e) {
      console.error("[data/route] aim_seed.json read failed:", e);
    }

    // ─── 3. LOAD 3CX ITD GATE DATA (pre-computed by seed-refresh) ────────
    const mail4Phones: Set<string> = new Set();
    const phoneLastQueue: Map<string, { queue: string; date: string }> = new Map();
    let tcxMaxDate: string | null = null;
    let seedOpenedByDate: Record<string, string[]> = {};

    try {
      const gatePath = path.join(DATA_DIR, "tcx_gate.json");
      if (fs.existsSync(gatePath)) {
        const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
        for (const phone of (gate.mail4Phones ?? [])) {
          mail4Phones.add(phone);
        }
        for (const [phone, entry] of Object.entries(gate.phoneLastQueue ?? {})) {
          phoneLastQueue.set(phone, entry as { queue: string; date: string });
        }
        tcxMaxDate = gate.maxDate ?? null;
        seedOpenedByDate = gate.openedByDate ?? {};
      }
    } catch (e) {
      console.error("[data/route] tcx_gate.json read failed:", e);
    }

    // ─── 4. PROCESS 3CX OPENED CALLS (all from gate data, no live calls) ─
    const openedByList: Record<string, number> = {};
    let totalOpenedCalls = 0;

    for (const [date, phones] of Object.entries(seedOpenedByDate)) {
      if (date < fromDate || date > toDate) continue;
      for (const phone of (phones as string[])) {
        totalOpenedCalls++;
        const listKey = attributeToList(phone, phoneToLists, aimPhoneHistory);
        if (listKey) {
          openedByList[listKey] = (openedByList[listKey] ?? 0) + 1;
        }
      }
    }

    // ─── 5. PROCESS MOXY SALES (seed only, no live API) ─────────────────
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

    const normalizeMoxyDeal = (d: any): MoxySale => {
      const hp = cleanPhone(d.homePhone ?? "");
      const cp = cleanPhone(d.mobilePhone ?? d.cellphone ?? d.cellPhone ?? "");
      return {
        soldDate: parseDate(d.soldDate ?? ""),
        homePhone: hp,
        mobilePhone: cp,
        salesperson: String(d.salesperson ?? d.salesRep ?? d.closer ?? ""),
        customerId: String(d.customerId ?? d.contractNo ?? ""),
      };
    };

    const addDealIds = (d: any) => {
      const cid = String(d.customerId ?? "").trim();
      const cno = String(d.contractNo ?? "").trim();
      if (cid) seenDeals.add(cid);
      if (cno) seenDeals.add(cno);
    };
    const isDealSeen = (d: any): boolean => {
      const cid = String(d.customerId ?? "").trim();
      const cno = String(d.contractNo ?? "").trim();
      return (cid !== "" && seenDeals.has(cid)) || (cno !== "" && seenDeals.has(cno));
    };

    try {
      const moxyPath = path.join(DATA_DIR, "moxy_seed.json");
      if (fs.existsSync(moxyPath)) {
        const moxySeed = JSON.parse(fs.readFileSync(moxyPath, "utf8"));
        for (const d of (moxySeed.deals ?? [])) {
          const normalized = normalizeMoxyDeal(d);
          if (!normalized.soldDate || normalized.soldDate < CAMPAIGN_START || !inRange(normalized.soldDate)) continue;
          const dealSt = String(d.dealStatus ?? d.status ?? "").toLowerCase();
          if (dealSt === "back out" || dealSt === "void" || !dealSt) continue;

          if (isDealSeen(d)) continue;
          addDealIds(d);
          salesRows.push(normalized);
          if (!moxyMaxDate || normalized.soldDate > moxyMaxDate) {
            moxyMaxDate = normalized.soldDate;
          }
        }
      }
    } catch (e) {
      console.error("[data/route] Moxy seed read failed:", e);
    }

    // ─── 6. COMPUTE METRICS ──────────────────────────────────────────────
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
      phones.forEach(phone => {
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

      const phones = [s.homePhone, s.mobilePhone].filter(p => p.length === 10);
      if (phones.length === 0) continue;

      const phoneInMail4 = phones.find(p => mail4Phones.has(p));
      if (!phoneInMail4) continue;

      const allPhonesHaveRecencyCheck = phones.every(p => {
        const lastQueue = phoneLastQueue.get(p);
        if (!lastQueue) return true;
        return lastQueue.queue.includes("mail 4");
      });

      if (!allPhonesHaveRecencyCheck) {
        const onOpened = phones.some(p => {
          const lists = phoneToLists.get(p);
          return lists && lists.length > 0;
        });
        nonListSales.push({ ...s, onOpened });
        continue;
      }

      const attributedPhone = phones.find(p => {
        const list = attributeToList(p, phoneToLists, aimPhoneHistory);
        return list !== null;
      });

      if (!attributedPhone) {
        const onOpened = phones.some(p => {
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

    // ─── 7. BUILD AGENT METRICS (ITD transfers always used) ────────────
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

      const phones = [s.homePhone, s.mobilePhone].filter(p => p.length === 10);
      const phoneInMail4 = phones.find(p => mail4Phones.has(p));
      if (!phoneInMail4) continue;

      const allPhonesOk = phones.every(p => {
        const lastQueue = phoneLastQueue.get(p);
        if (!lastQueue) return true;
        return lastQueue.queue.includes("mail 4");
      });
      if (!allPhonesOk) continue;

      const attributedPhone = phones.find(p => attributeToList(p, phoneToLists, aimPhoneHistory));
      if (!attributedPhone) continue;

      const agent = phoneToAgent.get(attributedPhone);
      if (agent) {
        if (!byAgent[agent]) {
          byAgent[agent] = { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
        }
        byAgent[agent].deals++;
      }
    }

    // ─── 8. BUILD aimByAgentGrid (for campaign tab UI) ───────────────
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
      const phones = [s.homePhone, s.mobilePhone].filter(p => p.length === 10);
      const phoneInMail4 = phones.find(p => mail4Phones.has(p));
      if (!phoneInMail4) continue;
      const allPhonesOk = phones.every(p => {
        const lastQueue = phoneLastQueue.get(p);
        if (!lastQueue) return true;
        return lastQueue.queue.includes("mail 4");
      });
      if (!allPhonesOk) continue;
      const attributedPhone = phones.find(p => attributeToList(p, phoneToLists, aimPhoneHistory));
      if (!attributedPhone) continue;
      const listKey = attributeToList(attributedPhone, phoneToLists, aimPhoneHistory);
      const agent = phoneToAgent.get(attributedPhone);
      if (agent && listKey && matrix[agent]?.[listKey]) {
        matrix[agent][listKey].d++;
      }
    }

    // Allocate agent's min/cost proportionally by transfers
    const aimByAgentGrid: Record<string, Record<string, { min: number; cost: number; t: number; s: number }>> = {};
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
        let allocMin = 0, allocCost = 0;

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
        mode: "seed-only",
        elapsedMs,
      },
    });
  } catch (err) {
    console.error("[data/route]", err);
    return NextResponse.json({ error: String(err), hasData: false }, { status: 500 });
  }
}
