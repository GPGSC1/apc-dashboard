import { redis } from "./kv-schema";
import { todayCentral } from "./time";
import pg from "pg";

function getPool() {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("No POSTGRES_URL");
  return new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
}

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

// ─── Fetch stats directly from Postgres ─────────────────────────────────────

async function fetchPeriodStats(pool: pg.Pool, start: string, end: string): Promise<{
  listStats: Record<string, PeriodStats>;
  agentStats: Record<string, { transfers: number; deals: number; cost: number; min: number }>;
}> {
  // List-level: daily costs + opened calls + sales (simplified — no full attribution, just aggregates)
  const dcResult = await pool.query(
    "SELECT list_key, SUM(minutes) as min, SUM(cost) as cost FROM aim_daily_costs WHERE call_date BETWEEN $1 AND $2 GROUP BY list_key",
    [start, end]
  );

  const openedResult = await pool.query(
    "SELECT COUNT(*) as cnt FROM opened_calls WHERE call_date BETWEEN $1 AND $2",
    [start, end]
  );

  // Transfer counts per list
  const tResult = await pool.query(
    "SELECT list_key, COUNT(*) as cnt FROM aim_transfers WHERE call_date BETWEEN $1 AND $2 GROUP BY list_key",
    [start, end]
  );

  // Sales count per list (simplified: count moxy deals in mail4 + on list)
  const salesResult = await pool.query(`
    SELECT lp.list_key, COUNT(DISTINCT m.contract_no) as cnt
    FROM moxy_deals m
    INNER JOIN mail4_phones mp ON mp.phone = m.home_phone OR mp.phone = m.mobile_phone
    INNER JOIN list_phones lp ON lp.phone = m.home_phone OR lp.phone = m.mobile_phone
    WHERE m.sold_date BETWEEN $1 AND $2
      AND m.deal_status NOT IN ('Back Out', 'VOID', '')
      AND (m.salesperson IS NULL OR m.salesperson NOT ILIKE '%fishbein%')
    GROUP BY lp.list_key
  `, [start, end]);

  const listStats: Record<string, PeriodStats> = {};
  for (const row of dcResult.rows) {
    const lk = row.list_key.trim();
    const min = Math.round(parseFloat(row.min));
    const cost = Math.round(parseFloat(row.cost) * 100) / 100;
    listStats[lk] = { sales: 0, calls: 0, closeRate: 0, costPerSale: null, dialCost: cost, minutes: min };
  }
  for (const row of tResult.rows) {
    const lk = row.list_key.trim();
    if (!listStats[lk]) listStats[lk] = { sales: 0, calls: 0, closeRate: 0, costPerSale: null, dialCost: 0, minutes: 0 };
    listStats[lk].calls = parseInt(row.cnt);
  }
  for (const row of salesResult.rows) {
    const lk = row.list_key.trim();
    if (!listStats[lk]) listStats[lk] = { sales: 0, calls: 0, closeRate: 0, costPerSale: null, dialCost: 0, minutes: 0 };
    listStats[lk].sales = parseInt(row.cnt);
  }
  // Compute close rate and cost/sale
  for (const s of Object.values(listStats)) {
    s.closeRate = s.calls > 0 ? s.sales / s.calls : 0;
    s.costPerSale = s.sales > 0 ? s.dialCost / s.sales : null;
  }

  // Agent-level stats
  const agentResult = await pool.query(
    "SELECT agent, SUM(minutes) as min, SUM(cost) as cost FROM aim_agent_daily_costs WHERE call_date BETWEEN $1 AND $2 GROUP BY agent",
    [start, end]
  );
  const agentTResult = await pool.query(
    "SELECT agent, COUNT(*) as cnt FROM aim_transfers WHERE call_date BETWEEN $1 AND $2 AND agent IS NOT NULL GROUP BY agent",
    [start, end]
  );

  const agentStats: Record<string, { transfers: number; deals: number; cost: number; min: number }> = {};
  for (const row of agentResult.rows) {
    const a = row.agent.trim();
    agentStats[a] = { transfers: 0, deals: 0, cost: Math.round(parseFloat(row.cost) * 100) / 100, min: Math.round(parseFloat(row.min)) };
  }
  for (const row of agentTResult.rows) {
    const a = row.agent.trim();
    if (!agentStats[a]) agentStats[a] = { transfers: 0, deals: 0, cost: 0, min: 0 };
    agentStats[a].transfers = parseInt(row.cnt);
  }

  return { listStats, agentStats };
}

// ─── Main: refresh performance data ─────────────────────────────────────────

export async function refreshPerformance(): Promise<PerformanceData> {
  const pool = getPool();
  try {
    const today = todayCentral();
    const yesterday = yesterdayDate();
    const weekStart = weekStartDate();
    const monthStart = monthStartDate();

    // Query Postgres directly (no self-fetch) for all three periods
    const [yesterdayPeriod, wtdPeriod, mtdPeriod] = await Promise.all([
      fetchPeriodStats(pool, yesterday, yesterday),
      fetchPeriodStats(pool, weekStart, today),
      fetchPeriodStats(pool, monthStart, today),
    ]);

    // Build list performance
    const emptyStats: PeriodStats = { sales: 0, calls: 0, closeRate: 0, costPerSale: null, dialCost: 0, minutes: 0 };
    const allListKeys = new Set([
      ...Object.keys(yesterdayPeriod.listStats),
      ...Object.keys(wtdPeriod.listStats),
      ...Object.keys(mtdPeriod.listStats),
    ]);

    const lists: Record<string, ListPerformance> = {};
    for (const listKey of allListKeys) {
      const mtd = mtdPeriod.listStats[listKey] ?? emptyStats;
      lists[listKey] = {
        listKey,
        yesterday: yesterdayPeriod.listStats[listKey] ?? emptyStats,
        wtd: wtdPeriod.listStats[listKey] ?? emptyStats,
        mtd,
        score: Math.round(mtd.closeRate * 1000) / 10,
      };
    }

    // Build agent performance from MTD
    const agents: Record<string, AgentPerformance> = {};
    for (const [agentName, stats] of Object.entries(mtdPeriod.agentStats)) {
      agents[agentName] = {
        agent: agentName,
        totalTransfers: stats.transfers,
        totalSales: stats.deals,
        overallCloseRate: stats.transfers > 0 ? stats.deals / stats.transfers : 0,
        totalCost: stats.cost,
        byList: {},
        score: Math.round((stats.transfers > 0 ? stats.deals / stats.transfers : 0) * 1000) / 10,
      };
    }

    const perf: PerformanceData = {
      lists,
      agents,
      lastUpdated: new Date().toISOString(),
    };

    await redis().set(KV_KEY, perf, { ex: 86400 });
    return perf;
  } finally {
    await pool.end();
  }
}

// ─── Read cached performance ────────────────────────────────────────────────

export async function getPerformance(): Promise<PerformanceData | null> {
  return redis().get<PerformanceData>(KV_KEY);
}
