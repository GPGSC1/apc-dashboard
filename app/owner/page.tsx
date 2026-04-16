"use client";

import { useEffect, useState, useCallback } from "react";

// ── Gold accent theme ──
const C = {
  bg: "#06080F",
  card: "#0C0F1A",
  cardAlt: "#111520",
  border: "#1B2440",
  gold: "#D4A017",
  goldLight: "#F5D060",
  goldDim: "#8B6914",
  green: "#22C55E",
  greenDark: "#16A34A",
  teal: "#14B8A6",
  red: "#EF4444",
  amber: "#F59E0B",
  text: "#E8E8F0",
  muted: "#6B7280",
  mutedLight: "#9CA3AF",
  tableBorder: "#1E2A42",
};

const TABS = ["Projections", "Pipeline", "History", "Per-Rep"] as const;
type TabName = (typeof TABS)[number];

// ── Per-Rep types ──
interface RepStats {
  owner: string;
  autoDeals: number;
  homeDeals: number;
  totalDeals: number;
  autoFunded: number;
  homeFunded: number;
  totalFunded: number;
  potentialFunding: number;
  actualFunding: number;
  fundingPct: number;
}
interface PerRepData {
  ok: boolean;
  today: string;
  range: { start: string; end: string };
  reps: RepStats[];
  totals: {
    autoDeals: number;
    homeDeals: number;
    totalDeals: number;
    autoFunded: number;
    homeFunded: number;
    totalFunded: number;
    potentialFunding: number;
    actualFunding: number;
    fundingPct: number;
  };
}

// ── Types ──
interface WeekData {
  range: { start: string; end: string };
  auto: { deals: number; admin: number; funding: number; avgFunding: number };
  home: { deals: number; admin: number; funding: number; avgFunding: number };
  total: { deals: number; admin: number; funding: number; avgFunding: number };
}

interface PipelineItem {
  status: string;
  count: number;
  admin: number;
}

interface HistoryWeek {
  weekStart: string;
  weekEnd: string;
  autoDeals: number;
  homeDeals: number;
  autoAdmin: number;
  homeAdmin: number;
}

interface ProjectionData {
  ok: boolean;
  today: string;
  thisFriday: string;
  nextFriday: string;
  thisWeek: WeekData;
  nextWeek: WeekData;
  mtd: {
    monthStart: string;
    auto: { deals: number; admin: number };
    home: { deals: number; admin: number };
    total: { deals: number; admin: number };
  };
  pipeline: { auto: PipelineItem[]; home: PipelineItem[] };
  walco: { count: number; total: number };
  history: HistoryWeek[];
  feeSchedule: { minTerm: number; maxTerm: number; feeRate: number; reserveRate: number }[];
}

// ── Formatting helpers ──
function fmt$(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(d: string): string {
  if (!d) return "";
  const parts = d.split("-");
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

function fmtFullDate(d: string): string {
  if (!d) return "";
  const dt = new Date(d + "T12:00:00Z");
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtWeek(start: string, end: string): string {
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

function fmtInputDate(d: string): string {
  if (!d) return "";
  const p = d.split("-");
  return `${p[1]}/${p[2]}/${p[0]}`;
}

// ── Th/Td primitives ──
function Th({ children, align = "left", width }: { children: React.ReactNode; align?: string; width?: number | string }) {
  return (
    <th
      style={{
        textAlign: align as "left" | "right" | "center",
        padding: "10px 14px",
        fontSize: 11,
        fontWeight: 700,
        color: C.goldDim,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        borderBottom: `2px solid ${C.goldDim}44`,
        whiteSpace: "nowrap",
        width,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  bold,
  color,
}: {
  children: React.ReactNode;
  align?: string;
  bold?: boolean;
  color?: string;
}) {
  return (
    <td
      style={{
        textAlign: align as "left" | "right" | "center",
        padding: "10px 14px",
        fontSize: 13,
        fontWeight: bold ? 700 : 400,
        color: color || C.text,
        borderBottom: `1px solid ${C.tableBorder}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}

// ── Friday Funding Card (matches Inspiron mockup) ──
function FridayCard({
  title,
  date,
  windowStart,
  windowEnd,
  auto,
  home,
  total,
  partial,
}: {
  title: string;
  date: string;
  windowStart: string;
  windowEnd: string;
  auto: { deals: number; funding: number; avgFunding: number };
  home: { deals: number; funding: number; avgFunding: number };
  total: { deals: number; funding: number; avgFunding: number };
  partial?: boolean;
}) {
  return (
    <div
      style={{
        flex: "1 1 400px",
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "24px 28px",
        minWidth: 340,
      }}
    >
      {/* Title Row */}
      <div style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{title}</span>
      </div>
      <div style={{ color: C.mutedLight, fontSize: 12, marginBottom: 20 }}>
        {fmtFullDate(date)} &bull; Window: {fmtDate(windowStart)} – {fmtDate(windowEnd)}
        {partial && " (partial)"}
      </div>

      {/* Hero funding amount */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 24 }}>
        <span style={{ fontSize: 42, fontWeight: 800, color: C.green, lineHeight: 1 }}>
          {fmt$(total.funding)}
        </span>
        <span style={{ fontSize: 16, color: C.mutedLight, fontWeight: 500 }}>
          {total.deals} deals
        </span>
      </div>

      {/* Line breakdown table */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.tableBorder}` }}>
            <th style={{ textAlign: "left", padding: "8px 0", fontSize: 12, fontWeight: 600, color: C.mutedLight }}>Line</th>
            <th style={{ textAlign: "right", padding: "8px 0", fontSize: 12, fontWeight: 600, color: C.mutedLight }}>Count</th>
            <th style={{ textAlign: "right", padding: "8px 0", fontSize: 12, fontWeight: 600, color: C.mutedLight }}>Total Funding</th>
            <th style={{ textAlign: "right", padding: "8px 0", fontSize: 12, fontWeight: 600, color: C.mutedLight }}>Avg Funding</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: `1px solid ${C.tableBorder}` }}>
            <td style={{ padding: "10px 0", fontSize: 14, fontWeight: 500, color: C.text }}>Auto</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", color: C.text }}>{auto.deals}</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", color: C.green, fontWeight: 600 }}>{fmt$(auto.funding)}</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", color: C.text }}>{fmt$(auto.avgFunding)}</td>
          </tr>
          <tr style={{ borderBottom: `1px solid ${C.tableBorder}` }}>
            <td style={{ padding: "10px 0", fontSize: 14, fontWeight: 500, color: C.text }}>Home</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", color: C.text }}>{home.deals}</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", color: C.green, fontWeight: 600 }}>{fmt$(home.funding)}</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", color: C.text }}>{fmt$(home.avgFunding)}</td>
          </tr>
          <tr>
            <td style={{ padding: "10px 0", fontSize: 14, fontWeight: 700, color: C.gold }}>Total</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", fontWeight: 700, color: C.gold }}>{total.deals}</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", fontWeight: 700, color: C.green }}>{fmt$(total.funding)}</td>
            <td style={{ padding: "10px 0", fontSize: 14, textAlign: "right", fontWeight: 700, color: C.gold }}>{fmt$(total.avgFunding)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Summary Stat Card (bottom row) ──
function SummaryCard({ label, value, color = C.text }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        flex: "1 1 180px",
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: "20px 20px 16px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 800, color, lineHeight: 1.2, marginBottom: 6 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.mutedLight, textTransform: "uppercase", letterSpacing: "1px" }}>
        {label}
      </div>
    </div>
  );
}

// ── Section Header ──
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        color: C.text,
        fontSize: 15,
        fontWeight: 700,
        marginBottom: 16,
        marginTop: 32,
        textTransform: "uppercase",
        letterSpacing: "1.5px",
      }}
    >
      {children}
    </h3>
  );
}

// ── Projections Tab (matches Inspiron mockup) ──
function ProjectionsTab({ data }: { data: ProjectionData }) {
  const twoWeekFunding = data.thisWeek.total.funding + data.nextWeek.total.funding;
  const twoWeekDeals = data.thisWeek.total.deals + data.nextWeek.total.deals;
  const avgFunding = twoWeekDeals > 0 ? twoWeekFunding / twoWeekDeals : 0;
  // Eligibility rate placeholder — needs WALCO payment matching to be real
  const eligibilityRate = data.mtd.total.deals > 0 ? ((twoWeekDeals / data.mtd.total.deals) * 100) : 0;

  return (
    <div>
      <SectionHeader>Projected Funding</SectionHeader>

      {/* ── Side-by-side Friday cards ── */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <FridayCard
          title="This Friday"
          date={data.thisFriday}
          windowStart={data.thisWeek.range.start}
          windowEnd={data.thisWeek.range.end}
          auto={data.thisWeek.auto}
          home={data.thisWeek.home}
          total={data.thisWeek.total}
        />
        <FridayCard
          title="Next Friday"
          date={data.nextFriday}
          windowStart={data.nextWeek.range.start}
          windowEnd={data.nextWeek.range.end}
          auto={data.nextWeek.auto}
          home={data.nextWeek.home}
          total={data.nextWeek.total}
          partial
        />
      </div>

      {/* ── 4 Summary Cards ── */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 24 }}>
        <SummaryCard label="Total 2-Week Projection" value={fmt$(twoWeekFunding)} color={C.green} />
        <SummaryCard label="Total Eligible Deals" value={String(twoWeekDeals)} color={C.text} />
        <SummaryCard label="Avg Funding Per Deal" value={fmt$(avgFunding)} color={C.teal} />
        <SummaryCard
          label="Eligibility Rate"
          value={eligibilityRate > 0 ? eligibilityRate.toFixed(1) + "%" : "—"}
          color={C.green}
        />
      </div>

      {/* ── Fee Schedule Reference ── */}
      <SectionHeader>Fee & Reserve Schedule</SectionHeader>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", maxWidth: 500 }}>
          <thead>
            <tr>
              <Th>Term Range</Th>
              <Th align="right">Fee Rate</Th>
              <Th align="right">Reserve Rate</Th>
            </tr>
          </thead>
          <tbody>
            {data.feeSchedule.map((tier, i) => (
              <tr key={i}>
                <Td>{tier.minTerm}–{tier.maxTerm > 100 ? "24+" : tier.maxTerm} months</Td>
                <Td align="right">{fmtPct(tier.feeRate)}</Td>
                <Td align="right">{fmtPct(tier.reserveRate)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Pipeline Tab ──
function PipelineTab({ data }: { data: ProjectionData }) {
  const statusMap = new Map<string, { auto: number; home: number; autoAdmin: number; homeAdmin: number }>();
  for (const item of data.pipeline.auto) {
    const existing = statusMap.get(item.status) || { auto: 0, home: 0, autoAdmin: 0, homeAdmin: 0 };
    existing.auto += item.count;
    existing.autoAdmin += item.admin;
    statusMap.set(item.status, existing);
  }
  for (const item of data.pipeline.home) {
    const existing = statusMap.get(item.status) || { auto: 0, home: 0, autoAdmin: 0, homeAdmin: 0 };
    existing.home += item.count;
    existing.homeAdmin += item.admin;
    statusMap.set(item.status, existing);
  }
  const statuses = [...statusMap.entries()].sort((a, b) => (b[1].auto + b[1].home) - (a[1].auto + a[1].home));

  const statusColor = (s: string): string => {
    const sl = s.toLowerCase();
    if (sl === "sold" || sl === "active") return C.green;
    if (sl.includes("cancel") || sl.includes("void")) return C.red;
    if (sl.includes("back out")) return C.red;
    return C.amber;
  };

  const totalAll = statuses.reduce((sum, [, v]) => sum + v.auto + v.home, 0);
  const soldActive = statuses
    .filter(([s]) => s.toLowerCase() === "sold" || s.toLowerCase() === "active")
    .reduce((sum, [, v]) => sum + v.auto + v.home, 0);
  const backoutCancelled = statuses
    .filter(([s]) => s.toLowerCase().includes("back out") || s.toLowerCase().includes("cancel") || s.toLowerCase().includes("void"))
    .reduce((sum, [, v]) => sum + v.auto + v.home, 0);

  return (
    <div>
      <SectionHeader>Deal Pipeline — Since {fmtDate(data.thisWeek.range.start)}</SectionHeader>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
        <SummaryCard label="Total in Pipeline" value={String(totalAll)} color={C.gold} />
        <SummaryCard label="Sold / Active" value={String(soldActive)} color={C.green} />
        <SummaryCard label="Back Out / Cancelled" value={String(backoutCancelled)} color={C.red} />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <Th width="30%">Status</Th>
              <Th align="right">Auto</Th>
              <Th align="right">Home</Th>
              <Th align="right">Total</Th>
              <Th align="right">Admin $</Th>
              <Th align="right">% of Pipeline</Th>
            </tr>
          </thead>
          <tbody>
            {statuses.map(([status, v]) => {
              const total = v.auto + v.home;
              const pct = totalAll > 0 ? ((total / totalAll) * 100).toFixed(1) : "0.0";
              return (
                <tr key={status}>
                  <Td bold color={statusColor(status)}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: statusColor(status), marginRight: 8 }} />
                    {status || "(empty)"}
                  </Td>
                  <Td align="right">{v.auto}</Td>
                  <Td align="right">{v.home}</Td>
                  <Td align="right" bold>{total}</Td>
                  <Td align="right" color={C.goldLight}>{fmt$(v.autoAdmin + v.homeAdmin)}</Td>
                  <Td align="right">{pct}%</Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${C.goldDim}44` }}>
              <Td bold color={C.gold}>TOTAL</Td>
              <Td align="right" bold>{statuses.reduce((s, [, v]) => s + v.auto, 0)}</Td>
              <Td align="right" bold>{statuses.reduce((s, [, v]) => s + v.home, 0)}</Td>
              <Td align="right" bold color={C.goldLight}>{totalAll}</Td>
              <Td align="right" bold color={C.goldLight}>{fmt$(statuses.reduce((s, [, v]) => s + v.autoAdmin + v.homeAdmin, 0))}</Td>
              <Td align="right" bold>100%</Td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ── History Tab ──
function HistoryTab({ data }: { data: ProjectionData }) {
  const [mode, setMode] = useState<"wow" | "mom">("wow");

  const months = new Map<string, { autoDeals: number; homeDeals: number; autoAdmin: number; homeAdmin: number }>();
  for (const w of data.history) {
    const m = w.weekStart.slice(0, 7);
    const existing = months.get(m) || { autoDeals: 0, homeDeals: 0, autoAdmin: 0, homeAdmin: 0 };
    existing.autoDeals += w.autoDeals;
    existing.homeDeals += w.homeDeals;
    existing.autoAdmin += w.autoAdmin;
    existing.homeAdmin += w.homeAdmin;
    months.set(m, existing);
  }
  const monthList = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const isCurrentWeek = (ws: string) => ws === data.thisWeek.range.start;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {(["wow", "mom"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: "8px 20px",
              borderRadius: 20,
              border: mode === m ? "none" : `1px solid ${C.border}`,
              background: mode === m ? C.gold : C.card,
              color: mode === m ? "#000" : C.muted,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
            {m === "wow" ? "Week over Week" : "Month over Month"}
          </button>
        ))}
      </div>

      {mode === "wow" ? (
        <>
          <SectionHeader>Week-over-Week</SectionHeader>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <Th>Week</Th>
                  <Th align="right">Auto</Th>
                  <Th align="right">Home</Th>
                  <Th align="right">Total</Th>
                  <Th align="right">Total Funding</Th>
                  <Th align="right">vs Prior</Th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((w, i) => {
                  const total = w.autoDeals + w.homeDeals;
                  const totalAdmin = w.autoAdmin + w.homeAdmin;
                  const prior = data.history[i + 1];
                  const priorTotal = prior ? prior.autoDeals + prior.homeDeals : 0;
                  const delta = prior ? total - priorTotal : 0;
                  const current = isCurrentWeek(w.weekStart);

                  return (
                    <tr key={w.weekStart} style={{ background: current ? C.gold + "0A" : "transparent" }}>
                      <Td bold={current} color={current ? C.gold : C.text}>
                        {fmtWeek(w.weekStart, w.weekEnd)}
                        {current && (
                          <span style={{ fontSize: 9, color: C.goldDim, marginLeft: 8, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                            current
                          </span>
                        )}
                      </Td>
                      <Td align="right">{w.autoDeals}</Td>
                      <Td align="right">{w.homeDeals}</Td>
                      <Td align="right" bold>{total}</Td>
                      <Td align="right" color={C.green}>{fmt$(totalAdmin)}</Td>
                      <Td align="right" color={delta > 0 ? C.green : delta < 0 ? C.red : C.muted} bold>
                        {prior ? (delta > 0 ? "+" : "") + delta : "\u2014"}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <SectionHeader>Month-over-Month</SectionHeader>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th align="right">Auto</Th>
                  <Th align="right">Home</Th>
                  <Th align="right">Total</Th>
                  <Th align="right">Total Funding</Th>
                </tr>
              </thead>
              <tbody>
                {monthList.map(([m, v]) => {
                  const total = v.autoDeals + v.homeDeals;
                  const totalAdmin = v.autoAdmin + v.homeAdmin;
                  const current = m === data.today.slice(0, 7);
                  return (
                    <tr key={m} style={{ background: current ? C.gold + "0A" : "transparent" }}>
                      <Td bold={current} color={current ? C.gold : C.text}>
                        {m}
                        {current && <span style={{ fontSize: 9, color: C.goldDim, marginLeft: 8, fontWeight: 600, textTransform: "uppercase" }}>current</span>}
                      </Td>
                      <Td align="right">{v.autoDeals}</Td>
                      <Td align="right">{v.homeDeals}</Td>
                      <Td align="right" bold>{total}</Td>
                      <Td align="right" color={C.green}>{fmt$(totalAdmin)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Per-Rep Tab ──
type SortKey = "owner" | "totalDeals" | "totalFunded" | "potentialFunding" | "actualFunding" | "fundingPct";

function PerRepTab() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  const [start, setStart] = useState(monthStart);
  const [end, setEnd] = useState(today);
  const [data, setData] = useState<PerRepData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("actualFunding");
  const [sortDesc, setSortDesc] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/owner/per-rep?start=${start}&end=${end}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "API error");
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDesc(!sortDesc);
    } else {
      setSortKey(key);
      setSortDesc(key !== "owner"); // strings asc, numbers desc by default
    }
  }

  const sortedReps = data
    ? [...data.reps].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (Number(av) - Number(bv));
        return sortDesc ? -cmp : cmp;
      })
    : [];

  function SortHeader({ k, children, align }: { k: SortKey; children: React.ReactNode; align?: string }) {
    const active = sortKey === k;
    return (
      <th
        onClick={() => handleSort(k)}
        style={{
          textAlign: (align as "left" | "right" | "center") || "left",
          padding: "10px 14px",
          fontSize: 11,
          fontWeight: 700,
          color: active ? C.gold : C.goldDim,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          borderBottom: `2px solid ${C.goldDim}44`,
          whiteSpace: "nowrap",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        {children}
        {active ? (sortDesc ? " ▼" : " ▲") : ""}
      </th>
    );
  }

  function pctColor(pct: number): string {
    if (pct >= 85) return C.green;
    if (pct >= 70) return C.teal;
    if (pct >= 50) return C.amber;
    return C.red;
  }

  return (
    <div>
      <SectionHeader>Per-Rep Funding Performance</SectionHeader>

      {/* Date range filter */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: C.mutedLight, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>From</span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={{ background: C.cardAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 13, fontFamily: "inherit" }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: C.mutedLight, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>To</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            style={{ background: C.cardAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 13, fontFamily: "inherit" }}
          />
        </div>
        <button
          onClick={() => { setStart(monthStart); setEnd(today); }}
          style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.cardAlt, color: C.muted, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
        >MTD</button>
        <button
          onClick={() => {
            const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 30);
            setStart(d.toISOString().slice(0, 10)); setEnd(today);
          }}
          style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.cardAlt, color: C.muted, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
        >Last 30 days</button>
        <button
          onClick={() => { setStart("2026-01-01"); setEnd(today); }}
          style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.cardAlt, color: C.muted, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
        >YTD</button>
        {loading && <span style={{ color: C.muted, fontSize: 12 }}>Loading...</span>}
      </div>

      {error && (
        <div style={{ background: C.red + "22", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "12px 16px", color: C.red, fontSize: 13, marginBottom: 20 }}>{error}</div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
            <SummaryCard label="Reps" value={String(data.reps.length)} color={C.gold} />
            <SummaryCard label="Total Deals Sold" value={String(data.totals.totalDeals)} color={C.text} />
            <SummaryCard label="Funded Deals" value={String(data.totals.totalFunded)} color={C.green} />
            <SummaryCard label="Potential Funding" value={fmt$(data.totals.potentialFunding)} color={C.goldLight} />
            <SummaryCard label="Actual Funding" value={fmt$(data.totals.actualFunding)} color={C.green} />
            <SummaryCard label="Funding %" value={data.totals.fundingPct.toFixed(1) + "%"} color={pctColor(data.totals.fundingPct)} />
          </div>

          {/* Per-rep table */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <SortHeader k="owner">Sales Rep (Owner)</SortHeader>
                  <Th align="right">Auto</Th>
                  <Th align="right">Home</Th>
                  <SortHeader k="totalDeals" align="right">Total Deals</SortHeader>
                  <SortHeader k="totalFunded" align="right">Funded Deals</SortHeader>
                  <SortHeader k="potentialFunding" align="right">Potential $</SortHeader>
                  <SortHeader k="actualFunding" align="right">Actual $</SortHeader>
                  <SortHeader k="fundingPct" align="right">Funding %</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sortedReps.map((r) => (
                  <tr key={r.owner}>
                    <Td bold>{r.owner}</Td>
                    <Td align="right">{r.autoDeals}</Td>
                    <Td align="right">{r.homeDeals}</Td>
                    <Td align="right" bold>{r.totalDeals}</Td>
                    <Td align="right" color={C.green}>{r.totalFunded}</Td>
                    <Td align="right" color={C.goldLight}>{fmt$(r.potentialFunding)}</Td>
                    <Td align="right" color={C.green} bold>{fmt$(r.actualFunding)}</Td>
                    <Td align="right" bold color={pctColor(r.fundingPct)}>{r.fundingPct.toFixed(1)}%</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${C.goldDim}44` }}>
                  <Td bold color={C.gold}>TOTAL</Td>
                  <Td align="right" bold>{data.totals.autoDeals}</Td>
                  <Td align="right" bold>{data.totals.homeDeals}</Td>
                  <Td align="right" bold color={C.gold}>{data.totals.totalDeals}</Td>
                  <Td align="right" bold color={C.green}>{data.totals.totalFunded}</Td>
                  <Td align="right" bold color={C.goldLight}>{fmt$(data.totals.potentialFunding)}</Td>
                  <Td align="right" bold color={C.green}>{fmt$(data.totals.actualFunding)}</Td>
                  <Td align="right" bold color={pctColor(data.totals.fundingPct)}>{data.totals.fundingPct.toFixed(1)}%</Td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Footnote */}
          <div style={{ marginTop: 16, padding: 12, background: C.cardAlt, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, color: C.mutedLight, lineHeight: 1.5 }}>
            <strong style={{ color: C.gold }}>Methodology:</strong> Filter by <code>sold_date</code>. Attribution by <code>owner</code> (Sales Rep — primary rep assigned to the deal, not the takeover closer).
            <strong style={{ color: C.text }}> Potential</strong> = sum of WALCO funding for every Sold deal in range using the standard fee/reserve formula.
            <strong style={{ color: C.text }}> Actual</strong> = same formula, restricted to deals that have triggered WALCO funding (have at least one positive payment with no later reversal — equivalent to passing the workbook's pymts-made + neg-skip rules at any point in time).
            <strong style={{ color: C.text }}> Funding %</strong> = Actual / Potential.
            Recently-sold deals will show low funding % until their first payment lands (typically 30 days post-sale).
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Page ──
export default function OwnerDashboard() {
  const [tab, setTab] = useState<TabName>("Projections");
  const [data, setData] = useState<ProjectionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string>("");

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/owner/projections");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "API error");
      setData(json);
      setError(null);
      setLastRefresh(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 60_000);
    return () => clearInterval(iv);
  }, [fetchData]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        color: C.text,
      }}
    >
      {/* ── Header (matches Inspiron mockup) ── */}
      <div
        style={{
          padding: "16px 32px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          gap: 24,
        }}
      >
        {/* Left: Home + Title */}
        <a href="/" style={{ color: C.muted, textDecoration: "none", fontSize: 13 }}>&larr; Home</a>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: C.gold, margin: 0, lineHeight: 1.1 }}>
            Owner Dash
          </h1>
          <div style={{ fontSize: 11, color: C.mutedLight, fontWeight: 500 }}>Funding Projections</div>
        </div>

        {/* Tabs inline in header */}
        <div style={{ display: "flex", gap: 4, marginLeft: 24 }}>
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "8px 20px",
                borderRadius: 20,
                border: tab === t ? "none" : `1px solid ${C.border}`,
                background: tab === t ? C.gold : "transparent",
                color: tab === t ? "#000" : C.muted,
                fontSize: 13,
                fontWeight: tab === t ? 700 : 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Data as of badge */}
        {data && (
          <div
            style={{
              marginLeft: 16,
              padding: "4px 12px",
              borderRadius: 6,
              background: C.gold + "22",
              border: `1px solid ${C.goldDim}`,
              fontSize: 11,
              color: C.gold,
              fontWeight: 600,
            }}
          >
            Data as of {fmtInputDate(data.today)}
          </div>
        )}

        {/* Right: date + refresh */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {lastRefresh && <span style={{ color: C.muted, fontSize: 11 }}>Updated {lastRefresh}</span>}
          <button
            onClick={fetchData}
            disabled={loading}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: `1px solid ${C.goldDim}`,
              background: "transparent",
              color: C.gold,
              fontSize: 12,
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ padding: "24px 32px", maxWidth: 1200 }}>
        {error && (
          <div style={{ background: C.red + "22", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "12px 16px", color: C.red, fontSize: 13, marginBottom: 20 }}>
            {error}
          </div>
        )}

        {loading && !data ? (
          <div style={{ textAlign: "center", padding: 80, color: C.muted }}>
            <div style={{ width: 32, height: 32, border: `3px solid ${C.border}`, borderTop: `3px solid ${C.gold}`, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
            Loading projections...
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        ) : data ? (
          <>
            {tab === "Projections" && <ProjectionsTab data={data} />}
            {tab === "Pipeline" && <PipelineTab data={data} />}
            {tab === "History" && <HistoryTab data={data} />}
            {tab === "Per-Rep" && <PerRepTab />}
          </>
        ) : null}
      </div>
    </div>
  );
}
