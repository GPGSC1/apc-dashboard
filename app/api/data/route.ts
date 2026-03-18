import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR       = path.join(process.cwd(), "data");
const CAMPAIGN_START = "2026-02-25";

const DEFAULT_LISTS: Record<string, number> = {
  RT:         0,
  JL021926LP: 8000,
  BL021926BO: 8000,
  JH022326MN: 8000,
  JL021926CR: 8000,
  DG021726SC: 5000,
  JL022526RS: 6000,
};

// ── UTILITIES ────────────────────────────────────────────────────────────────
const cleanPhone = (p: unknown): string => {
  let s = String(p || "").replace(/^=/, "").replace(/^"/, "").replace(/"$/, "");
  return s.replace(/\D/g, "").slice(-10);
};

const toISO = (s: string): string | null => {
  if (!s) return null;
  const d = new Date(s.replace(/"/g, "").trim());
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const detectListKey = (text: string): string | null => {
  if (!text) return null;
  if (text.toLowerCase().includes("respond")) return "RT";
  const m10 = text.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (m10) return (m10[1] + m10[2] + m10[3]).toUpperCase();
  const m8 = text.match(/([A-Za-z]{2})(\d{6})/);
  if (m8) return (m8[1] + m8[2]).toUpperCase();
  return null;
};

// ── CSV PARSER ───────────────────────────────────────────────────────────────
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

// ── PARSE DATA LIST FILE ─────────────────────────────────────────────────────
function parseListFile(text: string): Set<string> {
  const phones = new Set<string>();
  const lines  = text.split(/\r?\n/);
  if (lines.length < 2) return phones;

  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());

  const phoneColIndices = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) =>
      h.includes("phone") || h.includes("number") ||
      h.includes("cell")  || h.includes("mobile") || h.includes("home")
    )
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

// ── LOAD LIST COSTS ──────────────────────────────────────────────────────────
function loadListCosts(): Record<string, number> {
  const costFile = path.join(DATA_DIR, "list_costs.json");
  if (fs.existsSync(costFile)) {
    try { return JSON.parse(fs.readFileSync(costFile, "utf8")); } catch { /* fall */ }
  }
  return DEFAULT_LISTS;
}

// ── MAIN ROUTE HANDLER ────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams, origin } = new URL(request.url);
    const dateStart = searchParams.get("start");
    const dateEnd   = searchParams.get("end");
    const stage     = searchParams.get("stage");
    const today     = new Date().toISOString().slice(0, 10);
    const fromDate  = dateStart ?? CAMPAIGN_START;
    const toDate    = dateEnd   ?? today;

    const inRange = (date: string | null) => {
      if (!date) return true;
      if (dateStart && date < dateStart) return false;
      if (dateEnd   && date > dateEnd)   return false;
      return true;
    };

    // ── 1. LOAD DATA LIST FILES (source of truth: phone → list) ─────────────
    const listPhones:  Record<string, Set<string>> = {};
    const phoneToList: Map<string, string>         = new Map();
    const listCosts    = loadListCosts();
    const loadedFiles: string[] = [];

    if (fs.existsSync(DATA_DIR)) {
      for (const file of fs.readdirSync(DATA_DIR)) {
        const lower = file.toLowerCase();
        if (lower === ".gitkeep") continue;
        if (!lower.endsWith(".csv") && !lower.endsWith(".xls") && !lower.endsWith(".xlsx")) continue;

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
          if (!phoneToList.has(phone)) phoneToList.set(phone, listKey);
        }
      }
    }

    // ── 2. FETCH AIM API (date-filtered for display) ────────────────────────
    // Returns phones[] per list — used for transfer counts, minutes, cost
    const aimTransferPhones = new Set<string>();  // date-filtered (for display)
    const phoneToAgent      = new Map<string, string>();
    let aimByList:  Record<string, { t: number; phones: string[]; phoneToAgent: Record<string,string>; min: number; cost: number; listCost: number }> = {};
    let aimByAgent: Record<string, { t: number; min: number; cost: number }> = {};

    // Skip AIM API for stage="calls" since we only need 3CX data; fetch seed files instead
    if (stage !== "calls") {
      try {
        const aimResp = await fetch(`${origin}/api/aim?start=${fromDate}&end=${toDate}`);
        if (aimResp.ok) {
          const aimData = await aimResp.json();
          if (aimData.ok) {
            aimByList  = aimData.byList  ?? {};
            aimByAgent = aimData.byAgent ?? {};
            for (const v of Object.values(aimByList)) {
              for (const phone of (v.phones ?? [])) {
                aimTransferPhones.add(phone);
                if (v.phoneToAgent?.[phone] && !phoneToAgent.has(phone)) {
                  phoneToAgent.set(phone, v.phoneToAgent[phone]);
                }
              }
            }
          }
        }
      } catch (e) {
        console.error("[data/route] AIM fetch failed:", e);
      }
    }

    // ── 2b. LOAD ITD PHONE SETS FOR TRIPLE GATE (from seed files) ────────────
    // Sales attribution needs ITD transfer + opened phones, not just the
    // selected date range. A sale may close days after the transfer.
    // Reading seed JSON files is instant (~375KB + ~221KB) — no API call.
    const itdAimPhones    = new Set<string>();
    const itdOpenedPhones = new Set<string>();

    try {
      const aimSeedPath = path.join(DATA_DIR, "aim_transfers_seed.json");
      if (fs.existsSync(aimSeedPath)) {
        const aimSeed = JSON.parse(fs.readFileSync(aimSeedPath, "utf8"));
        for (const t of (aimSeed.transfers ?? [])) {
          if (t.phone?.length === 10) itdAimPhones.add(t.phone);
        }
      }
    } catch (e) {
      console.error("[data/route] AIM seed read failed:", e);
    }

    // For stage="calls", also need to populate aimTransferPhones from seed since we skipped AIM API
    if (stage === "calls") {
      try {
        const aimSeedPath = path.join(DATA_DIR, "aim_transfers_seed.json");
        if (fs.existsSync(aimSeedPath)) {
          const aimSeed = JSON.parse(fs.readFileSync(aimSeedPath, "utf8"));
          for (const t of (aimSeed.transfers ?? [])) {
            if (t.phone?.length === 10) aimTransferPhones.add(t.phone);
          }
        }
      } catch (e) {
        console.error("[data/route] AIM seed read (stage=calls) failed:", e);
      }
    }

    try {
      const tcxSeedPath = path.join(DATA_DIR, "tcx_calls_seed.json");
      if (fs.existsSync(tcxSeedPath)) {
        const tcxSeed = JSON.parse(fs.readFileSync(tcxSeedPath, "utf8"));
        for (const o of (tcxSeed.opened ?? [])) {
          if (o.phone?.length === 10) itdOpenedPhones.add(o.phone);
        }
      }
    } catch (e) {
      console.error("[data/route] 3CX seed read failed:", e);
    }

    // Also include date-filtered phones in ITD sets (covers live API data)
    for (const p of aimTransferPhones) itdAimPhones.add(p);

    // ── 3. FETCH 3CX CALLS (date-filtered for display) ──────────────────────
    // Opened rules:
    //   1. Passed all 4 3CX rules (answered + not AI F + talk time > 0 + mail 4)
    //   2. Exists in data list files (phoneToList)
    //   3. Was transferred by AIM (aimTransferPhones)
    // COUNT every qualifying call row (no dedup) — matches manual methodology
    const openedPhones    = new Set<string>();   // date-filtered (for display)
    const openedByList: Record<string, number> = {}; // raw count per list

    // Only fetch 3CX calls for stage="calls" or no stage (full load)
    if (stage !== "sales" && stage !== "costs") {
      try {
        const callsResp = await fetch(`${origin}/api/calls?from=${fromDate}&to=${toDate}`);
        if (callsResp.ok) {
          const callsData = await callsResp.json();
          for (const call of (callsData.calls ?? [])) {
            const phone = call.phoneNumber;
            if (
              call.opened &&
              phone?.length === 10 &&
              phoneToList.has(phone) &&
              aimTransferPhones.has(phone)
            ) {
              openedPhones.add(phone);
              itdOpenedPhones.add(phone); // also add to ITD set
              const li = phoneToList.get(phone)!;
              openedByList[li] = (openedByList[li] ?? 0) + 1;
            }
          }
        }
      } catch (e) {
        console.error("[data/route] 3CX fetch failed:", e);
      }
    }

    // ── 4. FETCH MOXY SALES ──────────────────────────────────────────────────
    let salesRows: {
      soldDate: string | null; lastName: string; firstName: string;
      promoCode: string; homePhone: string; mobilePhone: string;
      dealStatus: string; salesperson: string; campaign: string;
    }[] = [];

    if (stage !== "calls" && stage !== "costs") {
      try {
        const moxyResp = await fetch(`${origin}/api/moxy`);
        if (moxyResp.ok) {
          const moxyData = await moxyResp.json();
          salesRows = (moxyData.sales ?? [])
            .filter((s: { status: string }) => (s.status ?? "").trim() === "Sold")
            .map((s: {
              soldDate: string; lastName: string; firstName: string;
              promoCode: string; homePhone: string; cellPhone: string;
              status: string; salesRep: string; campaign: string;
            }) => ({
              soldDate:    toISO(s.soldDate ?? ""),
              lastName:    s.lastName  ?? "",
              firstName:   s.firstName ?? "",
              promoCode:   s.promoCode ?? "",
              homePhone:   cleanPhone(s.homePhone ?? ""),
              mobilePhone: cleanPhone(s.cellPhone ?? ""),
              dealStatus:  s.status    ?? "",
              salesperson: s.salesRep  ?? "",
              campaign:    s.campaign  ?? "",
            }))
            .filter((s: { soldDate: string | null }) =>
              s.soldDate && s.soldDate >= CAMPAIGN_START && inRange(s.soldDate)
            );
        }
      } catch (e) {
        console.error("[data/route] Moxy fetch failed:", e);
      }
    }

    // ── 4b. LOAD QUEUE RULES (guardrail for non-same-day sales) ──────────────
    // If a sale passes the ITD triple gate but was NOT transferred on the same
    // day, verify via queue rules that the sale actually belongs to Mail 4 (AI).
    interface QueueRule {
      product: string; field: string; match: string; pattern: string;
      queue: string; priority: number; midStart?: number; midLen?: number;
    }
    let queueRules: QueueRule[] = [];
    try {
      const rulesPath = path.join(DATA_DIR, "queue_rules.json");
      if (fs.existsSync(rulesPath)) {
        const rulesData = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
        queueRules = (rulesData.rules ?? [])
          .filter((r: QueueRule) => r.product === "AUTO" || r.product === "BOTH")
          .sort((a: QueueRule, b: QueueRule) => a.priority - b.priority);
      }
    } catch { /* rules file missing = no guardrail, allow all */ }

    function assignQueue(sale: { promoCode: string; campaign: string }, callQueueName: string): string | null {
      for (const rule of queueRules) {
        const fieldVal = rule.field === "queueName" ? callQueueName
                       : rule.field === "promoCode" ? sale.promoCode
                       : rule.field === "campaign"  ? sale.campaign
                       : "";
        let matched = false;
        switch (rule.match) {
          case "EXACT":       matched = fieldVal === rule.pattern; break;
          case "STARTS_WITH": matched = fieldVal.startsWith(rule.pattern); break;
          case "CONTAINS":    matched = fieldVal.includes(rule.pattern); break;
          case "REGEX":       try { matched = new RegExp(rule.pattern).test(fieldVal); } catch { } break;
          case "MID_EXACT": {
            const sub = fieldVal.substring(rule.midStart ?? 0, (rule.midStart ?? 0) + (rule.midLen ?? 0));
            matched = sub === rule.pattern;
            break;
          }
        }
        if (matched) return rule.queue;
      }
      return null; // no rule matched
    }

    // Build ITD AIM transfer date lookup: phone → Set of dates transferred
    const aimPhoneDates = new Map<string, Set<string>>();
    try {
      const aimSeedPath = path.join(DATA_DIR, "aim_transfers_seed.json");
      if (fs.existsSync(aimSeedPath)) {
        const aimSeed = JSON.parse(fs.readFileSync(aimSeedPath, "utf8"));
        for (const t of (aimSeed.transfers ?? [])) {
          if (!aimPhoneDates.has(t.phone)) aimPhoneDates.set(t.phone, new Set());
          aimPhoneDates.get(t.phone)!.add(t.date);
        }
      }
    } catch { /* no seed = skip same-day check */ }

    // ── 5. COMPUTE METRICS ───────────────────────────────────────────────────
    const allListKeys = new Set([...Object.keys(DEFAULT_LISTS), ...Object.keys(listPhones)]);

    const byList: Record<string, { t: number; o: number; s: number; min: number; cost: number; listCost: number }> = {};
    const ensure = (li: string) => {
      if (!byList[li]) byList[li] = { t: 0, o: 0, s: 0, min: 0, cost: 0, listCost: listCosts[li] ?? 0 };
    };
    for (const li of allListKeys) ensure(li as string);

    // Stage 1 (sales): TRANSFERS — phone in data list file AND in AIM transfer set
    if (stage === "sales" || stage === null || stage === undefined) {
      for (const [listKey, phones] of Object.entries(listPhones)) {
        ensure(listKey);
        for (const phone of phones) {
          if (aimTransferPhones.has(phone)) byList[listKey].t++;
        }
      }
    }

    // Stage 2 (calls): OPENED — use raw per-call counts (matches manual: no dedup across dates)
    if (stage === "calls" || stage === null || stage === undefined) {
      for (const [li, count] of Object.entries(openedByList)) {
        if (byList[li]) byList[li].o += count;
      }
    }

    // Stage 3 (costs): MINUTES & COST — from AIM campaign-level data
    if (stage === "costs" || stage === null || stage === undefined) {
      for (const [aimListKey, aimStats] of Object.entries(aimByList)) {
        if (byList[aimListKey]) {
          byList[aimListKey].min  += aimStats.min  ?? 0;
          byList[aimListKey].cost += aimStats.cost ?? 0;
        }
      }
    }

    // SALES — homePhone OR cellPhone must pass triple gate + queue rules guardrail
    const nonListSales: (typeof salesRows[0] & { onOpened: boolean })[] = [];
    const seenSales = new Set<string>();

    if (stage !== "calls" && stage !== "costs") {
      for (const s of salesRows) {
        const key = `${s.homePhone}|${s.mobilePhone}`;
        if (seenSales.has(key)) continue;
        seenSales.add(key);

        const notFishbein = !s.salesperson?.toLowerCase().includes("fishbein");
        if (!notFishbein) continue;

        const phones = [s.homePhone, s.mobilePhone].filter(p => p && p.length === 10);

        const matchedPhone = phones.find(p =>
          phoneToList.has(p) && itdAimPhones.has(p) && itdOpenedPhones.has(p)
        );

        const onOpened = phones.some(p => openedPhones.has(p));

        if (!matchedPhone) {
          nonListSales.push({ ...s, onOpened });
          continue;
        }

        // ── GUARDRAIL: non-same-day sales must pass queue rules ──────────────
        // If the sale's phone was transferred on the SAME day as the sale, trust
        // the triple gate (97% of cases). If NOT same-day, apply queue rules to
        // verify the sale actually belongs to Mail 4 (AI campaign).
        const soldDate = s.soldDate ?? "";
        const transferDates = aimPhoneDates.get(matchedPhone);
        const isSameDay = transferDates?.has(soldDate) ?? false;

        if (!isSameDay && queueRules.length > 0) {
          // Not same-day: apply queue rules using Moxy promoCode + campaign
          const assignedQueue = assignQueue(
            { promoCode: s.promoCode, campaign: s.campaign },
            "" // no 3CX queue name available here; promoCode/campaign rules take precedence
          );
          if (assignedQueue && assignedQueue !== "Mail 4") {
            // Rules say this sale belongs to a different campaign — don't count as AI
            nonListSales.push({ ...s, onOpened });
            continue;
          }
          // If no rule matched OR rule says Mail 4 → count it
        }

        const li = phoneToList.get(matchedPhone)!;
        if (byList[li]) byList[li].s++;
      }
    }

    // AGENT SUMMARY
    const byAgent: Record<string, { calls: number; min: number; cost: number; t: number; deals: number }> = {};
    for (const [agent, stats] of Object.entries(aimByAgent)) {
      byAgent[agent] = { calls: 0, min: stats.min, cost: stats.cost, t: stats.t, deals: 0 };
    }

    // Deals per agent
    if (stage !== "calls" && stage !== "costs") {
      for (const s of salesRows) {
        const notFishbein = !s.salesperson?.toLowerCase().includes("fishbein");
        if (!notFishbein) continue;

        const phones = [s.homePhone, s.mobilePhone].filter(p => p && p.length === 10);
        const matchedPhone = phones.find(p =>
          phoneToList.has(p) && itdAimPhones.has(p) && itdOpenedPhones.has(p)
        );
        if (!matchedPhone) continue;

        const agent = phoneToAgent.get(matchedPhone);
        if (agent && byAgent[agent]) byAgent[agent].deals++;
      }
    }

    // AGENT × LIST MATRIX
    const allAgents = Object.keys(byAgent);
    const allLists  = Array.from(allListKeys);
    const matrix: Record<string, Record<string, { t: number; o: number; d: number }>> = {};
    for (const agent of allAgents) {
      matrix[agent] = {};
      for (const li of allLists) matrix[agent][li] = { t: 0, o: 0, d: 0 };
    }

    for (const [listKey, phones] of Object.entries(listPhones)) {
      for (const phone of phones) {
        if (!aimTransferPhones.has(phone)) continue;
        const agent = phoneToAgent.get(phone);
        if (agent && matrix[agent]?.[listKey] !== undefined) matrix[agent][listKey].t++;
      }
    }
    for (const phone of openedPhones) {
      const li    = phoneToList.get(phone);
      const agent = phoneToAgent.get(phone);
      if (li && agent && matrix[agent]?.[li] !== undefined) matrix[agent][li].o++;
    }
    if (stage !== "calls" && stage !== "costs") {
      for (const s of salesRows) {
        const notFishbein = !s.salesperson?.toLowerCase().includes("fishbein");
        if (!notFishbein) continue;
        const phones = [s.homePhone, s.mobilePhone].filter(p => p && p.length === 10);
        const matchedPhone = phones.find(p =>
          phoneToList.has(p) && itdAimPhones.has(p) && itdOpenedPhones.has(p)
        );
        if (!matchedPhone) continue;
        const li    = phoneToList.get(matchedPhone);
        const agent = phoneToAgent.get(matchedPhone);
        if (li && agent && matrix[agent]?.[li] !== undefined) matrix[agent][li].d++;
      }
    }

    // Build cross-tab for the campaign-tab UI (agent → list → stats)
    // Allocate agent's total min/cost proportionally by transfer count across lists
    const aimByAgentGrid: Record<string, Record<string, { min: number; cost: number; t: number; s: number }>> = {};
    for (const agent of allAgents) {
      aimByAgentGrid[agent] = {};

      const agentStats = byAgent[agent];
      const totalMinForAgent = agentStats?.min ?? 0;
      const totalCostForAgent = agentStats?.cost ?? 0;

      // Sum total transfers for this agent across all lists
      let totalTransfersForAgent = 0;
      for (const li of allLists) {
        const m = matrix[agent]?.[li];
        totalTransfersForAgent += m?.t ?? 0;
      }

      // Allocate min/cost proportionally by transfer count
      for (const li of allLists) {
        const m = matrix[agent]?.[li];
        const transfers = m?.t ?? 0;
        let allocatedMin = 0;
        let allocatedCost = 0;

        if (transfers > 0 && totalTransfersForAgent > 0) {
          const ratio = transfers / totalTransfersForAgent;
          allocatedMin = totalMinForAgent * ratio;
          allocatedCost = totalCostForAgent * ratio;
        }

        aimByAgentGrid[agent][li] = {
          min:  allocatedMin,
          cost: allocatedCost,
          t:    transfers,
          s:    m?.d ?? 0,
        };
      }
    }

    return NextResponse.json({
      byList,
      byAgent,
      matrix,
      nonListSales,
      totalSales:  Object.values(byList).reduce((a, r) => a + r.s, 0),
      listCosts,
      allLists,
      allAgents,
      loadedFiles,
      lastUpdated: new Date().toISOString(),
      hasData:     aimTransferPhones.size > 0 || openedPhones.size > 0,
      // Fields expected by campaign-tab UI (page.tsx)
      aimByAgent: aimByAgentGrid,
      staleness: {
        cx:   new Date().toISOString(),
        aim:  new Date().toISOString(),
        moxy: (stage !== "calls" && stage !== "costs") ? new Date().toISOString() : null,
      },
      apiSources: {
        aimTransfers:    aimTransferPhones.size,
        openedCount:     openedPhones.size,
        salesCount:      salesRows.length,
        listFilesLoaded: loadedFiles.length,
        dateRange:       { from: fromDate, to: toDate },
      },
    });

  } catch (err) {
    console.error("[data/route]", err);
    return NextResponse.json({ error: String(err), hasData: false }, { status: 500 });
  }
}
