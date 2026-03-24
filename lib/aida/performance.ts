import { redis } from "./kv-schema";
import { todayCentral } from "./time";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PeriodStats {
  sales: number;
  calls: number; // opened/transferred calls
  closeRate: number; // sales / calls (0-1)
  costPerSale: number | null;
  dialCost: number;
  minutes: number;
}

export interface ListPerformance {
  listKey: string;
  yesterday: PeriodStats;
  wtd: PeriodStats;
  mtd: PeriodStats;
  score: number; // 0-100 based on close rate
}

export interface AgentListPerformance {
  agent: string;
  listKey: string;
  transfers: number;
  sales: number;
  closeRate: number;
  minutes: number;
  cost: number;
}

export interface AgentPerformance {
  agent: string;
  totalTransfers: number;
  totalSales: number;
  overallCloseRate: number;
  totalCost: number;
  byList: Record<string, AgentListPerformance>;
  score: number; // 0-100
}

export interface PerformanceData {
  lists: Record<string, ListPerformance>;
  agents: Record<string, AgentPerformance>;
  lastUpdated: string;
}

const KV_KEY = "aida:performance";

// ─── Date helpers (Central Time) ────────────────────────────────────────────

function centralParts(): { year: number; month: number; day: number; dow: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value])
  );
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(parts.year),
    month: parseInt(parts.month),
    day: parseInt(parts.day),
    dow: dowMap[parts.weekday] ?? 0,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function yesterdayDate(): string {
  const p = centralParts();
  const d = new Date(p.year, p.month - 1, p.day);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekStartDate(): string {
  // Monday of current week
  const p = centralParts();
  const d = new Date(p.year, p.month - 1, p.day);
  const daysSinceMonday = (p.dow + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  d.setDate(d.getDate() - daysSinceMonday);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStartDate(): string {
  const p = centralParts();
  return `${p.year}-${pad(p.month)}-01`;
}

// ─── Fetch dashboard data ───────────────────────────────────────────────────

async function fetchDashboardData(start: string, end: string): Promise<any> {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const res = await fetch(`${base}/api/data?start=${start}&end=${end}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

// ─── Build performance from API response ────────────────────────────────────

function extractListStats(data: any): Record<string, PeriodStats> {
  const result: Record<string, PeriodStats> = {};
  if (!data?.byList) return result;

  for (const [listKey, v] of Object.entries(data.byList as Record<string, any>)) {
    const sales = v.s ?? 0;
    const calls = v.o ?? 0; // opened calls
    result[listKey] = {
      sales,
      calls,
      closeRate: calls > 0 ? sales / calls : 0,
      costPerSale: sales > 0 ? (v.cost ?? 0) / sales : null,
      dialCost: v.cost ?? 0,
      minutes: v.min ?? 0,
    };
  }
  return result;
}

function extractAgentListGrid(data: any): AgentListPerformance[] {
  const results: AgentListPerformance[] = [];
  const grid = data?.aimByAgent;
  if (!grid) return results;

  for (const [agent, lists] of Object.entries(grid as Record<string, Record<string, any>>)) {
    for (const [listKey, cell] of Object.entries(lists)) {
      results.push({
        agent,
        listKey,
        transfers: cell.t ?? 0,
        sales: cell.s ?? 0,
        closeRate: (cell.t ?? 0) > 0 ? (cell.s ?? 0) / (cell.t ?? 0) : 0,
        minutes: cell.min ?? 0,
        cost: cell.cost ?? 0,
      });
    }
  }
  return results;
}

// ─── Main: refresh performance data ─────────────────────────────────────────

export async function refreshPerformance(): Promise<PerformanceData> {
  const today = todayCentral();
  const yesterday = yesterdayDate();
  const weekStart = weekStartDate();
  const monthStart = monthStartDate();

  // Fetch all three ranges in parallel
  const [yesterdayData, wtdData, mtdData] = await Promise.all([
    fetchDashboardData(yesterday, yesterday),
    fetchDashboardData(weekStart, today),
    fetchDashboardData(monthStart, today),
  ]);

  // Build list performance
  const yesterdayStats = extractListStats(yesterdayData);
  const wtdStats = extractListStats(wtdData);
  const mtdStats = extractListStats(mtdData);

  const emptyStats: PeriodStats = { sales: 0, calls: 0, closeRate: 0, costPerSale: null, dialCost: 0, minutes: 0 };
  const allListKeys = new Set([
    ...Object.keys(yesterdayStats),
    ...Object.keys(wtdStats),
    ...Object.keys(mtdStats),
  ]);

  const lists: Record<string, ListPerformance> = {};
  for (const listKey of allListKeys) {
    const mtd = mtdStats[listKey] ?? emptyStats;
    lists[listKey] = {
      listKey,
      yesterday: yesterdayStats[listKey] ?? emptyStats,
      wtd: wtdStats[listKey] ?? emptyStats,
      mtd,
      // Score: close rate * 100, scaled. MTD is the primary signal.
      score: Math.round(mtd.closeRate * 1000) / 10, // e.g. 0.08 → 8.0
    };
  }

  // Build agent performance from MTD data (most meaningful period)
  const agentGrid = extractAgentListGrid(mtdData);
  const agentByAgent = (mtdData?.byAgent ?? {}) as Record<string, any>;

  const agents: Record<string, AgentPerformance> = {};
  for (const [agentName, agentData] of Object.entries(agentByAgent)) {
    const byList: Record<string, AgentListPerformance> = {};
    let totalTransfers = 0;
    let totalSales = 0;

    // Find this agent's per-list data from the grid
    for (const cell of agentGrid) {
      if (cell.agent !== agentName) continue;
      if (cell.transfers > 0 || cell.sales > 0) {
        byList[cell.listKey] = cell;
        totalTransfers += cell.transfers;
        totalSales += cell.sales;
      }
    }

    agents[agentName] = {
      agent: agentName,
      totalTransfers: agentData.t ?? totalTransfers,
      totalSales: agentData.deals ?? totalSales,
      overallCloseRate: totalTransfers > 0 ? totalSales / totalTransfers : 0,
      totalCost: agentData.cost ?? 0,
      byList,
      score: Math.round((totalTransfers > 0 ? totalSales / totalTransfers : 0) * 1000) / 10,
    };
  }

  const perf: PerformanceData = {
    lists,
    agents,
    lastUpdated: new Date().toISOString(),
  };

  // Store in KV
  await redis().set(KV_KEY, perf, { ex: 86400 }); // 24h TTL

  return perf;
}

// ─── Read cached performance ────────────────────────────────────────────────

export async function getPerformance(): Promise<PerformanceData | null> {
  return redis().get<PerformanceData>(KV_KEY);
}
