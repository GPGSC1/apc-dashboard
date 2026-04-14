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
  red: "#EF4444",
  amber: "#F59E0B",
  text: "#E8E8F0",
  muted: "#6B7280",
  mutedLight: "#9CA3AF",
  tableBorder: "#1E2A42",
};

const TABS = ["Projections", "Pipeline", "History"] as const;
type TabName = (typeof TABS)[number];

// ── Types ──
interface WeekData {
  range: { start: string; end: string };
  auto: { deals: number; admin: number };
  home: { deals: number; admin: number };
  total: { deals: number; admin: number };
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
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(d: string): string {
  if (!d) return "";
  const parts = d.split("-");
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

function fmtWeek(start: string, end: string): string {
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

// ── Metric Card ──
function MetricCard({
  label,
  value,
  sub,
  accent = C.gold,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderTop: `3px solid ${accent}`,
        borderRadius: 10,
        padding: "18px 20px",
        minWidth: 160,
        flex: "1 1 160px",
      }}
    >
      <div style={{ color: C.muted, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ color: C.text, fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ color: C.mutedLight, fontSize: 12, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ── Section Header ──
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        color: C.gold,
        fontSize: 15,
        fontWeight: 700,
        marginBottom: 12,
        marginTop: 28,
        textTransform: "uppercase",
        letterSpacing: "1px",
        borderBottom: `1px solid ${C.goldDim}33`,
        paddingBottom: 8,
      }}
    >
      {children}
    </h3>
  );
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

// ── Projections Tab ──
function ProjectionsTab({ data }: { data: ProjectionData }) {
  return (
    <div>
      {/* ── This Friday Funding ── */}
      <SectionHeader>This Friday — {fmtDate(data.thisFriday)} Funding</SectionHeader>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <MetricCard label="Auto Deals" value={String(data.thisWeek.auto.deals)} sub={fmt$(data.thisWeek.auto.admin) + " admin"} />
        <MetricCard label="Home Deals" value={String(data.thisWeek.home.deals)} sub={fmt$(data.thisWeek.home.admin) + " admin"} />
        <MetricCard label="Total Deals" value={String(data.thisWeek.total.deals)} sub={fmt$(data.thisWeek.total.admin) + " total admin"} accent={C.goldLight} />
      </div>

      {/* ── Next Friday Funding ── */}
      <SectionHeader>Next Friday — {fmtDate(data.nextFriday)} Funding</SectionHeader>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <MetricCard label="Auto Deals" value={String(data.nextWeek.auto.deals)} sub={fmt$(data.nextWeek.auto.admin) + " admin"} />
        <MetricCard label="Home Deals" value={String(data.nextWeek.home.deals)} sub={fmt$(data.nextWeek.home.admin) + " admin"} />
        <MetricCard label="Total Deals" value={String(data.nextWeek.total.deals)} sub={fmt$(data.nextWeek.total.admin) + " total admin"} accent={C.goldLight} />
      </div>

      {/* ── MTD ── */}
      <SectionHeader>Month to Date</SectionHeader>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <MetricCard label="Auto MTD" value={String(data.mtd.auto.deals)} sub={fmt$(data.mtd.auto.admin) + " admin"} accent={C.amber} />
        <MetricCard label="Home MTD" value={String(data.mtd.home.deals)} sub={fmt$(data.mtd.home.admin) + " admin"} accent={C.amber} />
        <MetricCard label="Total MTD" value={String(data.mtd.total.deals)} sub={fmt$(data.mtd.total.admin) + " total"} accent={C.goldLight} />
      </div>

      {/* ── WALCO Payments ── */}
      <SectionHeader>WALCO Payments This Week</SectionHeader>
      {data.walco.count > 0 ? (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <MetricCard label="Payments Received" value={String(data.walco.count)} accent={C.green} />
          <MetricCard label="Total Received" value={fmt$(data.walco.total)} accent={C.green} />
        </div>
      ) : (
        <div
          style={{
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            padding: "20px 24px",
            color: C.muted,
            fontSize: 13,
            fontStyle: "italic",
          }}
        >
          WALCO payment data not yet available — Lenovo is setting up the PBS portal capture.
        </div>
      )}

      {/* ── Fee Schedule Reference ── */}
      <SectionHeader>Fee & Reserve Schedule</SectionHeader>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
                <Td>{tier.minTerm}–{tier.maxTerm > 100 ? "60+" : tier.maxTerm} months</Td>
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
  // Merge auto and home pipeline items
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

  return (
    <div>
      <SectionHeader>Deal Pipeline — Since {fmtDate(data.thisWeek.range.start)}</SectionHeader>

      {/* ── Funnel Summary ── */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
        <MetricCard
          label="Total in Pipeline"
          value={String(totalAll)}
          accent={C.gold}
        />
        <MetricCard
          label="Sold / Active"
          value={String(
            statuses
              .filter(([s]) => s.toLowerCase() === "sold" || s.toLowerCase() === "active")
              .reduce((sum, [, v]) => sum + v.auto + v.home, 0)
          )}
          accent={C.green}
        />
        <MetricCard
          label="Back Out / Cancelled"
          value={String(
            statuses
              .filter(([s]) => s.toLowerCase().includes("back out") || s.toLowerCase().includes("cancel") || s.toLowerCase().includes("void"))
              .reduce((sum, [, v]) => sum + v.auto + v.home, 0)
          )}
          accent={C.red}
        />
      </div>

      {/* ── Status Breakdown Table ── */}
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
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: statusColor(status),
                        marginRight: 8,
                      }}
                    />
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
              <Td align="right" bold color={C.goldLight}>
                {fmt$(statuses.reduce((s, [, v]) => s + v.autoAdmin + v.homeAdmin, 0))}
              </Td>
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

  // Week-over-Week data is already in data.history (last 8 weeks)
  // Month-over-Month: aggregate by month from history
  const months = new Map<string, { autoDeals: number; homeDeals: number; autoAdmin: number; homeAdmin: number }>();
  for (const w of data.history) {
    const m = w.weekStart.slice(0, 7); // "YYYY-MM"
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
              borderRadius: 8,
              border: `1px solid ${mode === m ? C.gold : C.border}`,
              background: mode === m ? C.gold + "22" : C.card,
              color: mode === m ? C.gold : C.muted,
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
                  <Th align="right">Admin $</Th>
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
                    <tr
                      key={w.weekStart}
                      style={{
                        background: current ? C.gold + "0A" : "transparent",
                      }}
                    >
                      <Td bold={current} color={current ? C.gold : C.text}>
                        {fmtWeek(w.weekStart, w.weekEnd)}
                        {current && (
                          <span
                            style={{
                              fontSize: 9,
                              color: C.goldDim,
                              marginLeft: 8,
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: "0.5px",
                            }}
                          >
                            current
                          </span>
                        )}
                      </Td>
                      <Td align="right">{w.autoDeals}</Td>
                      <Td align="right">{w.homeDeals}</Td>
                      <Td align="right" bold>{total}</Td>
                      <Td align="right" color={C.goldLight}>{fmt$(totalAdmin)}</Td>
                      <Td
                        align="right"
                        color={delta > 0 ? C.green : delta < 0 ? C.red : C.muted}
                        bold
                      >
                        {prior ? (delta > 0 ? "+" : "") + delta : "—"}
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
                  <Th align="right">Admin $</Th>
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
                        {current && (
                          <span style={{ fontSize: 9, color: C.goldDim, marginLeft: 8, fontWeight: 600, textTransform: "uppercase" }}>
                            current
                          </span>
                        )}
                      </Td>
                      <Td align="right">{v.autoDeals}</Td>
                      <Td align="right">{v.homeDeals}</Td>
                      <Td align="right" bold>{total}</Td>
                      <Td align="right" color={C.goldLight}>{fmt$(totalAdmin)}</Td>
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
    // Auto-refresh every 60 seconds
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
      {/* ── Header ── */}
      <div
        style={{
          padding: "20px 32px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a
            href="/"
            style={{
              color: C.muted,
              textDecoration: "none",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            &larr; Home
          </a>
          <div
            style={{
              width: 1,
              height: 20,
              background: C.border,
            }}
          />
          <h1 style={{ fontSize: 20, fontWeight: 800, color: C.gold, margin: 0 }}>
            Owner Dashboard
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {lastRefresh && (
            <span style={{ color: C.muted, fontSize: 11 }}>Updated {lastRefresh}</span>
          )}
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
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div
        style={{
          padding: "0 32px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          gap: 0,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "14px 24px",
              border: "none",
              borderBottom: tab === t ? `2px solid ${C.gold}` : `2px solid transparent`,
              background: "transparent",
              color: tab === t ? C.gold : C.muted,
              fontSize: 14,
              fontWeight: tab === t ? 700 : 500,
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div style={{ padding: "24px 32px", maxWidth: 1200 }}>
        {error && (
          <div
            style={{
              background: C.red + "22",
              border: `1px solid ${C.red}44`,
              borderRadius: 8,
              padding: "12px 16px",
              color: C.red,
              fontSize: 13,
              marginBottom: 20,
            }}
          >
            {error}
          </div>
        )}

        {loading && !data ? (
          <div style={{ textAlign: "center", padding: 80, color: C.muted }}>
            <div
              style={{
                width: 32,
                height: 32,
                border: `3px solid ${C.border}`,
                borderTop: `3px solid ${C.gold}`,
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
                margin: "0 auto 16px",
              }}
            />
            Loading projections...
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        ) : data ? (
          <>
            {tab === "Projections" && <ProjectionsTab data={data} />}
            {tab === "Pipeline" && <PipelineTab data={data} />}
            {tab === "History" && <HistoryTab data={data} />}
          </>
        ) : null}
      </div>
    </div>
  );
}
