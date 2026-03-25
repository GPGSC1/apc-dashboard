"use client";
import { useState, useEffect, useCallback } from "react";

/* ── design tokens ─────────────────────────────────────────────────────────── */
const C = {
  bg: "#0D0D14",
  card: "#15151F",
  cardHover: "#1A1A26",
  input: "#1E1E2A",
  border: "#2D2D3A",
  text: "#FFFFFF",
  secondary: "#9CA3AF",
  muted: "#6B7280",
  purple: "#6B2D99",
  purpleDark: "#4A1D6A",
  purpleLight: "#8B4DB9",
  orange: "#F37021",
  orangeLight: "#FF8C42",
  green: "#2D7A5F",
  greenDark: "#1B4D3E",
  greenLight: "#3F9B75",
  success: "#10B981",
  warning: "#F59E0B",
  danger: "#EF4444",
};

const FONT = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif";

/* ── helpers ────────────────────────────────────────────────────────────────── */
const fmt = (n: number) => (n || 0).toLocaleString();
const pct = (n: number) => (n != null && !isNaN(n) ? (n * 100).toFixed(1) + "%" : "0.0%");

const AUTO_QUEUES = ["A1", "A2", "A3", "A4", "A5", "A6"];
const HOME_QUEUES = ["H1", "H2", "H3", "H4", "H5"];
const ALL_QUEUES = [...AUTO_QUEUES, ...HOME_QUEUES];

const TEAM_COLORS = [C.purple, C.orange, C.danger, C.green];

/* ── types ──────────────────────────────────────────────────────────────────── */
interface QueueStats {
  deals: number;
  calls: number;
  closeRate: number;
  unanswered?: number;
}
interface SalespersonStats {
  totalDeals: number;
  totalCalls: number;
  closeRate: number;
  queues: Record<string, { deals: number; calls: number }>;
}
interface TotalStats {
  deals: number;
  calls: number;
  closeRate: number;
}
interface DailyTrend {
  date: string;
  deals: number;
}
interface SalesData {
  companyTotal: TotalStats;
  autoTotal: TotalStats;
  homeTotal: TotalStats;
  byQueue: Record<string, QueueStats>;
  bySalesperson: Record<string, SalespersonStats>;
  teams: Record<string, string[]>;
  dailyTrends: DailyTrend[];
  staleness: { moxy: string | null; cx: string | null };
  dateRange: { from: string; to: string };
}

type TabId = "overview" | "performance" | "availability" | "trends" | "textmike";
type SortKey = "name" | "deals" | "calls" | "closeRate" | string;

/* ── tab definitions ────────────────────────────────────────────────────────── */
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "\u{1F4CA} Overview" },
  { id: "performance", label: "\u{1F3C6} Performance" },
  { id: "availability", label: "\u23F0 Availability" },
  { id: "trends", label: "\u{1F4C8} Trends" },
  { id: "textmike", label: "\u{1F4F1} Text Mike" },
];

/* ── component ──────────────────────────────────────────────────────────────── */
export default function SalesDashboard() {
  const todayStr = new Date().toISOString().slice(0, 10);

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [data, setData] = useState<SalesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState(todayStr);
  const [toDate, setToDate] = useState(todayStr);
  const [byTeamMode, setByTeamMode] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("deals");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedTeams, setExpandedTeams] = useState<Record<string, boolean>>({});
  const [manualLoading, setManualLoading] = useState(false);

  /* fetch */
  const fetchData = useCallback(
    async (manual = false) => {
      if (manual) setManualLoading(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/sales-data?start=${fromDate}&end=${toDate}`);
        if (!res.ok) throw new Error("fetch failed");
        const json: SalesData = await res.json();
        setData(json);
      } catch (e) {
        console.error("Sales fetch error:", e);
      } finally {
        setLoading(false);
        setManualLoading(false);
      }
    },
    [fromDate, toDate]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* sort helper */
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortedAgents = (): [string, SalespersonStats][] => {
    if (!data) return [];
    const entries = Object.entries(data.bySalesperson);
    entries.sort((a, b) => {
      let va: number | string;
      let vb: number | string;
      if (sortKey === "name") {
        va = a[0].toLowerCase();
        vb = b[0].toLowerCase();
      } else if (sortKey === "deals") {
        va = a[1].totalDeals;
        vb = b[1].totalDeals;
      } else if (sortKey === "calls") {
        va = a[1].totalCalls;
        vb = b[1].totalCalls;
      } else if (sortKey === "closeRate") {
        va = a[1].closeRate;
        vb = b[1].closeRate;
      } else {
        va = a[1].queues[sortKey]?.deals ?? 0;
        vb = b[1].queues[sortKey]?.deals ?? 0;
      }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return entries;
  };

  const toggleTeam = (team: string) =>
    setExpandedTeams((prev) => ({ ...prev, [team]: !prev[team] }));

  /* ── metric card ──────────────────────────────────────────────────────────── */
  const MetricCard = ({
    label,
    value,
    subtitle,
    color,
  }: {
    label: string;
    value: string;
    subtitle?: string;
    color: string;
  }) => (
    <div
      style={{
        background: C.card,
        borderRadius: 12,
        padding: "20px 24px",
        borderLeft: `3px solid ${color}`,
        transition: "background 0.2s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.cardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = C.card)}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          color: C.secondary,
          marginBottom: 8,
          fontFamily: FONT,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 800,
          color,
          fontFamily: FONT,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {subtitle && (
        <div
          style={{
            fontSize: 12,
            color: C.muted,
            marginTop: 4,
            fontFamily: FONT,
          }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );

  /* ── section header ───────────────────────────────────────────────────────── */
  const SectionHeader = ({ title, color }: { title: string; color: string }) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 16,
        marginTop: 24,
      }}
    >
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: color,
        }}
      />
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "1px",
          color: C.text,
          fontFamily: FONT,
        }}
      >
        {title}
      </div>
    </div>
  );

  /* ── queue table ──────────────────────────────────────────────────────────── */
  const QueueTable = ({
    title,
    queues,
    color,
  }: {
    title: string;
    queues: string[];
    color: string;
  }) => (
    <div style={{ flex: 1, minWidth: 320 }}>
      <div
        style={{
          background: color,
          color: C.text,
          padding: "10px 16px",
          borderRadius: "8px 8px 0 0",
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "1px",
          fontFamily: FONT,
        }}
      >
        {title}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: FONT,
          }}
        >
          <thead>
            <tr>
              {["Queue", "Deals", "Calls", "Close Rate", "Unanswered"].map(
                (h, i) => (
                  <th
                    key={h}
                    style={{
                      background: C.card,
                      color: C.muted,
                      fontSize: 10,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      padding: "10px 14px",
                      textAlign: i === 0 ? "left" : "right",
                      borderBottom: `1px solid ${C.border}`,
                      whiteSpace: "nowrap",
                      fontWeight: 600,
                    }}
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => {
              const qs = data?.byQueue[q];
              return (
                <tr key={q}>
                  <td
                    style={{
                      padding: "10px 14px",
                      fontSize: 13,
                      fontWeight: 600,
                      color: C.text,
                      borderBottom: `1px solid ${C.border}`,
                      fontFamily: FONT,
                    }}
                  >
                    {q}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      fontSize: 13,
                      textAlign: "right",
                      color: C.text,
                      borderBottom: `1px solid ${C.border}`,
                      fontFamily: FONT,
                    }}
                  >
                    {fmt(qs?.deals ?? 0)}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      fontSize: 13,
                      textAlign: "right",
                      color: C.secondary,
                      borderBottom: `1px solid ${C.border}`,
                      fontFamily: FONT,
                    }}
                  >
                    {fmt(qs?.calls ?? 0)}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      fontSize: 13,
                      textAlign: "right",
                      color: C.success,
                      borderBottom: `1px solid ${C.border}`,
                      fontFamily: FONT,
                    }}
                  >
                    {pct(qs?.closeRate ?? 0)}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      fontSize: 13,
                      textAlign: "right",
                      color: C.warning,
                      borderBottom: `1px solid ${C.border}`,
                      fontFamily: FONT,
                    }}
                  >
                    {fmt(qs?.unanswered ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  /* ── sortable header cell ─────────────────────────────────────────────────── */
  const SortTh = ({
    label,
    sKey,
    left,
  }: {
    label: string;
    sKey: SortKey;
    left?: boolean;
  }) => (
    <th
      onClick={() => handleSort(sKey)}
      style={{
        background: C.card,
        color: sortKey === sKey ? C.purpleLight : C.muted,
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        padding: "10px 12px",
        textAlign: left ? "left" : "right",
        borderBottom: `1px solid ${C.border}`,
        whiteSpace: "nowrap",
        cursor: "pointer",
        userSelect: "none",
        fontWeight: 600,
        fontFamily: FONT,
        position: left ? "sticky" : undefined,
        left: left ? 0 : undefined,
        zIndex: left ? 3 : 2,
        minWidth: left ? 140 : undefined,
      }}
    >
      {label} {sortKey === sKey ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
    </th>
  );

  /* ── agent row ────────────────────────────────────────────────────────────── */
  const AgentRow = ({
    name,
    stats,
  }: {
    name: string;
    stats: SalespersonStats;
  }) => (
    <tr
      style={{ transition: "background 0.15s" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.cardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <td
        style={{
          padding: "10px 12px",
          fontSize: 13,
          fontWeight: 600,
          color: C.text,
          borderBottom: `1px solid ${C.border}`,
          fontFamily: FONT,
          position: "sticky",
          left: 0,
          background: C.bg,
          zIndex: 1,
          boxShadow: "2px 0 4px rgba(0,0,0,0.3)",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </td>
      <td
        style={{
          padding: "10px 12px",
          fontSize: 13,
          textAlign: "right",
          color: C.success,
          fontWeight: 700,
          borderBottom: `1px solid ${C.border}`,
          fontFamily: FONT,
        }}
      >
        {fmt(stats.totalDeals)}
      </td>
      <td
        style={{
          padding: "10px 12px",
          fontSize: 13,
          textAlign: "right",
          color: C.secondary,
          borderBottom: `1px solid ${C.border}`,
          fontFamily: FONT,
        }}
      >
        {fmt(stats.totalCalls)}
      </td>
      <td
        style={{
          padding: "10px 12px",
          fontSize: 13,
          textAlign: "right",
          color: C.success,
          borderBottom: `1px solid ${C.border}`,
          fontFamily: FONT,
        }}
      >
        {pct(stats.closeRate)}
      </td>
      {ALL_QUEUES.map((q) => (
        <td
          key={q}
          style={{
            padding: "10px 12px",
            fontSize: 13,
            textAlign: "right",
            color: (stats.queues[q]?.deals ?? 0) > 0 ? C.text : C.muted,
            borderBottom: `1px solid ${C.border}`,
            fontFamily: FONT,
          }}
        >
          {stats.queues[q]?.deals ?? 0}
        </td>
      ))}
    </tr>
  );

  /* ── performance table (all agents) ───────────────────────────────────────── */
  const AllAgentsTable = () => {
    const agents = sortedAgents();
    return (
      <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}` }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: FONT,
            minWidth: 900,
          }}
        >
          <thead>
            <tr>
              <SortTh label="Name" sKey="name" left />
              <SortTh label="Deals" sKey="deals" />
              <SortTh label="Calls" sKey="calls" />
              <SortTh label="%" sKey="closeRate" />
              {ALL_QUEUES.map((q) => (
                <SortTh key={q} label={q} sKey={q} />
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map(([name, stats]) => (
              <AgentRow key={name} name={name} stats={stats} />
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  /* ── performance table (by team) ──────────────────────────────────────────── */
  const ByTeamView = () => {
    if (!data) return null;
    const teamNames = Object.keys(data.teams);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {teamNames.map((team, idx) => {
          const color = TEAM_COLORS[idx % TEAM_COLORS.length];
          const expanded = expandedTeams[team] !== false;
          const members = data.teams[team] || [];
          return (
            <div
              key={team}
              style={{
                background: C.card,
                borderRadius: 12,
                borderLeft: `4px solid ${color}`,
                overflow: "hidden",
              }}
            >
              <div
                onClick={() => toggleTeam(team)}
                style={{
                  padding: "14px 20px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: C.text,
                    fontFamily: FONT,
                  }}
                >
                  {team}{" "}
                  <span style={{ color: C.muted, fontWeight: 400, fontSize: 12 }}>
                    ({members.length} agents)
                  </span>
                </div>
                <div
                  style={{
                    color: C.muted,
                    fontSize: 18,
                    transition: "transform 0.2s",
                    transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                  }}
                >
                  &#9660;
                </div>
              </div>
              {expanded && (
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontFamily: FONT,
                      minWidth: 900,
                    }}
                  >
                    <thead>
                      <tr>
                        <th
                          style={{
                            background: C.card,
                            color: C.muted,
                            fontSize: 10,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            padding: "10px 12px",
                            textAlign: "left",
                            borderBottom: `1px solid ${C.border}`,
                            fontWeight: 600,
                            fontFamily: FONT,
                            position: "sticky",
                            left: 0,
                            zIndex: 2,
                            minWidth: 140,
                          }}
                        >
                          Name
                        </th>
                        {["Deals", "Calls", "%", ...ALL_QUEUES].map((h) => (
                          <th
                            key={h}
                            style={{
                              background: C.card,
                              color: C.muted,
                              fontSize: 10,
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              padding: "10px 12px",
                              textAlign: "right",
                              borderBottom: `1px solid ${C.border}`,
                              fontWeight: 600,
                              fontFamily: FONT,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((name) => {
                        const stats = data.bySalesperson[name];
                        if (!stats) return null;
                        return <AgentRow key={name} name={name} stats={stats} />;
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  /* ── coming soon placeholder ──────────────────────────────────────────────── */
  const ComingSoon = ({ title, desc }: { title: string; desc: string }) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 300,
        background: C.card,
        borderRadius: 12,
        padding: 40,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 48,
          marginBottom: 16,
          opacity: 0.5,
        }}
      >
        &#128679;
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: C.text,
          marginBottom: 8,
          fontFamily: FONT,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 14,
          color: C.secondary,
          maxWidth: 400,
          fontFamily: FONT,
        }}
      >
        {desc}
      </div>
    </div>
  );

  /* ── loading spinner ──────────────────────────────────────────────────────── */
  const Spinner = () => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 400,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          border: `3px solid ${C.border}`,
          borderTopColor: C.purple,
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  /* ── render ───────────────────────────────────────────────────────────────── */
  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: C.text,
        fontFamily: FONT,
      }}
    >
      {/* ── HEADER ───────────────────────────────────────────────────────── */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          background: `linear-gradient(135deg, ${C.purpleDark} 0%, ${C.bg} 100%)`,
          borderBottom: `1px solid ${C.border}`,
          padding: "16px 24px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
            maxWidth: 1400,
            margin: "0 auto",
          }}
        >
          {/* logo */}
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 800,
                color: C.text,
                fontFamily: FONT,
                lineHeight: 1.2,
              }}
            >
              Guardian Protection Group
            </div>
            <div
              style={{
                fontSize: 12,
                color: C.secondary,
                fontFamily: FONT,
              }}
            >
              Sales Dashboard
            </div>
          </div>

          {/* controls */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            {/* date from */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label
                style={{
                  fontSize: 11,
                  color: C.secondary,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  fontFamily: FONT,
                }}
              >
                From
              </label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                style={{
                  background: C.input,
                  color: C.text,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 13,
                  fontFamily: FONT,
                  outline: "none",
                }}
              />
            </div>

            {/* date to */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label
                style={{
                  fontSize: 11,
                  color: C.secondary,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  fontFamily: FONT,
                }}
              >
                To
              </label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                style={{
                  background: C.input,
                  color: C.text,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 13,
                  fontFamily: FONT,
                  outline: "none",
                }}
              />
            </div>

            {/* update button */}
            <button
              onClick={() => fetchData(true)}
              disabled={manualLoading}
              style={{
                background: `linear-gradient(135deg, ${C.orange}, ${C.orangeLight})`,
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "8px 20px",
                fontSize: 13,
                fontWeight: 700,
                fontFamily: FONT,
                cursor: manualLoading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                opacity: manualLoading ? 0.7 : 1,
                transition: "opacity 0.2s",
              }}
            >
              {manualLoading && (
                <div
                  style={{
                    width: 14,
                    height: 14,
                    border: "2px solid rgba(255,255,255,0.3)",
                    borderTopColor: "#fff",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
              )}
              UPDATE
            </button>
          </div>
        </div>
      </div>

      {/* ── TAB BAR ──────────────────────────────────────────────────────── */}
      <div
        style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: "16px 24px 0",
        }}
      >
        <div
          style={{
            display: "flex",
            background: C.card,
            borderRadius: 12,
            padding: 4,
            gap: 4,
          }}
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1,
                padding: "10px 16px",
                border: "none",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: FONT,
                cursor: "pointer",
                transition: "all 0.2s",
                color: activeTab === tab.id ? C.text : C.secondary,
                background:
                  activeTab === tab.id
                    ? `linear-gradient(135deg, ${C.purple}, ${C.purpleDark})`
                    : "transparent",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── CONTENT ──────────────────────────────────────────────────────── */}
      <div
        style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: "24px 24px 48px",
        }}
      >
        {loading && !data ? (
          <Spinner />
        ) : (
          <>
            {/* ── OVERVIEW TAB ────────────────────────────────────────────── */}
            {activeTab === "overview" && data && (
              <div>
                {/* Company Total */}
                <SectionHeader title="Company Total" color={C.greenLight} />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 16,
                  }}
                >
                  <MetricCard
                    label="Close Rate (Sold)"
                    value={pct(data.companyTotal.closeRate)}
                    subtitle="Company-wide"
                    color={C.greenLight}
                  />
                  <MetricCard
                    label="Deals (Sold)"
                    value={fmt(data.companyTotal.deals)}
                    subtitle="Total closed"
                    color={C.greenLight}
                  />
                  <MetricCard
                    label="Total Calls"
                    value={fmt(data.companyTotal.calls)}
                    subtitle="All queues"
                    color={C.greenLight}
                  />
                </div>

                {/* Auto Total */}
                <SectionHeader title="Auto" color={C.orange} />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 16,
                  }}
                >
                  <MetricCard
                    label="Close Rate (Sold)"
                    value={pct(data.autoTotal.closeRate)}
                    subtitle="Auto division"
                    color={C.orange}
                  />
                  <MetricCard
                    label="Deals (Sold)"
                    value={fmt(data.autoTotal.deals)}
                    subtitle="Auto closed"
                    color={C.orange}
                  />
                  <MetricCard
                    label="Total Calls"
                    value={fmt(data.autoTotal.calls)}
                    subtitle="Auto queues"
                    color={C.orange}
                  />
                </div>

                {/* Home Total */}
                <SectionHeader title="Home" color={C.purpleLight} />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 16,
                  }}
                >
                  <MetricCard
                    label="Close Rate (Sold)"
                    value={pct(data.homeTotal.closeRate)}
                    subtitle="Home division"
                    color={C.purpleLight}
                  />
                  <MetricCard
                    label="Deals (Sold)"
                    value={fmt(data.homeTotal.deals)}
                    subtitle="Home closed"
                    color={C.purpleLight}
                  />
                  <MetricCard
                    label="Total Calls"
                    value={fmt(data.homeTotal.calls)}
                    subtitle="Home queues"
                    color={C.purpleLight}
                  />
                </div>

                {/* Queue Breakdown Tables */}
                <div
                  style={{
                    display: "flex",
                    gap: 24,
                    marginTop: 32,
                    flexWrap: "wrap",
                  }}
                >
                  <QueueTable
                    title="Auto Queue Breakdown"
                    queues={AUTO_QUEUES}
                    color={C.orange}
                  />
                  <QueueTable
                    title="Home Queue Breakdown"
                    queues={HOME_QUEUES}
                    color={C.purple}
                  />
                </div>
              </div>
            )}

            {/* ── PERFORMANCE TAB ─────────────────────────────────────────── */}
            {activeTab === "performance" && data && (
              <div>
                {/* Toggle */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginBottom: 20,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: !byTeamMode ? C.text : C.muted,
                      fontFamily: FONT,
                    }}
                  >
                    All Agents
                  </span>
                  <div
                    onClick={() => setByTeamMode((v) => !v)}
                    style={{
                      width: 48,
                      height: 24,
                      borderRadius: 12,
                      background: byTeamMode
                        ? `linear-gradient(135deg, ${C.purple}, ${C.purpleDark})`
                        : C.border,
                      cursor: "pointer",
                      position: "relative",
                      transition: "background 0.2s",
                    }}
                  >
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: "#fff",
                        position: "absolute",
                        top: 3,
                        left: byTeamMode ? 27 : 3,
                        transition: "left 0.2s",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                      }}
                    />
                  </div>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: byTeamMode ? C.text : C.muted,
                      fontFamily: FONT,
                    }}
                  >
                    By Team
                  </span>
                </div>

                {byTeamMode ? <ByTeamView /> : <AllAgentsTable />}
              </div>
            )}

            {/* ── AVAILABILITY TAB ────────────────────────────────────────── */}
            {activeTab === "availability" && (
              <ComingSoon
                title="Coming Soon"
                desc="Real-time queue monitoring and agent availability tracking will be available here."
              />
            )}

            {/* ── TRENDS TAB ─────────────────────────────────────────────── */}
            {activeTab === "trends" && (
              <ComingSoon
                title="Coming Soon"
                desc="Daily and weekly trend charts powered by Chart.js will be added here."
              />
            )}

            {/* ── TEXT MIKE TAB ───────────────────────────────────────────── */}
            {activeTab === "textmike" && (
              <ComingSoon
                title="Coming Soon"
                desc="SMS functionality for quick alerts and notifications will be added here."
              />
            )}
          </>
        )}
      </div>

      {/* ── responsive media query ───────────────────────────────────────── */}
      <style>{`
        @media (max-width: 768px) {
          [style*="grid-template-columns: repeat(3"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}