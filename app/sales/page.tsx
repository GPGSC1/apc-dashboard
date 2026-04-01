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
  aiFwd?: number;
  dropped?: number;
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
interface FBStats {
  deals: number;
  bundles: number;
  inAuto: number;
  inHome: number;
  label: string;
}
interface FBDetail {
  autoFlip: number;
  autoBundle: number;
  homeFlip: number;
  homeBundle: number;
  total: number;
}
interface TODeal {
  contractNo: string;
  customerId: string;
  firstName: string;
  lastName: string;
  soldDate: string;
  phone: string;
  originalOwner: string;
  suggestedAgent: string | null;
}
interface SalesData {
  companyTotal: TotalStats;
  autoTotal: TotalStats;
  homeTotal: TotalStats;
  fbTotal?: FBStats;
  csDeals?: { total: number; auto: number; home: number };
  aiDeals?: { total: number; auto: number; home: number };
  spDeals?: { total: number; auto: number; home: number };
  fb?: FBDetail;
  byQueue: Record<string, QueueStats>;
  bySalesperson: Record<string, SalespersonStats>;
  teams: Record<string, string[]>;
  dailyTrends: DailyTrend[];
  staleness: { moxy: string | null; moxyHome?: string | null; cx: string | null };
  dateRange: { from: string; to: string };
  toDeals?: TODeal[];
  toCloserStats?: Record<string, { deals: number }>;
  toCalls?: { total: number; byAgent: Record<string, number> };
  spanishCalls?: { total: number; byAgent: Record<string, number>; _debug?: unknown };
}

type TabId = "overview" | "performance" | "availability" | "trends" | "textowners";
type SortKey = "name" | "deals" | "calls" | "closeRate" | string;

interface TeamMember { name: string }
interface TeamInfo { id: number; name: string; color: string; members: TeamMember[] }
interface TeamsPayload { teams: TeamInfo[]; unassigned: TeamMember[] }

/* ── tab definitions ────────────────────────────────────────────────────────── */
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "\u{1F4CA} Overview" },
  { id: "performance", label: "\u{1F3C6} Performance" },
  { id: "availability", label: "\u23F0 Availability" },
  { id: "trends", label: "\u{1F4C8} Trends" },
  { id: "textowners", label: "\u{1F4F1} Text Owners" },
];

/* ── component ──────────────────────────────────────────────────────────────── */
export default function SalesDashboard() {
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [data, setData] = useState<SalesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState(todayStr);
  const [toDate, setToDate] = useState(todayStr);
  const [soldOnly, setSoldOnly] = useState(true);
  const [byTeamMode, setByTeamMode] = useState(false);
  const [productView, setProductView] = useState<"combined" | "auto" | "home">("combined");
  const [sortKey, setSortKey] = useState<SortKey>("deals");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedTeams, setExpandedTeams] = useState<Record<string, boolean>>({});
  const [manualLoading, setManualLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showTeamManager, setShowTeamManager] = useState(false);
  const [teamsData, setTeamsData] = useState<TeamsPayload | null>(null);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  /* T.O. deal override popup state */
  const [toOverrideAgent, setToOverrideAgent] = useState<string | null>(null);
  const [toOverrides, setToOverrides] = useState<Record<string, string>>({});
  const [toSaving, setToSaving] = useState(false);

  /* availability tab state */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [availData, setAvailData] = useState<any>(null);
  const [availLoading, setAvailLoading] = useState(false);
  const [availSortKey, setAvailSortKey] = useState<string>("availableTime");
  const [availSortDir, setAvailSortDir] = useState<"asc" | "desc">("desc");

  /* team management API */
  const fetchTeams = useCallback(async () => {
    setTeamsLoading(true);
    try {
      const res = await fetch("/api/teams");
      if (!res.ok) throw new Error("fetch teams failed");
      const json: TeamsPayload = await res.json();
      setTeamsData(json);
    } catch (e) {
      console.error("Teams fetch error:", e);
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  const teamAction = async (body: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("team action failed");
      await fetchTeams();
    } catch (e) {
      console.error("Team action error:", e);
    }
  };

  useEffect(() => {
    if (showTeamManager) fetchTeams();
  }, [showTeamManager, fetchTeams]);

  /* fetch */
  const fetchData = useCallback(
    async (manual = false) => {
      if (manual) setManualLoading(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/sales-data?start=${fromDate}&end=${toDate}&soldOnly=${soldOnly}`);
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
    [fromDate, toDate, soldOnly]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* availability fetch */
  useEffect(() => {
    if (activeTab !== "availability") return;
    let cancelled = false;
    (async () => {
      setAvailLoading(true);
      try {
        const res = await fetch(`/api/availability?start=${fromDate}&end=${toDate}`);
        if (!res.ok) throw new Error("availability fetch failed");
        const json = await res.json();
        if (!cancelled) setAvailData(json);
      } catch (e) {
        console.error("Availability fetch error:", e);
      } finally {
        if (!cancelled) setAvailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, fromDate, toDate]);

  /* sort helper */
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Helper: compute filtered totals for an agent based on product view
  const getFilteredTotals = (stats: SalespersonStats) => {
    if (productView === "combined") return { deals: stats.totalDeals, calls: stats.totalCalls, rate: stats.closeRate };
    const queues = productView === "auto" ? AUTO_QUEUES : HOME_QUEUES;
    const deals = queues.reduce((s, q) => s + (stats.queues[q]?.deals ?? 0), 0);
    const calls = queues.reduce((s, q) => s + (stats.queues[q]?.calls ?? 0), 0);
    return { deals, calls, rate: calls > 0 ? deals / calls : 0 };
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
        va = getFilteredTotals(a[1]).deals;
        vb = getFilteredTotals(b[1]).deals;
      } else if (sortKey === "calls") {
        va = getFilteredTotals(a[1]).calls;
        vb = getFilteredTotals(b[1]).calls;
      } else if (sortKey === "closeRate") {
        va = getFilteredTotals(a[1]).rate;
        vb = getFilteredTotals(b[1]).rate;
      } else if (sortKey.includes("_")) {
        // Queue sub-column sort: "A1_deals", "A1_calls", "A1_closeRate"
        const [q, field] = sortKey.split("_");
        const aq = a[1].queues[q];
        const bq = b[1].queues[q];
        if (field === "deals") { va = aq?.deals ?? 0; vb = bq?.deals ?? 0; }
        else if (field === "calls") { va = aq?.calls ?? 0; vb = bq?.calls ?? 0; }
        else if (field === "closeRate") {
          const ac = aq?.calls ?? 0; const bc = bq?.calls ?? 0;
          va = ac > 0 ? (aq?.deals ?? 0) / ac : 0;
          vb = bc > 0 ? (bq?.deals ?? 0) / bc : 0;
        } else { va = aq?.deals ?? 0; vb = bq?.deals ?? 0; }
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
        textAlign: "center",
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
    fbCount,
  }: {
    title: string;
    queues: string[];
    color: string;
    fbCount?: number;
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
              {["Queue", "Deals", "Calls", "Close Rate", "AI-FWD", "Dropped"].map(
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
                      color: C.purpleLight,
                      borderBottom: `1px solid ${C.border}`,
                      fontFamily: FONT,
                    }}
                  >
                    {fmt(qs?.aiFwd ?? 0)}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      fontSize: 13,
                      textAlign: "right",
                      color: C.danger,
                      borderBottom: `1px solid ${C.border}`,
                      fontFamily: FONT,
                    }}
                  >
                    {fmt(qs?.dropped ?? 0)}
                  </td>
                </tr>
              );
            })}
            {(fbCount ?? 0) > 0 && (
              <tr>
                <td style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, color: C.warning, borderBottom: `1px solid ${C.border}`, fontFamily: FONT }}>F/B</td>
                <td style={{ padding: "10px 14px", fontSize: 13, textAlign: "right", color: C.warning, fontWeight: 700, borderBottom: `1px solid ${C.border}`, fontFamily: FONT }}>{fmt(fbCount ?? 0)}</td>
                <td style={{ padding: "10px 14px", fontSize: 13, textAlign: "right", color: C.muted, borderBottom: `1px solid ${C.border}`, fontFamily: FONT }}>{"\u2014"}</td>
                <td style={{ padding: "10px 14px", fontSize: 13, textAlign: "right", color: C.muted, borderBottom: `1px solid ${C.border}`, fontFamily: FONT }}>{"\u2014"}</td>
                <td style={{ padding: "10px 14px", fontSize: 13, textAlign: "right", color: C.muted, borderBottom: `1px solid ${C.border}`, fontFamily: FONT }}>{"\u2014"}</td>
                <td style={{ padding: "10px 14px", fontSize: 13, textAlign: "right", color: C.muted, borderBottom: `1px solid ${C.border}`, fontFamily: FONT }}>{"\u2014"}</td>
              </tr>
            )}
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
    view,
    onDealsClick,
  }: {
    name: string;
    stats: SalespersonStats;
    view: "combined" | "auto" | "home";
    onDealsClick?: () => void;
  }) => {
    const queuesForView = view === "auto" ? AUTO_QUEUES : view === "home" ? HOME_QUEUES : [];
    // When a product is selected, filter totals to only that product's queues
    const filteredDeals = view === "combined" ? stats.totalDeals
      : queuesForView.reduce((sum, q) => sum + (stats.queues[q]?.deals ?? 0), 0);
    const filteredCalls = view === "combined" ? stats.totalCalls
      : queuesForView.reduce((sum, q) => sum + (stats.queues[q]?.calls ?? 0), 0);
    const filteredRate = filteredCalls > 0 ? filteredDeals / filteredCalls : 0;
    const cellBase = {
      padding: "10px 12px",
      fontSize: 13,
      textAlign: "right" as const,
      borderBottom: `1px solid ${C.border}`,
      fontFamily: FONT,
    };
    return (
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
          onClick={onDealsClick && filteredDeals > 0 ? (e) => { e.stopPropagation(); onDealsClick(); } : undefined}
          style={{
            ...cellBase,
            color: C.success,
            fontWeight: 700,
            cursor: onDealsClick && filteredDeals > 0 ? "pointer" : undefined,
            textDecoration: onDealsClick && filteredDeals > 0 ? "underline" : undefined,
            textDecorationColor: onDealsClick && filteredDeals > 0 ? C.purpleLight : undefined,
          }}
        >
          {fmt(filteredDeals)}
        </td>
        <td style={{ ...cellBase, color: C.secondary }}>
          {fmt(filteredCalls)}
        </td>
        <td style={{ ...cellBase, color: C.success }}>
          {pct(filteredRate)}
        </td>
        {view === "combined" ? null : queuesForView.map((q, qi) => {
          const qd = stats.queues[q]?.deals ?? 0;
          const qc = stats.queues[q]?.calls ?? 0;
          const qr = qc > 0 ? qd / qc : 0;
          return [
            <td key={`${q}_d`} style={{ ...cellBase, color: qd > 0 ? C.text : C.muted, borderLeft: `2px solid ${C.border}` }}>
              {qd}
            </td>,
            <td key={`${q}_c`} style={{ ...cellBase, color: qc > 0 ? C.secondary : C.muted }}>
              {qc}
            </td>,
            <td key={`${q}_r`} style={{ ...cellBase, color: C.success }}>
              {pct(qr)}
            </td>,
          ];
        })}
      </tr>
    );
  };

  /* ── performance table (all agents) ───────────────────────────────────────── */
  const AllAgentsTable = () => {
    const agents = sortedAgents();
    const queuesForView = productView === "auto" ? AUTO_QUEUES : productView === "home" ? HOME_QUEUES : [];
    const showQueues = productView !== "combined";
    return (
      <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}` }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: FONT,
            minWidth: showQueues ? 900 : 500,
          }}
        >
          <thead>
            {showQueues && (
              <tr>
                <th style={{ background: C.card, borderBottom: `1px solid ${C.border}`, position: "sticky", left: 0, zIndex: 3 }} />
                <th style={{ background: C.card, borderBottom: `1px solid ${C.border}` }} />
                <th style={{ background: C.card, borderBottom: `1px solid ${C.border}` }} />
                <th style={{ background: C.card, borderBottom: `1px solid ${C.border}` }} />
                {queuesForView.map((q) => (
                  <th
                    key={q}
                    colSpan={3}
                    style={{
                      background: C.card,
                      color: C.text,
                      fontSize: 11,
                      fontWeight: 700,
                      textAlign: "center",
                      padding: "8px 4px",
                      borderBottom: `1px solid ${C.border}`,
                      borderLeft: `2px solid ${C.border}`,
                      fontFamily: FONT,
                      letterSpacing: "0.5px",
                    }}
                  >
                    {q}
                  </th>
                ))}
              </tr>
            )}
            <tr>
              <SortTh label="Name" sKey="name" left />
              <SortTh label="Deals" sKey="deals" />
              <SortTh label="Calls" sKey="calls" />
              <SortTh label="Close %" sKey="closeRate" />
              {showQueues && queuesForView.map((q) => (
                [
                  <th
                    key={`${q}_d`}
                    onClick={() => handleSort(`${q}_deals`)}
                    style={{
                      background: C.card,
                      color: sortKey === `${q}_deals` ? C.purpleLight : C.muted,
                      fontSize: 9,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      padding: "6px 8px",
                      textAlign: "right",
                      borderBottom: `1px solid ${C.border}`,
                      borderLeft: `2px solid ${C.border}`,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      userSelect: "none",
                      fontWeight: 600,
                      fontFamily: FONT,
                    }}
                  >
                    D {sortKey === `${q}_deals` ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                  </th>,
                  <th
                    key={`${q}_c`}
                    onClick={() => handleSort(`${q}_calls`)}
                    style={{
                      background: C.card,
                      color: sortKey === `${q}_calls` ? C.purpleLight : C.muted,
                      fontSize: 9,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      padding: "6px 8px",
                      textAlign: "right",
                      borderBottom: `1px solid ${C.border}`,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      userSelect: "none",
                      fontWeight: 600,
                      fontFamily: FONT,
                    }}
                  >
                    C {sortKey === `${q}_calls` ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                  </th>,
                  <th
                    key={`${q}_r`}
                    onClick={() => handleSort(`${q}_closeRate`)}
                    style={{
                      background: C.card,
                      color: sortKey === `${q}_closeRate` ? C.purpleLight : C.muted,
                      fontSize: 9,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      padding: "6px 8px",
                      textAlign: "right",
                      borderBottom: `1px solid ${C.border}`,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      userSelect: "none",
                      fontWeight: 600,
                      fontFamily: FONT,
                    }}
                  >
                    % {sortKey === `${q}_closeRate` ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                  </th>,
                ]
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map(([name, stats]) => (
              <AgentRow key={name} name={name} stats={stats} view={productView} />
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  /* ── team totals helper ───────────────────────────────────────────────────── */
  const computeTeamTotals = (members: string[]) => {
    if (!data) return { deals: 0, calls: 0, rate: 0, queues: {} as Record<string, { deals: number; calls: number }> };
    const queues: Record<string, { deals: number; calls: number }> = {};
    let deals = 0, calls = 0;
    const qList = productView === "auto" ? AUTO_QUEUES : productView === "home" ? HOME_QUEUES : ALL_QUEUES;
    for (const name of members) {
      const s = data.bySalesperson[name];
      if (!s) continue;
      const ft = getFilteredTotals(s);
      deals += ft.deals;
      calls += ft.calls;
      for (const q of qList) {
        if (!queues[q]) queues[q] = { deals: 0, calls: 0 };
        queues[q].deals += s.queues[q]?.deals ?? 0;
        queues[q].calls += s.queues[q]?.calls ?? 0;
      }
    }
    return { deals, calls, rate: calls > 0 ? deals / calls : 0, queues };
  };

  /* ── performance table (by team) ──────────────────────────────────────────── */
  const ByTeamView = () => {
    if (!data) return null;
    const queuesForView = productView === "auto" ? AUTO_QUEUES : productView === "home" ? HOME_QUEUES : [];
    const showQueues = productView !== "combined";
    const thBase = {
      background: C.card,
      color: C.muted,
      fontSize: 10,
      letterSpacing: "0.1em" as const,
      textTransform: "uppercase" as const,
      padding: "10px 12px",
      textAlign: "right" as const,
      borderBottom: `1px solid ${C.border}`,
      fontWeight: 600,
      fontFamily: FONT,
      whiteSpace: "nowrap" as const,
    };

    // Order: preferred order first, then any other teams
    const teamOrder = ["The Money Team", "Nothin But a G Thang", "T.O."];
    const allTeamNames = Object.keys(data.teams);
    const orderedTeams = [
      ...teamOrder.filter(t => data.teams[t]),
      ...allTeamNames.filter(t => !teamOrder.includes(t)),
    ];

    // Collect assigned agents from ALL teams
    const assignedAgents = new Set<string>();
    for (const team of orderedTeams) {
      for (const name of (data.teams[team] || [])) assignedAgents.add(name);
    }

    // Unassigned: agents in bySalesperson but not in any team
    const unassigned = Object.keys(data.bySalesperson).filter(n => !assignedAgents.has(n) && n.trim());

    const TeamBlock = ({ team, members, color, isUnassigned }: { team: string; members: string[]; color: string; isUnassigned?: boolean }) => {
      const expanded = expandedTeams[team] === true;
      const isToTeam = team.toLowerCase() === "t.o." || team.toLowerCase() === "to.";
      const isSpanishTeam = team.toLowerCase() === "spanish";
      const isTransferTeam = isToTeam || isSpanishTeam;
      const baseTotals = computeTeamTotals(members);
      // For T.O. and Spanish teams, use transfer-based call counts
      const transferCallSource = isToTeam ? data.toCalls?.byAgent : isSpanishTeam ? data.spanishCalls?.byAgent : null;
      const transferDeals = isToTeam
        ? members.reduce((sum, name) => sum + (data.toCloserStats?.[name]?.deals ?? 0), 0)
        : baseTotals.deals;
      const transferCalls = isTransferTeam && transferCallSource
        ? members.reduce((sum, name) => sum + (transferCallSource[name] ?? 0), 0)
        : baseTotals.calls;
      const totals = isTransferTeam
        ? { ...baseTotals, deals: transferDeals, calls: transferCalls, rate: transferCalls > 0 ? transferDeals / transferCalls : 0 }
        : baseTotals;
      const cellBase = { padding: "10px 12px", fontSize: 13, textAlign: "right" as const, fontFamily: FONT, borderBottom: `1px solid ${C.border}` };
      const toDeals = data.toDeals ?? [];

      return (
        <div
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
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: FONT, display: "flex", alignItems: "center" }}>
              {team}{" "}
              <span style={{ color: C.muted, fontWeight: 400, fontSize: 12 }}>
                ({members.length} agents)
              </span>
              {isToTeam && toDeals.length > 0 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    setToOverrideAgent("__all__");
                    const prefilled: Record<string, string> = {};
                    for (const d of toDeals) {
                      if (d.suggestedAgent) prefilled[d.contractNo] = d.suggestedAgent;
                    }
                    setToOverrides(prefilled);
                  }}
                  style={{
                    background: C.danger,
                    color: '#fff',
                    padding: '2px 10px',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    marginLeft: 8,
                  }}
                >
                  {toDeals.length} error{toDeals.length !== 1 ? 's' : ''}
                </span>
              )}
              <span style={{ color: C.success, fontWeight: 700, fontSize: 13, marginLeft: 20 }}>
                {totals.deals} {isTransferTeam ? "closed" : "deals"}
              </span>
              <span style={{ color: C.secondary, fontSize: 13, marginLeft: 12 }}>
                {fmt(totals.calls)} calls
              </span>
              <span style={{ color: C.success, fontSize: 13, marginLeft: 12 }}>
                {pct(totals.rate)}
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
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT, minWidth: showQueues ? 900 : 500 }}>
                <thead>
                  {showQueues && (
                    <tr>
                      <th style={{ background: C.card, borderBottom: `1px solid ${C.border}`, position: "sticky", left: 0, zIndex: 3, minWidth: 140 }} />
                      <th style={{ background: C.card, borderBottom: `1px solid ${C.border}` }} />
                      <th style={{ background: C.card, borderBottom: `1px solid ${C.border}` }} />
                      <th style={{ background: C.card, borderBottom: `1px solid ${C.border}` }} />
                      {queuesForView.map((q) => (
                        <th key={q} colSpan={3} style={{
                          background: C.card, color: C.text, fontSize: 11, fontWeight: 700,
                          textAlign: "center", padding: "8px 4px", borderBottom: `1px solid ${C.border}`,
                          borderLeft: `2px solid ${C.border}`, fontFamily: FONT, letterSpacing: "0.5px",
                        }}>
                          {q}
                        </th>
                      ))}
                    </tr>
                  )}
                  {/* Team totals row */}
                  <tr style={{ background: `${color}22` }}>
                    <td style={{ ...cellBase, textAlign: "left", fontWeight: 700, color, position: "sticky", left: 0, zIndex: 2, background: `${color}22` }}>
                      TEAM TOTAL
                    </td>
                    <td style={{ ...cellBase, color: C.success, fontWeight: 700 }}>{totals.deals}</td>
                    <td style={{ ...cellBase, color: C.secondary, fontWeight: 700 }}>{fmt(totals.calls)}</td>
                    <td style={{ ...cellBase, color: C.success, fontWeight: 700 }}>{pct(totals.rate)}</td>
                    {showQueues && queuesForView.map((q) => {
                      const qd = totals.queues[q]?.deals ?? 0;
                      const qc = totals.queues[q]?.calls ?? 0;
                      const qr = qc > 0 ? qd / qc : 0;
                      return [
                        <td key={`t${q}_d`} style={{ ...cellBase, color: qd > 0 ? C.text : C.muted, fontWeight: 700, borderLeft: `2px solid ${C.border}` }}>{qd}</td>,
                        <td key={`t${q}_c`} style={{ ...cellBase, color: qc > 0 ? C.secondary : C.muted, fontWeight: 700 }}>{qc}</td>,
                        <td key={`t${q}_r`} style={{ ...cellBase, color: C.success, fontWeight: 700 }}>{pct(qr)}</td>,
                      ];
                    })}
                  </tr>
                  {/* Column headers */}
                  <tr>
                    <th onClick={() => handleSort("name")} style={{ ...thBase, textAlign: "left", position: "sticky", left: 0, zIndex: 2, minWidth: 140, cursor: "pointer", userSelect: "none", color: sortKey === "name" ? C.purpleLight : C.muted }}>
                      Name {sortKey === "name" ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                    </th>
                    <th onClick={() => handleSort("deals")} style={{ ...thBase, cursor: "pointer", userSelect: "none", color: sortKey === "deals" ? C.purpleLight : C.muted }}>
                      {isTransferTeam ? "Closed" : "Deals"} {sortKey === "deals" ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                    </th>
                    <th onClick={() => handleSort("calls")} style={{ ...thBase, cursor: "pointer", userSelect: "none", color: sortKey === "calls" ? C.purpleLight : C.muted }}>
                      Calls {sortKey === "calls" ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                    </th>
                    <th onClick={() => handleSort("closeRate")} style={{ ...thBase, cursor: "pointer", userSelect: "none", color: sortKey === "closeRate" ? C.purpleLight : C.muted }}>
                      Close % {sortKey === "closeRate" ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                    </th>
                    {showQueues && queuesForView.map((q) => ([
                      <th key={`${q}_d`} onClick={() => handleSort(`${q}_deals`)} style={{ ...thBase, fontSize: 9, padding: "6px 8px", borderLeft: `2px solid ${C.border}`, cursor: "pointer", userSelect: "none", color: sortKey === `${q}_deals` ? C.purpleLight : C.muted }}>
                        D {sortKey === `${q}_deals` ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                      </th>,
                      <th key={`${q}_c`} onClick={() => handleSort(`${q}_calls`)} style={{ ...thBase, fontSize: 9, padding: "6px 8px", cursor: "pointer", userSelect: "none", color: sortKey === `${q}_calls` ? C.purpleLight : C.muted }}>
                        C {sortKey === `${q}_calls` ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                      </th>,
                      <th key={`${q}_r`} onClick={() => handleSort(`${q}_closeRate`)} style={{ ...thBase, fontSize: 9, padding: "6px 8px", cursor: "pointer", userSelect: "none", color: sortKey === `${q}_closeRate` ? C.purpleLight : C.muted }}>
                        % {sortKey === `${q}_closeRate` ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                      </th>,
                    ]))}
                  </tr>
                </thead>
                <tbody>
                  {[...members].sort((a, b) => {
                    const rawSa = data.bySalesperson[a] ?? { totalDeals: 0, totalCalls: 0, closeRate: 0, queues: {} };
                    const rawSb = data.bySalesperson[b] ?? { totalDeals: 0, totalCalls: 0, closeRate: 0, queues: {} };
                    const sa = isTransferTeam ? (() => {
                      const d = isToTeam ? (data.toCloserStats?.[a]?.deals ?? rawSa.totalDeals) : rawSa.totalDeals;
                      const c = transferCallSource?.[a] ?? rawSa.totalCalls;
                      return { ...rawSa, totalDeals: d, totalCalls: c, closeRate: c > 0 ? d / c : 0 };
                    })() : rawSa;
                    const sb = isTransferTeam ? (() => {
                      const d = isToTeam ? (data.toCloserStats?.[b]?.deals ?? rawSb.totalDeals) : rawSb.totalDeals;
                      const c = transferCallSource?.[b] ?? rawSb.totalCalls;
                      return { ...rawSb, totalDeals: d, totalCalls: c, closeRate: c > 0 ? d / c : 0 };
                    })() : rawSb;
                    let va: number | string;
                    let vb: number | string;
                    if (sortKey === "name") {
                      va = a.toLowerCase(); vb = b.toLowerCase();
                    } else if (sortKey === "deals") {
                      va = getFilteredTotals(sa).deals; vb = getFilteredTotals(sb).deals;
                    } else if (sortKey === "calls") {
                      va = getFilteredTotals(sa).calls; vb = getFilteredTotals(sb).calls;
                    } else if (sortKey === "closeRate") {
                      va = getFilteredTotals(sa).rate; vb = getFilteredTotals(sb).rate;
                    } else if (sortKey.includes("_")) {
                      const [q, field] = sortKey.split("_");
                      const aq = sa.queues[q]; const bq = sb.queues[q];
                      if (field === "deals") { va = aq?.deals ?? 0; vb = bq?.deals ?? 0; }
                      else if (field === "calls") { va = aq?.calls ?? 0; vb = bq?.calls ?? 0; }
                      else if (field === "closeRate") {
                        const ac = aq?.calls ?? 0; const bc = bq?.calls ?? 0;
                        va = ac > 0 ? (aq?.deals ?? 0) / ac : 0;
                        vb = bc > 0 ? (bq?.deals ?? 0) / bc : 0;
                      } else { va = aq?.deals ?? 0; vb = bq?.deals ?? 0; }
                    } else {
                      va = sa.queues[sortKey]?.deals ?? 0; vb = sb.queues[sortKey]?.deals ?? 0;
                    }
                    if (va < vb) return sortDir === "asc" ? -1 : 1;
                    if (va > vb) return sortDir === "asc" ? 1 : -1;
                    return 0;
                  }).map((name) => {
                    const stats = data.bySalesperson[name] ?? { totalDeals: 0, totalCalls: 0, closeRate: 0, queues: {} };
                    return (
                      <AgentRow
                        key={name}
                        name={name}
                        stats={isTransferTeam ? {
                          ...stats,
                          totalDeals: isToTeam ? (data.toCloserStats?.[name]?.deals ?? stats.totalDeals) : stats.totalDeals,
                          totalCalls: transferCallSource?.[name] ?? stats.totalCalls,
                        } : stats}
                        view={productView}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {orderedTeams.map((team, idx) => (
          <TeamBlock
            key={team}
            team={team}
            members={data.teams[team] || []}
            color={TEAM_COLORS[idx % TEAM_COLORS.length]}
          />
        ))}
        <TeamBlock
          team="Unassigned"
          members={unassigned}
          color={C.muted}
          isUnassigned
        />
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

  /* ── Text Owners tab ─────────────────────────────────────────────────────── */
  const TextOwnersTab = ({ data: d, fromDate: fd, toDate: td }: { data: SalesData; fromDate: string; toDate: string }) => {
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [phoneInput, setPhoneInput] = useState("314-703-1911");

    const PERF_QUEUES = ["A1", "A2", "A3", "A4", "A5", "A6", "H1", "H2", "H3", "H4", "H5"];
    const AVAIL_QUEUES = ["A1", "A2", "A3", "A4", "A5", "A6", "H1", "H2", "H3", "H4"];

    // Team name -> display label
    const teamLabels: Record<string, string> = {
      "The Money Team": "Jimmy",
      "Nothin But a G Thang": "Greg",
    };

    const buildMessage = () => {
      const dateLabel = fd === td
        ? new Date(fd + "T12:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" })
        : `${new Date(fd + "T12:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric" })} - ${new Date(td + "T12:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" })}`;

      let msg = `GPG Daily Report (${dateLabel})\n\n`;

      // Section 1: Performance by Queue
      msg += `Performance by Queue\n`;
      for (const q of PERF_QUEUES) {
        const qs = d.byQueue[q];
        const deals = qs?.deals ?? 0;
        const calls = qs?.calls ?? 0;
        const pct = calls > 0 ? ((deals / calls) * 100).toFixed(1) : "0.0";
        msg += `${q}: ${deals}D / ${calls}C / ${pct}%\n`;
      }

      msg += "\n";

      // Section 2: Availability by Queue
      msg += `Availability by Queue\n`;
      for (const q of AVAIL_QUEUES) {
        const qs = d.byQueue[q];
        const aiFwd = qs?.aiFwd ?? 0;
        const dropped = qs?.dropped ?? 0;
        msg += `${q}: ${aiFwd} AI Fwd / ${dropped} Dropped\n`;
      }

      msg += "\n";

      // Section 3: Company & Team Totals
      msg += `Company & Team Totals\n`;
      const ct = d.companyTotal;
      msg += `Company: ${ct.deals}D / ${ct.calls}C / ${(ct.closeRate * 100).toFixed(1)}%\n`;

      for (const [teamName, label] of Object.entries(teamLabels)) {
        const members = d.teams[teamName] ?? [];
        let tDeals = 0, tCalls = 0;
        for (const name of members) {
          const s = d.bySalesperson[name];
          if (!s) continue;
          tDeals += s.totalDeals;
          tCalls += s.totalCalls;
        }
        const pct = tCalls > 0 ? ((tDeals / tCalls) * 100).toFixed(1) : "0.0";
        msg += `${label}: ${tDeals}D / ${tCalls}C / ${pct}%\n`;
      }

      return msg.trim();
    };

    const message = buildMessage();

    const handleSend = async () => {
      setSending(true);
      setError(null);
      setSent(null);
      try {
        const res = await fetch("/api/text-owners", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: phoneInput, message }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error || "Send failed");
        } else {
          setSent("Sent!");
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setSending(false);
      }
    };

    const cellStyle = { padding: "8px 12px", fontFamily: FONT, fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}` };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Phone number input */}
        <div style={{ background: C.card, borderRadius: 12, padding: 20, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12, fontFamily: FONT }}>
            Send To
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <input
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="Phone number"
              style={{
                flex: 1, maxWidth: 240, padding: "8px 12px", borderRadius: 8,
                background: C.input, border: `1px solid ${C.border}`,
                color: C.text, fontFamily: FONT, fontSize: 14, outline: "none",
              }}
            />
            <button
              onClick={handleSend}
              disabled={sending || !phoneInput.trim()}
              style={{
                padding: "8px 20px", borderRadius: 8, border: "none",
                background: sending ? C.muted : C.purple, color: "#fff",
                fontFamily: FONT, fontSize: 14, fontWeight: 600, cursor: sending ? "wait" : "pointer",
                opacity: !phoneInput.trim() ? 0.4 : 1,
              }}
            >
              {sending ? "Sending..." : "Send Text"}
            </button>
          </div>
          {sent && <div style={{ marginTop: 8, color: C.success, fontSize: 12, fontFamily: FONT }}>{sent}</div>}
          {error && <div style={{ marginTop: 8, color: C.danger, fontSize: 12, fontFamily: FONT }}>{error}</div>}
        </div>

        {/* Message preview */}
        <div style={{ background: C.card, borderRadius: 12, padding: 20, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12, fontFamily: FONT }}>
            Message Preview
          </div>
          <pre style={{
            background: C.bg, borderRadius: 8, padding: 16,
            border: `1px solid ${C.border}`, color: C.secondary,
            fontFamily: "'Courier New', monospace", fontSize: 13, lineHeight: 1.6,
            whiteSpace: "pre-wrap", margin: 0, overflowX: "auto",
          }}>
            {message}
          </pre>
          <div style={{ marginTop: 8, color: C.muted, fontSize: 11, fontFamily: FONT }}>
            {message.length} characters
          </div>
        </div>

        {/* Section 1: Performance by Queue */}
        <div style={{ background: C.card, borderRadius: 12, padding: 20, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12, fontFamily: FONT }}>
            Performance by Queue
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Queue", "Deals", "Calls", "Closing %"].map((h) => (
                  <th key={h} style={{
                    ...cellStyle, fontSize: 10, color: C.muted, textTransform: "uppercase",
                    letterSpacing: "0.1em", fontWeight: 600, textAlign: h === "Queue" ? "left" : "right",
                    background: C.bg,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERF_QUEUES.map((q) => {
                const qs = d.byQueue[q];
                const deals = qs?.deals ?? 0;
                const calls = qs?.calls ?? 0;
                const pctVal = calls > 0 ? ((deals / calls) * 100).toFixed(1) : "0.0";
                return (
                  <tr key={q}>
                    <td style={{ ...cellStyle, fontWeight: 600 }}>{q}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{deals}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{calls}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{pctVal}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Section 2: Availability by Queue */}
        <div style={{ background: C.card, borderRadius: 12, padding: 20, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12, fontFamily: FONT }}>
            Availability by Queue
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Queue", "AI Forwarded", "Dropped"].map((h) => (
                  <th key={h} style={{
                    ...cellStyle, fontSize: 10, color: C.muted, textTransform: "uppercase",
                    letterSpacing: "0.1em", fontWeight: 600, textAlign: h === "Queue" ? "left" : "right",
                    background: C.bg,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AVAIL_QUEUES.map((q) => {
                const qs = d.byQueue[q];
                return (
                  <tr key={q}>
                    <td style={{ ...cellStyle, fontWeight: 600 }}>{q}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{qs?.aiFwd ?? 0}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{qs?.dropped ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Section 3: Company & Team Totals */}
        <div style={{ background: C.card, borderRadius: 12, padding: 20, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12, fontFamily: FONT }}>
            Company & Team Totals
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["", "Deals", "Calls", "Closing %"].map((h) => (
                  <th key={h} style={{
                    ...cellStyle, fontSize: 10, color: C.muted, textTransform: "uppercase",
                    letterSpacing: "0.1em", fontWeight: 600, textAlign: h === "" ? "left" : "right",
                    background: C.bg,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ ...cellStyle, fontWeight: 700 }}>Company</td>
                <td style={{ ...cellStyle, textAlign: "right" }}>{d.companyTotal.deals}</td>
                <td style={{ ...cellStyle, textAlign: "right" }}>{d.companyTotal.calls}</td>
                <td style={{ ...cellStyle, textAlign: "right" }}>{(d.companyTotal.closeRate * 100).toFixed(1)}%</td>
              </tr>
              {Object.entries(teamLabels).map(([teamName, label]) => {
                const members = d.teams[teamName] ?? [];
                let tDeals = 0, tCalls = 0;
                for (const name of members) {
                  const s = d.bySalesperson[name];
                  if (!s) continue;
                  tDeals += s.totalDeals;
                  tCalls += s.totalCalls;
                }
                const pctVal = tCalls > 0 ? ((tDeals / tCalls) * 100).toFixed(1) : "0.0";
                return (
                  <tr key={teamName}>
                    <td style={{ ...cellStyle, fontWeight: 600 }}>{label}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{tDeals}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{tCalls}</td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>{pctVal}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

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

  /* ── team management modal ────────────────────────────────────────────────── */
  const TeamManageModal = () => {
    if (!showTeamManager) return null;
    const MANAGE_COLORS = ["#6B2D99", "#F37021", "#EF4444", "#2D7A5F", "#F59E0B", "#3B82F6", "#EC4899", "#14B8A6"];
    return (
      <div
        onClick={() => { setShowTeamManager(false); setOpenDropdown(null); }}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            background: C.bg, borderRadius: 16, border: `1px solid ${C.border}`,
            width: "90%", maxWidth: 680, maxHeight: "85vh", overflow: "hidden",
            display: "flex", flexDirection: "column",
            boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          }}
        >
          {/* header */}
          <div style={{
            padding: "20px 24px", borderBottom: `1px solid ${C.border}`,
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: FONT }}>
              Manage Teams
            </div>
            <div
              onClick={() => { setShowTeamManager(false); setOpenDropdown(null); }}
              style={{
                width: 28, height: 28, borderRadius: 8, background: C.card,
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", color: C.muted, fontSize: 16, fontWeight: 700,
              }}
            >
              &#10005;
            </div>
          </div>

          {/* body */}
          <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>
            {teamsLoading && !teamsData ? (
              <div style={{ textAlign: "center", padding: 40, color: C.muted, fontFamily: FONT }}>Loading...</div>
            ) : teamsData ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {/* create team */}
                <div style={{
                  display: "flex", gap: 8, alignItems: "center",
                  padding: "12px 16px", background: C.card, borderRadius: 10,
                }}>
                  <input
                    type="text"
                    placeholder="New team manager name..."
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newTeamName.trim()) {
                        const color = MANAGE_COLORS[(teamsData?.teams.length ?? 0) % MANAGE_COLORS.length];
                        teamAction({ action: "create_team", name: newTeamName.trim(), color });
                        setNewTeamName("");
                      }
                    }}
                    style={{
                      flex: 1, background: C.input, color: C.text,
                      border: `1px solid ${C.border}`, borderRadius: 8,
                      padding: "8px 12px", fontSize: 13, fontFamily: FONT, outline: "none",
                    }}
                  />
                  <button
                    onClick={() => {
                      if (!newTeamName.trim()) return;
                      const color = MANAGE_COLORS[(teamsData?.teams.length ?? 0) % MANAGE_COLORS.length];
                      teamAction({ action: "create_team", name: newTeamName.trim(), color });
                      setNewTeamName("");
                    }}
                    style={{
                      background: `linear-gradient(135deg, ${C.purple}, ${C.purpleDark})`,
                      color: "#fff", border: "none", borderRadius: 8,
                      padding: "8px 16px", fontSize: 12, fontWeight: 700,
                      fontFamily: FONT, cursor: "pointer", whiteSpace: "nowrap",
                    }}
                  >
                    + Create Team
                  </button>
                </div>

                {/* existing teams */}
                {teamsData.teams.map((team) => (
                  <div key={team.id} style={{
                    background: C.card, borderRadius: 10,
                    borderLeft: `4px solid ${team.color || C.purple}`, overflow: "hidden",
                  }}>
                    <div style={{
                      padding: "12px 16px", display: "flex",
                      alignItems: "center", justifyContent: "space-between",
                      borderBottom: team.members.length > 0 ? `1px solid ${C.border}` : "none",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: FONT }}>
                          {team.name}
                        </span>
                        <span style={{ fontSize: 11, color: C.muted, fontFamily: FONT }}>
                          ({team.members.length} agent{team.members.length !== 1 ? "s" : ""})
                        </span>
                      </div>
                      <button
                        onClick={() => teamAction({ action: "delete_team", teamId: team.id })}
                        style={{
                          background: "transparent", border: `1px solid ${C.danger}`,
                          color: C.danger, borderRadius: 6, padding: "4px 10px",
                          fontSize: 11, fontWeight: 600, fontFamily: FONT,
                          cursor: "pointer", transition: "all 0.15s",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = C.danger; e.currentTarget.style.color = "#fff"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.danger; }}
                      >
                        Delete
                      </button>
                    </div>
                    {team.members.length > 0 && (
                      <div style={{ padding: "8px 16px" }}>
                        {team.members.map((m) => (
                          <div key={m.name} style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "6px 0", borderBottom: `1px solid ${C.border}`,
                          }}>
                            <div>
                              <span style={{ fontSize: 13, color: C.text, fontFamily: FONT, fontWeight: 500 }}>
                                {m.name}
                              </span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <div style={{ position: "relative" }}>
                                <button
                                  onClick={() => setOpenDropdown(openDropdown === `team-${team.id}-${m.name}` ? null : `team-${team.id}-${m.name}`)}
                                  style={{
                                    background: C.input, color: C.secondary, border: `1px solid ${C.border}`,
                                    borderRadius: 6, padding: "3px 8px", fontSize: 11, fontFamily: FONT,
                                    cursor: "pointer",
                                  }}
                                >
                                  Move &#9662;
                                </button>
                                {openDropdown === `team-${team.id}-${m.name}` && (
                                  <div style={{
                                    position: "absolute", top: "100%", right: 0, marginTop: 4,
                                    background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
                                    zIndex: 10, minWidth: 150, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                                    overflow: "hidden",
                                  }}>
                                    {teamsData.teams.filter((t) => t.id !== team.id).map((t) => (
                                      <div
                                        key={t.id}
                                        onClick={() => { teamAction({ action: "assign", agentName: m.name, teamId: t.id }); setOpenDropdown(null); }}
                                        style={{
                                          padding: "8px 12px", fontSize: 12, color: C.text, fontFamily: FONT,
                                          cursor: "pointer", borderBottom: `1px solid ${C.border}`,
                                          display: "flex", alignItems: "center", gap: 8,
                                        }}
                                        onMouseEnter={(e) => (e.currentTarget.style.background = C.cardHover)}
                                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                                      >
                                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: t.color || C.purple }} />
                                        {t.name}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div
                                onClick={() => teamAction({ action: "assign", agentName: m.name, teamId: null })}
                                style={{
                                  width: 22, height: 22, borderRadius: 6,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  cursor: "pointer", color: C.muted, fontSize: 13,
                                  background: "transparent", transition: "all 0.15s",
                                }}
                                title="Unassign"
                                onMouseEnter={(e) => { e.currentTarget.style.background = C.danger; e.currentTarget.style.color = "#fff"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.muted; }}
                              >
                                &#10005;
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {team.members.length === 0 && (
                      <div style={{ padding: "12px 16px", fontSize: 12, color: C.muted, fontFamily: FONT, fontStyle: "italic" }}>
                        No agents assigned
                      </div>
                    )}
                  </div>
                ))}

                {/* unassigned */}
                <div style={{
                  background: C.card, borderRadius: 10,
                  borderLeft: `4px solid ${C.muted}`, overflow: "hidden",
                }}>
                  <div style={{
                    padding: "12px 16px", borderBottom: teamsData.unassigned.length > 0 ? `1px solid ${C.border}` : "none",
                  }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: FONT }}>
                      Unassigned
                    </span>
                    <span style={{ fontSize: 11, color: C.muted, fontFamily: FONT, marginLeft: 8 }}>
                      ({teamsData.unassigned.length} agent{teamsData.unassigned.length !== 1 ? "s" : ""})
                    </span>
                  </div>
                  {teamsData.unassigned.length > 0 ? (
                    <div style={{ padding: "8px 16px" }}>
                      {teamsData.unassigned.map((m) => (
                        <div key={m.name} style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "6px 0", borderBottom: `1px solid ${C.border}`,
                        }}>
                          <div>
                            <span style={{ fontSize: 13, color: C.text, fontFamily: FONT, fontWeight: 500 }}>
                              {m.name}
                            </span>
                          </div>
                          <div style={{ position: "relative" }}>
                            <button
                              onClick={() => setOpenDropdown(openDropdown === `unassigned-${m.name}` ? null : `unassigned-${m.name}`)}
                              style={{
                                background: C.input, color: C.secondary, border: `1px solid ${C.border}`,
                                borderRadius: 6, padding: "3px 8px", fontSize: 11, fontFamily: FONT,
                                cursor: "pointer",
                              }}
                            >
                              Assign &#9662;
                            </button>
                            {openDropdown === `unassigned-${m.name}` && (
                              <div style={{
                                position: "absolute", top: "100%", right: 0, marginTop: 4,
                                background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
                                zIndex: 10, minWidth: 150, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                                overflow: "hidden",
                              }}>
                                {teamsData.teams.map((t) => (
                                  <div
                                    key={t.id}
                                    onClick={() => { teamAction({ action: "assign", agentName: m.name, teamId: t.id }); setOpenDropdown(null); }}
                                    style={{
                                      padding: "8px 12px", fontSize: 12, color: C.text, fontFamily: FONT,
                                      cursor: "pointer", borderBottom: `1px solid ${C.border}`,
                                      display: "flex", alignItems: "center", gap: 8,
                                    }}
                                    onMouseEnter={(e) => (e.currentTarget.style.background = C.cardHover)}
                                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                                  >
                                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: t.color || C.purple }} />
                                    {t.name}
                                  </div>
                                ))}
                                {teamsData.teams.length === 0 && (
                                  <div style={{ padding: "8px 12px", fontSize: 12, color: C.muted, fontFamily: FONT }}>
                                    No teams yet
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ padding: "12px 16px", fontSize: 12, color: C.muted, fontFamily: FONT, fontStyle: "italic" }}>
                      All agents assigned
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

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

            {/* sold only toggle */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => setSoldOnly((v) => !v)}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  border: `1px solid ${soldOnly ? C.success : C.border}`,
                  background: soldOnly ? C.success : C.input,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.2s",
                  flexShrink: 0,
                }}
              >
                {soldOnly && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5L4.5 7.5L8 2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <span
                style={{
                  fontSize: 11,
                  color: soldOnly ? C.success : C.secondary,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  fontFamily: FONT,
                  transition: "color 0.2s",
                }}
              >
                Sold Only
              </span>
            </label>

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
              {manualLoading ? (
                <>
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      border: "2.5px solid rgba(255,255,255,0.3)",
                      borderTopColor: "#fff",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                  LOADING...
                </>
              ) : (
                "UPDATE"
              )}
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
          <div style={{ position: "relative" }}>
            {manualLoading && (
              <div style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: "rgba(13, 13, 20, 0.6)",
                zIndex: 50,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 12,
              }}>
                <div style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 12,
                }}>
                  <div style={{
                    width: 40,
                    height: 40,
                    border: `3px solid ${C.border}`,
                    borderTopColor: C.orange,
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }} />
                  <div style={{ color: C.secondary, fontSize: 13, fontFamily: FONT, fontWeight: 600 }}>
                    Refreshing data...
                  </div>
                </div>
              </div>
            )}
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

                {/* Row 4: CS / AI / Spanish */}
                <SectionHeader title="Additional Sales" color={C.warning} />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 16,
                  }}
                >
                  {/* CS Deals with Auto/Home split */}
                  <div
                    style={{
                      background: C.card,
                      borderRadius: 12,
                      padding: "20px 24px",
                      borderLeft: `3px solid ${C.danger}`,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", color: C.secondary, marginBottom: 8, fontFamily: FONT }}>CS DEALS</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: C.danger, fontFamily: FONT, lineHeight: 1.1 }}>{fmt(data.csDeals?.total ?? 0)}</div>
                    <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 10 }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", fontFamily: FONT }}>Auto</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.orange, fontFamily: FONT }}>{fmt(data.csDeals?.auto ?? 0)}</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", fontFamily: FONT }}>Home</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.purpleLight, fontFamily: FONT }}>{fmt(data.csDeals?.home ?? 0)}</div>
                      </div>
                    </div>
                  </div>
                  {/* AI Deals with Auto/Home split */}
                  <div
                    style={{
                      background: C.card,
                      borderRadius: 12,
                      padding: "20px 24px",
                      borderLeft: `3px solid ${C.purple}`,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", color: C.secondary, marginBottom: 8, fontFamily: FONT }}>AI DEALS</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: C.purple, fontFamily: FONT, lineHeight: 1.1 }}>{fmt(data.aiDeals?.total ?? 0)}</div>
                    <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 10 }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", fontFamily: FONT }}>Auto</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.orange, fontFamily: FONT }}>{fmt(data.aiDeals?.auto ?? 0)}</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", fontFamily: FONT }}>Home</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.purpleLight, fontFamily: FONT }}>{fmt(data.aiDeals?.home ?? 0)}</div>
                      </div>
                    </div>
                  </div>
                  {/* Spanish Deals with Auto/Home split */}
                  <div
                    style={{
                      background: C.card,
                      borderRadius: 12,
                      padding: "20px 24px",
                      borderLeft: `3px solid ${C.orangeLight}`,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", color: C.secondary, marginBottom: 8, fontFamily: FONT }}>SPANISH DEALS</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: C.orangeLight, fontFamily: FONT, lineHeight: 1.1 }}>{fmt(data.spDeals?.total ?? 0)}</div>
                    <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 10 }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", fontFamily: FONT }}>Auto</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.orange, fontFamily: FONT }}>{fmt(data.spDeals?.auto ?? 0)}</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", fontFamily: FONT }}>Home</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.purpleLight, fontFamily: FONT }}>{fmt(data.spDeals?.home ?? 0)}</div>
                      </div>
                    </div>
                  </div>
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
                    fbCount={data?.fbTotal?.inAuto ?? 0}
                  />
                  <QueueTable
                    title="Home Queue Breakdown"
                    queues={HOME_QUEUES}
                    color={C.purple}
                    fbCount={data?.fbTotal?.inHome ?? 0}
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
                  {/* Product toggle */}
                  <div
                    style={{
                      display: "flex",
                      background: C.card,
                      borderRadius: 8,
                      padding: 3,
                      gap: 2,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    {(["combined", "auto", "home"] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setProductView(v)}
                        style={{
                          padding: "5px 14px",
                          border: "none",
                          borderRadius: 6,
                          fontSize: 12,
                          fontWeight: 600,
                          fontFamily: FONT,
                          cursor: "pointer",
                          transition: "all 0.2s",
                          color: productView === v ? C.text : C.muted,
                          background:
                            productView === v
                              ? `linear-gradient(135deg, ${C.purple}, ${C.purpleDark})`
                              : "transparent",
                          textTransform: "capitalize",
                        }}
                      >
                        {v === "combined" ? "Combined" : v === "auto" ? "Auto" : "Home"}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => setShowTeamManager(true)}
                    style={{
                      marginLeft: "auto",
                      background: C.card,
                      color: C.secondary,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      padding: "6px 14px",
                      fontSize: 12,
                      fontWeight: 600,
                      fontFamily: FONT,
                      cursor: "pointer",
                      transition: "all 0.2s",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = C.purpleLight;
                      e.currentTarget.style.color = C.text;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = C.border;
                      e.currentTarget.style.color = C.secondary;
                    }}
                  >
                    &#9881; Manage Teams
                  </button>
                </div>

                {byTeamMode ? <ByTeamView /> : <AllAgentsTable />}
              </div>
            )}

            {/* ── AVAILABILITY TAB ────────────────────────────────────────── */}
            {activeTab === "availability" && (
              <div>
                {availLoading && (
                  <div style={{ textAlign: "center", padding: 60, color: C.secondary, fontFamily: FONT }}>
                    Loading availability data...
                  </div>
                )}
                {!availLoading && !availData && (
                  <div style={{ textAlign: "center", padding: 60, color: C.muted, fontFamily: FONT }}>
                    No availability data. Select a date and switch to this tab.
                  </div>
                )}
                {!availLoading && availData && (() => {
                  const fmtTime = (secs: number) => {
                    const h = Math.floor(secs / 3600);
                    const m = Math.floor((secs % 3600) / 60);
                    return `${h}:${String(m).padStart(2, "0")}`;
                  };

                  // Team grouping — only 3 teams
                  const teamOrder = ["The Money Team", "Nothin But a G Thang", "T.O."];
                  const orderedTeams = data ? teamOrder.filter(t => data.teams[t]) : [];

                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const agentsByName: Record<string, any> = {};
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  for (const a of availData.agents) agentsByName[a.name] = a;

                  // Compute team metrics: Idle, Talk Time, RONA, Break Time
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const computeTeamMetrics = (members: any[]) => {
                    const count = members.length;
                    const totalIdle = members.reduce((s, a) => s + a.availableTime, 0);
                    const totalTalk = members.reduce((s, a) => s + a.inboundTalkTime + a.outboundTalkTime, 0);
                    const totalRona = members.reduce((s, a) => s + a.ronaCount, 0);
                    const totalBreak = members.reduce((s, a) => s + a.breakTime + a.lunchTime, 0);
                    return {
                      count,
                      avgIdle: count > 0 ? totalIdle / count : 0,
                      avgTalk: count > 0 ? totalTalk / count : 0,
                      avgRona: count > 0 ? totalRona / count : 0,
                      avgBreak: count > 0 ? totalBreak / count : 0,
                      totalIdle, totalTalk, totalRona, totalBreak,
                    };
                  };

                  // Aggregate all 3 teams for top-level summary
                  const allTeamMembers = orderedTeams.flatMap(t =>
                    (data?.teams[t] || []).map((n: string) => agentsByName[n]).filter(Boolean)
                  );
                  const overall = computeTeamMetrics(allTeamMembers);

                  // Sortable column helpers for availability
                  const handleAvailSort = (key: string) => {
                    if (availSortKey === key) setAvailSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else { setAvailSortKey(key); setAvailSortDir("desc"); }
                  };

                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const getAvailSortVal = (a: any, key: string): number => {
                    if (key === "availableTime") return a.availableTime;
                    if (key === "talkTime") return a.inboundTalkTime + a.outboundTalkTime;
                    if (key === "ronaCount") return a.ronaCount;
                    if (key === "breakTime") return a.breakTime + a.lunchTime;
                    return 0;
                  };

                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const sortAvailMembers = (members: any[]) =>
                    [...members].sort((a, b) => {
                      const va = getAvailSortVal(a, availSortKey);
                      const vb = getAvailSortVal(b, availSortKey);
                      return availSortDir === "desc" ? vb - va : va - vb;
                    });

                  const availColHeaders = [
                    { label: "Idle", key: "availableTime" },
                    { label: "Talk Time", key: "talkTime" },
                    { label: "RONA", key: "ronaCount" },
                    { label: "Break", key: "breakTime" },
                  ];

                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const renderAgentRow = (a: any) => {
                    const totalTalk = a.inboundTalkTime + a.outboundTalkTime;
                    const breakTotal = a.breakTime + a.lunchTime;
                    const cellBase = {
                      padding: "10px 12px", fontSize: 13, textAlign: "right" as const,
                      borderBottom: `1px solid ${C.border}`, fontFamily: FONT,
                    };
                    return (
                      <tr
                        key={a.extension}
                        style={{ transition: "background 0.15s" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = C.cardHover)}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ padding: "10px 12px", fontSize: 13, fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}`, fontFamily: FONT, whiteSpace: "nowrap" }}>
                          {a.name}
                        </td>
                        <td style={{ ...cellBase, color: C.success }}>{fmtTime(a.availableTime)}</td>
                        <td style={{ ...cellBase, color: C.text }}>{fmtTime(totalTalk)}</td>
                        <td style={{ ...cellBase, color: a.ronaCount > 5 ? C.danger : a.ronaCount > 0 ? C.warning : C.muted, fontWeight: a.ronaCount > 5 ? 700 : 400 }}>
                          {a.ronaCount}
                        </td>
                        <td style={{ ...cellBase, color: breakTotal > 0 ? C.warning : C.muted }}>{fmtTime(breakTotal)}</td>
                      </tr>
                    );
                  };

                  return (
                    <>
                      {/* 4 Top-Level Metric Boxes */}
                      <SectionHeader title="Availability" color={C.greenLight} />
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
                        <MetricCard label="Idle" value={fmtTime(overall.avgIdle)} subtitle={`${fmtTime(overall.totalIdle)} total`} color={C.success} />
                        <MetricCard label="Talk Time" value={fmtTime(overall.avgTalk)} subtitle={`${fmtTime(overall.totalTalk)} total`} color={C.orange} />
                        <MetricCard label="RONA" value={String(overall.totalRona)} subtitle={`${overall.avgRona.toFixed(1)} avg per agent`} color={C.danger} />
                        <MetricCard label="Break Time" value={fmtTime(overall.avgBreak)} subtitle={`${fmtTime(overall.totalBreak)} total`} color={C.purple} />
                      </div>

                      {/* Expandable Team Sections */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 24 }}>
                        {orderedTeams.map((team, idx) => {
                          const members = (data?.teams[team] || [])
                            .map((n: string) => agentsByName[n])
                            .filter(Boolean);
                          if (members.length === 0) return null;
                          const tm = computeTeamMetrics(members);
                          const color = TEAM_COLORS[idx % TEAM_COLORS.length];
                          const expanded = expandedTeams[team] === true;

                          return (
                            <div key={team} style={{ background: C.card, borderRadius: 12, borderLeft: `4px solid ${color}`, overflow: "hidden" }}>
                              <div
                                onClick={() => toggleTeam(team)}
                                style={{ padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", userSelect: "none" }}
                              >
                                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: FONT, display: "flex", alignItems: "center", gap: 20 }}>
                                  <span>{team} <span style={{ color: C.muted, fontWeight: 400, fontSize: 12 }}>({members.length})</span></span>
                                  <span style={{ color: C.success, fontSize: 13, fontWeight: 600 }}>Idle {fmtTime(tm.avgIdle)}</span>
                                  <span style={{ color: C.orange, fontSize: 13, fontWeight: 600 }}>Talk {fmtTime(tm.avgTalk)}</span>
                                  <span style={{ color: C.danger, fontSize: 13, fontWeight: 600 }}>RONA {tm.totalRona}</span>
                                  <span style={{ color: C.purple, fontSize: 13, fontWeight: 600 }}>Break {fmtTime(tm.avgBreak)}</span>
                                </div>
                                <div style={{ color: C.muted, fontSize: 18, transition: "transform 0.2s", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}>&#9660;</div>
                              </div>
                              {expanded && (
                                <div style={{ overflowX: "auto" }}>
                                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT }}>
                                    <thead>
                                      <tr>
                                        <th style={{ background: C.card, color: C.muted, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", padding: "10px 12px", textAlign: "left", borderBottom: `1px solid ${C.border}`, fontWeight: 600, fontFamily: FONT }}>Name</th>
                                        {availColHeaders.map(({ label, key }) => (
                                          <th
                                            key={key}
                                            onClick={() => handleAvailSort(key)}
                                            style={{
                                              background: C.card, color: availSortKey === key ? C.purpleLight : C.muted,
                                              fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase",
                                              padding: "10px 12px", textAlign: "right", borderBottom: `1px solid ${C.border}`,
                                              fontWeight: 600, fontFamily: FONT, whiteSpace: "nowrap",
                                              cursor: "pointer", userSelect: "none",
                                            }}
                                          >
                                            {label} {availSortKey === key ? (availSortDir === "desc" ? "\u25BC" : "\u25B2") : ""}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>{sortAvailMembers(members).map(renderAgentRow)}</tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* ── TRENDS TAB ─────────────────────────────────────────────── */}
            {activeTab === "trends" && (
              <ComingSoon
                title="Coming Soon"
                desc="Daily and weekly trend charts powered by Chart.js will be added here."
              />
            )}

            {/* ── TEXT OWNERS TAB ──────────────────────────────────────────── */}
            {activeTab === "textowners" && data && (
              <TextOwnersTab data={data} fromDate={fromDate} toDate={toDate} />
            )}
            {activeTab === "textowners" && !data && (
              <ComingSoon title="Loading..." desc="Waiting for sales data to load." />
            )}
          </>
          </div>
        )}
      </div>

      {/* ── team management modal ────────────────────────────────────────── */}
      <TeamManageModal />

      {/* ── T.O. deal override modal ───────────────────────────────────────── */}
      {toOverrideAgent && data && (() => {
        const toDeals = toOverrideAgent === "__all__"
          ? (data.toDeals ?? [])
          : (data.toDeals ?? []).filter(d => d.originalOwner.toLowerCase() === toOverrideAgent.toLowerCase());
        // Build list of assignable agents (all bySalesperson keys, excluding T.O. members and excluded)
        const toTeamMembers = new Set((data.teams["T.O."] ?? data.teams["TO."] ?? []).map(n => n.toLowerCase()));
        const assignableAgents = Object.keys(data.bySalesperson)
          .filter(n => !toTeamMembers.has(n.toLowerCase()) && n.trim())
          .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        const handleSaveOverrides = async () => {
          const entries = Object.entries(toOverrides).filter(([, agent]) => agent && agent.trim());
          if (entries.length === 0) return;
          setToSaving(true);
          try {
            const overridesPayload = entries.map(([contractNo, correctedOwner]) => {
              const deal = toDeals.find(d => d.contractNo === contractNo);
              return {
                contract_no: contractNo,
                customer_id: deal?.customerId || '',
                original_owner: deal?.originalOwner || '',
                corrected_owner: correctedOwner,
              };
            });
            const res = await fetch("/api/deal-overrides", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ overrides: overridesPayload }),
            });
            if (!res.ok) throw new Error("save failed");
            setToOverrideAgent(null);
            setToOverrides({});
            fetchData(true);
          } catch (e) {
            console.error("Save overrides error:", e);
          } finally {
            setToSaving(false);
          }
        };

        return (
          <div
            onClick={() => { setToOverrideAgent(null); setToOverrides({}); }}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
              zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: C.bg, borderRadius: 16, border: `1px solid ${C.border}`,
                width: "90%", maxWidth: 780, maxHeight: "85vh", overflow: "hidden",
                display: "flex", flexDirection: "column",
                boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
              }}
            >
              {/* header */}
              <div style={{
                padding: "20px 24px", borderBottom: `1px solid ${C.border}`,
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontFamily: FONT }}>
                  {toOverrideAgent === "__all__" ? "T.O. Errors" : toOverrideAgent} &mdash; {toDeals.length} deal{toDeals.length !== 1 ? "s" : ""} to review
                </div>
                <div
                  onClick={() => { setToOverrideAgent(null); setToOverrides({}); }}
                  style={{
                    width: 28, height: 28, borderRadius: 8, background: C.card,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", color: C.muted, fontSize: 16, fontWeight: 700,
                  }}
                >
                  &#10005;
                </div>
              </div>

              {/* body */}
              <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>
                {toDeals.length === 0 ? (
                  <div style={{ textAlign: "center", padding: 40, color: C.muted, fontFamily: FONT }}>
                    No unassigned T.O. deals{toOverrideAgent !== "__all__" ? " for this agent" : ""}.
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT }}>
                    <thead>
                      <tr>
                        {["Customer", "Sold Date", "Phone", "Assign To"].map((h, i) => (
                          <th
                            key={h}
                            style={{
                              background: C.card,
                              color: C.muted,
                              fontSize: 10,
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              padding: "10px 14px",
                              textAlign: i === 3 ? "center" : "left",
                              borderBottom: `1px solid ${C.border}`,
                              whiteSpace: "nowrap",
                              fontWeight: 600,
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {toDeals.map((deal) => (
                        <tr key={deal.contractNo}>
                          <td style={{
                            padding: "10px 14px", fontSize: 13, color: C.text,
                            borderBottom: `1px solid ${C.border}`, fontFamily: FONT, whiteSpace: "nowrap",
                          }}>
                            {deal.firstName} {deal.lastName}
                          </td>
                          <td style={{
                            padding: "10px 14px", fontSize: 13, color: C.secondary,
                            borderBottom: `1px solid ${C.border}`, fontFamily: FONT, whiteSpace: "nowrap",
                          }}>
                            {deal.soldDate}
                          </td>
                          <td style={{
                            padding: "10px 14px", fontSize: 13, color: C.secondary,
                            borderBottom: `1px solid ${C.border}`, fontFamily: FONT, whiteSpace: "nowrap",
                          }}>
                            {deal.phone ? deal.phone.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3") : "\u2014"}
                          </td>
                          <td style={{
                            padding: "10px 14px", borderBottom: `1px solid ${C.border}`, textAlign: "center",
                          }}>
                            <select
                              value={toOverrides[deal.contractNo] || ""}
                              onChange={(e) => setToOverrides(prev => ({ ...prev, [deal.contractNo]: e.target.value }))}
                              style={{
                                background: C.input, color: C.text,
                                border: `1px solid ${C.border}`, borderRadius: 8,
                                padding: "6px 10px", fontSize: 12, fontFamily: FONT,
                                outline: "none", width: "100%", maxWidth: 200,
                                cursor: "pointer",
                              }}
                            >
                              <option value="">-- Select Agent --</option>
                              {assignableAgents.map(agent => (
                                <option key={agent} value={agent}>{agent}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* footer */}
              <div style={{
                padding: "16px 24px", borderTop: `1px solid ${C.border}`,
                display: "flex", justifyContent: "flex-end", gap: 12,
              }}>
                <button
                  onClick={() => { setToOverrideAgent(null); setToOverrides({}); }}
                  style={{
                    background: C.card, color: C.muted, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "8px 20px", fontSize: 13, fontWeight: 600,
                    fontFamily: FONT, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveOverrides}
                  disabled={toSaving || Object.values(toOverrides).filter(v => v).length === 0}
                  style={{
                    background: Object.values(toOverrides).filter(v => v).length > 0
                      ? `linear-gradient(135deg, ${C.purple}, ${C.purpleDark})`
                      : C.card,
                    color: Object.values(toOverrides).filter(v => v).length > 0 ? "#fff" : C.muted,
                    border: "none", borderRadius: 8, padding: "8px 20px",
                    fontSize: 13, fontWeight: 700, fontFamily: FONT,
                    cursor: Object.values(toOverrides).filter(v => v).length > 0 ? "pointer" : "not-allowed",
                    opacity: toSaving ? 0.6 : 1,
                  }}
                >
                  {toSaving ? "Saving..." : `Save ${Object.values(toOverrides).filter(v => v).length} Override${Object.values(toOverrides).filter(v => v).length !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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