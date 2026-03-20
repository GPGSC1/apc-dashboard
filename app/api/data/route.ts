import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { parseDate, todayLocal } from "../../../lib/date-utils";

const DATA_DIR = path.join(process.cwd(), "data");
const CAMPAIGN_START = "2026-02-25";
const AIM_COST_PER_MIN = parseFloat(process.env.AIM_COST_PER_MIN ?? "0.29");

const DEFAULT_LISTS: Record<string, number> = {
  RT: 0,
  JL021926LP: 8000,
  BL021926BO: 8000,
  JH022326MN: 8000,
  JL021926CR: 8000,
  DG021726SC: 5000,
  JL022526RS: 6000,
};

const SALES_QUEUES = ["mail 1", "mail 2", "mail 3", "mail 4", "mail 5", "mail 6", "home 1", "home 2", "home 4", "home 5"];

// ─── UTILITIES ───────────────────────────────────────────────────────────
function cleanPhone(raw: unknown): string {
  let s = String(raw || "").replace(/^=/, "").replace(/^"/, "").replace(/"$/, "");
  const d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

// toISO replaced by parseDate from lib/date-utils

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
    const { searchParams, origin } = new URL(request.url);
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
    const phoneToLists: Map<string, string[]> = new Map(); // phone → [list1, list2, ...]
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
    // From aim_seed.json transfers: phone → [listKey1, listKey2, ...]
    // (sorted by date desc, so first entry is most recent)
    const aimPhoneHistory: Map<string, string[]> = new Map();
    try {
      const aimSeedPath = path.join(DATA_DIR, "aim_seed.json");
      if (fs.existsSync(aimSeedPath)) {
        const aimSeed = JSON.parse(fs.readFileSync(aimSeedPath, "utf8"));
        const phoneHistory: Record<string, Array<{ date: string; listKey: string }>> = {};

        for (const t of (aimSeed.transfers ?? [])) {
          const phone = t.phone as string;
          const date = t.date as string;
          const listKey = detectListKey(t.campaign || t.description || "");

          if (phone && date && listKey) {
            if (!phoneHistory[phone]) phoneHistory[phone] = [];
            phoneHistory[phone].push({ date, listKey });
          }
        }

        // Sort by date desc and extract listKeys
        for (const [phone, history] of Object.entries(phoneHistory)) {
          history.sort((a, b) => b.date.localeCompare(a.date));
          aimPhoneHistory.set(phone, history.map(h => h.listKey));
        }
      }
    } catch (e) {
      console.error("[data/route] aim_seed.json history build failed:", e);
    }

    // ─── 3. LOAD 3CX ITD DATA FOR SALES GATE (tcx_seed.json) ─────────────
    // Build mail4Phones: all phones ever in Mail 4 Inbound
    // Build phoneLastQueue: most recent Inbound sales queue call per phone
    const mail4Phones: Set<string> = new Set();
    const phoneLastQueue: Map<string, { queue: string; date: string }> = new Map();
    let tcxMaxDate: string | null = null;

    try {
      const tcxSeedPath = path.join(DATA_DIR, "tcx_seed.json");
      if (fs.existsSync(tcxSeedPath)) {
        const tcxSeed = JSON.parse(fs.readFileSync(tcxSeedPath, "utf8"));
        // rows[i] = [callId, startTime, phone, destName, status, talkSec, queueName, inOut]
        for (const row of (tcxSeed.rows ?? [])) {
          const phone = (row[2] ?? "") as string;
          const inOut = (row[7] ?? "") as string;
          const queueName = ((row[6] ?? "") as string).toLowerCase();
          const startTime = (row[1] ?? "") as string;

          if (phone.length !== 10 || inOut.toLowerCase() !== "inbound") continue;

          // Track Mail 4 Inbound calls
          if (queueName.includes("mail 4")) {
            mail4Phones.add(phone);
          }

          // Track most recent sales queue call
          const isSalesQueue = SALES_QUEUES.some(q => queueName.includes(q));
          if (isSalesQueue) {
            // Parse date to YYYY-MM-DD for correct comparison (raw format is "M/D/YYYY H:MM")
            const dateStr = parseDate(startTime) ?? "";
            if (dateStr) {
              const existing = phoneLastQueue.get(phone);
              if (!existing || dateStr > existing.date) {
                phoneLastQueue.set(phone, { queue: queueName, date: dateStr });
                if (!tcxMaxDate || dateStr > tcxMaxDate) {
                  tcxMaxDate = dateStr;
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("[data/route] tcx_seed.json read failed:", e);
    }

    // ─── 4. LOAD AIM SEED FOR AGENT & TRANSFER ATTRIBUTION ──────────────
    const phoneToAgent: Map<string, string> = new Map();
    const aimTransferPhones: Set<string> = new Set();
    let aimMaxDate: string | null = null;

    try {
      const aimSeedPath = path.join(DATA_DIR, "aim_seed.json");
      if (fs.existsSync(aimSeedPath)) {
        const aimSeed = JSON.parse(fs.readFileSync(aimSeedPath, "utf8"));

        for (const t of (aimSeed.transfers ?? [])) {
          const phone = t.phone as string;
          const agent = t.agent as string;
          const date = t.date as string;

          if (phone && phone.length === 10) {
            aimTransferPhones.add(phone);
            if (agent && !phoneToAgent.has(phone)) {
              phoneToAgent.set(phone, agent);
            }
            if (date && (!aimMaxDate || date > aimMaxDate)) {
              aimMaxDate = date;
            }
          }
        }
      }
    } catch (e) {
      console.error("[data/route] aim_seed.json transfers read failed:", e);
    }

    // ─── 5. FETCH DATA IN PARALLEL (AIM, 3CX, Moxy) ──────────────────────
    const [aimRespRaw, callsRespRaw, moxyRespRaw] = await Promise.all([
      fetch(`${origin}/api/aim?start=${fromDate}&end=${toDate}`).catch(() => null),
      fetch(`${origin}/api/calls?from=${fromDate}&to=${toDate}`).catch(() => null),
      fetch(`${origin}/api/moxy`).catch(() => null),
    ]);

    // ─── 6. PROCESS AIM RESPONSE (minutes, costs, live transfers) ────────
    let aimByList: Record<string, { min: number; cost: number }> = {};
    let aimByAgent: Record<string, { min: number; cost: number; t: number }> = {};

    try {
      if (aimRespRaw?.ok) {
        const aimData = await aimRespRaw.json();
        if (aimData.ok) {
          aimByList = (aimData.byList ?? {}) as Record<string, { min: number; cost: number }>;
          aimByAgent = (aimData.byAgent ?? {}) as Record<string, { min: number; cost: number; t: number }>;

          // Also add live transfer phones and phone→agent mappings
          for (const v of Object.values(aimByList)) {
            const phones = (v as any).phones ?? [];
            if (Array.isArray(phones)) {
              phones.forEach((phone: any) => {
                if (typeof phone === "string" && phone.length === 10) {
                  aimTransferPhones.add(phone);
                }
              });
            }
            // Update phoneToAgent from live AIM data
            const pa = (v as any).phoneToAgent ?? {};
            for (const [phone, agent] of Object.entries(pa)) {
              if (typeof phone === "string" && phone.length === 10 && !phoneToAgent.has(phone)) {
                phoneToAgent.set(phone, agent as string);
              }
            }
          }
        }
      }
    } catch (e) {
      console.error("[data/route] AIM fetch failed:", e);
    }

    // ─── 7. PROCESS 3CX CALLS (update ITD gates + opened counts) ──────
    const openedByList: Record<string, number> = {};
    let totalOpenedCalls = 0;

    try {
      if (callsRespRaw?.ok) {
        const callsData = await callsRespRaw.json();
        for (const call of (callsData.calls ?? [])) {
          const phone = call.phoneNumber;
          if (!phone || phone.length !== 10) continue;

          // Update Mail 4 ITD set and queue recency from live 3CX data
          // (seed only covers historical dates; live API covers today)
          const queueName = (call.queueName ?? "").toLowerCase();
          const callDate = call.startTime ?? "";
          if (queueName.includes("mail 4")) {
            mail4Phones.add(phone);
          }
          const isSalesQueue = SALES_QUEUES.some(q => queueName.includes(q));
          if (isSalesQueue && callDate) {
            const existing = phoneLastQueue.get(phone);
            if (!existing || callDate > existing.date) {
              phoneLastQueue.set(phone, { queue: queueName, date: callDate });
            }
          }

          // Count opened calls for attribution
          if (!call.opened) continue;
          totalOpenedCalls++;
          const listKey = attributeToList(phone, phoneToLists, aimPhoneHistory);
          if (listKey) {
            openedByList[listKey] = (openedByList[listKey] ?? 0) + 1;
          }
        }
      }
    } catch (e) {
      console.error("[data/route] 3CX fetch failed:", e);
    }

    // ─── 8. PROCESS MOXY SALES (seed + live, dedup by customerId) ──────
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

    // Helper: add all non-empty IDs to seenDeals for cross-source dedup
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

    // Load seed
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

    // Load live API
    try {
      if (moxyRespRaw?.ok) {
        const moxyData = await moxyRespRaw.json();
        for (const d of (moxyData.sales ?? [])) {
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
      console.error("[data/route] Moxy live fetch failed:", e);
    }

    // ─── 9. COMPUTE METRICS ──────────────────────────────────────────────
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
      // Dedup by customerId (unique per deal, not per phone)
      const key = s.customerId || `${s.homePhone}|${s.mobilePhone}`;
      if (seenSalesKeys.has(key)) continue;
      seenSalesKeys.add(key);

      // Exclude: empty salesperson or contains "fishbein"
      if (!s.salesperson || s.salesperson.toLowerCase().includes("fishbein")) {
        continue;
      }

      const phones = [s.homePhone, s.mobilePhone].filter(p => p.length === 10);
      if (phones.length === 0) continue;

      // Check Mail 4 Inbound ITD gate
      const phoneInMail4 = phones.find(p => mail4Phones.has(p));
      if (!phoneInMail4) continue;

      // Check queue recency override: most recent sales queue call must be Mail 4
      const allPhonesHaveRecencyCheck = phones.every(p => {
        const lastQueue = phoneLastQueue.get(p);
        if (!lastQueue) return true; // No recency data, allow
        return lastQueue.queue.includes("mail 4");
      });

      if (!allPhonesHaveRecencyCheck) {
        // At least one phone's most recent sales queue is NOT Mail 4 → skip
        const onOpened = phones.some(p => {
          const lists = phoneToLists.get(p);
          return lists && lists.length > 0;
        });
        nonListSales.push({ ...s, onOpened });
        continue;
      }

      // List attribution
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

    // ─── 10. BUILD AGENT METRICS (ITD transfers always used) ────────────
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
      if (agent && byAgent[agent]) {
        byAgent[agent].deals++;
      }
    }

    // ─── 11. BUILD aimByAgentGrid (for campaign tab UI) ───────────────
    const allAgents = Object.keys(byAgent);
    const allLists = Array.from(allListKeys);

    // Build agent × list matrix first
    const matrix: Record<string, Record<string, { t: number; d: number }>> = {};
    for (const agent of allAgents) {
      matrix[agent] = {};
      for (const listKey of allLists) {
        matrix[agent][listKey as string] = { t: 0, d: 0 };
      }
    }

    // Transfer counts
    for (const [listKey, phones] of Object.entries(listPhones)) {
      phones.forEach(phone => {
        if (!aimTransferPhones.has(phone)) return;
        const agent = phoneToAgent.get(phone);
        if (agent && matrix[agent]?.[listKey]) {
          matrix[agent][listKey].t++;
        }
      });
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
      },
    });
  } catch (err) {
    console.error("[data/route]", err);
    return NextResponse.json({ error: String(err), hasData: false }, { status: 500 });
  }
}
