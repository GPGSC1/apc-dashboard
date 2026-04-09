"use client";
import React, { useState, useEffect, useCallback } from "react";

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
  teal: "#14B8A6",
  tealDark: "#0D9488",
  amber: "#F59E0B",
  amberDark: "#D97706",
  green: "#10B981",
  red: "#EF4444",
  purple: "#6B2D99",
};

const FONT = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif";

/* ── types ──────────────────────────────────────────────────────────────────── */
interface Account {
  id: number;
  scrub_date: string;
  account_number: string;
  insured_name: string;
  policy_number: string;
  agent_entity: string;
  installments_made: number;
  next_due_date: string | null;
  sched_cxl_date: string | null;
  bill_hold: string;
  billing_method: string;
  amount_due: number;
  main_phone: string;
  home_phone: string;
  mobile_phone: string;
  work_phone: string;
  customer_email: string;
  state: string;
  assigned_rep: string;
  dispo_1: string;
  dispo_2: string;
  dispo_date: string | null;
  email_sent: boolean;
  is_carryover: boolean;
  last_called_phone1: string | null;
  last_called_phone2: string | null;
  last_called_mobile: string | null;
}

interface DispoOption {
  id: number;
  label: string;
  is_carryover: boolean;
}

interface RepScheduleEntry {
  id: number;
  name: string;
  is_active: boolean;
  is_working: boolean;
  zero_pay_pct: number;
  non_zero_pay_pct: number;
}

interface ScrubSummary {
  scrubDate: string;
  filename: string;
  rawRowCount: number;
  notYetDueCount: number;
  pastDueCount: number;
  carryOverKept: number;
  carryOverStale: number;
  carryOverResolved: number;
  dupeCount: number;
  finalCount: number;
  workingReps: string[];
  repBreakdown: Record<string, number>;
}

interface UploadMeta {
  id: number;
  uploaded_at: string;
  scrub_date: string;
  filename: string;
  raw_row_count: number;
  filtered_row_count: number;
  carryover_count: number;
  final_row_count: number;
}

/* ── helpers ────────────────────────────────────────────────────────────────── */
const fmt = (n: number) => (n || 0).toLocaleString();
const fmtMoney = (n: number) =>
  "$" + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shortDate(d: string | null): string {
  if (!d) return "";
  const parts = d.slice(0, 10).split("-");
  if (parts.length !== 3) return d;
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

function shortDateTime(d: string | null): string {
  if (!d) return "";
  // d is like "2026-04-06 14:35:12" or "2026-04-06T14:35:12"
  const datePart = d.slice(0, 10);
  const timePart = d.slice(11, 19);
  const parts = datePart.split("-");
  if (parts.length !== 3) return d;
  const month = parseInt(parts[1]);
  const day = parseInt(parts[2]);
  if (!timePart) return `${month}/${day}`;
  const [hh, mm] = timePart.split(":");
  let hour = parseInt(hh);
  const ampm = hour >= 12 ? "PM" : "AM";
  if (hour > 12) hour -= 12;
  if (hour === 0) hour = 12;
  return `${month}/${day} ${hour}:${mm} ${ampm}`;
}

/* ── components ─────────────────────────────────────────────────────────────── */
function Th({ children, style, onClick }: { children: React.ReactNode; style?: React.CSSProperties; onClick?: () => void }) {
  return (
    <th
      onClick={onClick}
      style={{
        padding: "8px 10px",
        textAlign: "left",
        fontWeight: 600,
        fontSize: 11,
        color: C.secondary,
        borderBottom: `1px solid ${C.border}`,
        whiteSpace: "nowrap",
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td
      style={{
        padding: "6px 10px",
        fontSize: 12,
        color: C.text,
        borderBottom: `1px solid ${C.border}`,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </td>
  );
}

/* ── tabs definition ────────────────────────────────────────────────────────── */
const TABS = ["Overview", "Performance", "Availability", "Trends", "Text Owners"] as const;
type TabName = (typeof TABS)[number];

/* ── Coming Soon placeholder ─────────────────────────────────────────────────── */
function ComingSoon({ title, desc }: { title: string; desc: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 360,
        background: C.card,
        borderRadius: 12,
        padding: 40,
        textAlign: "center",
        border: `1px solid ${C.border}`,
      }}
    >
      <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }}>{"\u{1F6A7}"}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.text, marginBottom: 8, fontFamily: FONT }}>{title}</div>
      <div style={{ fontSize: 14, color: C.secondary, maxWidth: 460, fontFamily: FONT, lineHeight: 1.5 }}>{desc}</div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════════════════ */
export default function CSPage() {
  const [tab, setTab] = useState<TabName>("Overview");
  const [date, setDate] = useState(todayStr());
  const [repFilter, setRepFilter] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [upload, setUpload] = useState<UploadMeta | null>(null);
  const [dispoOptions, setDispoOptions] = useState<DispoOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Upload tab state
  const [file, setFile] = useState<File | null>(null);
  const [schedule, setSchedule] = useState<RepScheduleEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [scrubResult, setScrubResult] = useState<ScrubSummary | null>(null);

  // Pull status state
  const [pullStatus, setPullStatus] = useState<{ pull_status?: string; schedule_saved?: boolean; accounts_distributed?: number } | null>(null);

  // Overview tab state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [overview, setOverview] = useState<any>(null);
  const [overviewStart, setOverviewStart] = useState(todayStr());
  const [overviewEnd, setOverviewEnd] = useState(todayStr());
  const [overviewLoading, setOverviewLoading] = useState(false);

  // Performance tab state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [perfData, setPerfData] = useState<any>(null);
  const [perfMonth, setPerfMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  // Fetch accounts
  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ date });
      if (repFilter) params.set("rep", repFilter);
      const res = await fetch(`/api/cs/accounts?${params}`);
      const data = await res.json();
      if (data.ok) {
        setAccounts(data.accounts);
        setUpload(data.upload);
      } else {
        setError(data.error || "Failed to load accounts");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [date, repFilter]);

  // Fetch dispositions
  useEffect(() => {
    fetch("/api/cs/dispositions")
      .then((r) => r.json())
      .then((d) => { if (d.ok) setDispoOptions(d.dispositions); })
      .catch(() => {});
  }, []);

  // Fetch daily pull status
  useEffect(() => {
    fetch("/api/cs/daily-pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    })
      .then(r => r.json())
      .then(d => { if (d.ok) setPullStatus(d); })
      .catch(() => {});
  }, []);

  // Fetch accounts on date/rep change
  useEffect(() => {
    if (tab === "Overview") fetchAccounts();
  }, [tab, fetchAccounts]);

  // Fetch schedule on mount (used by Manage Reps modal)
  useEffect(() => {
    fetch(`/api/cs/reps?action=schedule&date=${todayStr()}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setSchedule(d.schedule); })
      .catch(() => {});
  }, []);

  // Fetch overview data (today + range activity)
  useEffect(() => {
    if (tab !== "Overview") return;
    setOverviewLoading(true);
    fetch(`/api/cs/overview-v2?start=${overviewStart}&end=${overviewEnd}`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setOverview(d); })
      .catch(() => {})
      .finally(() => setOverviewLoading(false));
  }, [tab, overviewStart, overviewEnd]);

  // Fetch performance data (weekly report)
  useEffect(() => {
    if (tab === "Performance") {
      setPerfData(null);
      fetch(`/api/cs/weekly-report?month=${perfMonth}`)
        .then((r) => r.json())
        .then((d) => { if (d.ok) setPerfData(d); })
        .catch(() => {});
    }
  }, [tab, perfMonth]);

  // Update disposition
  const updateDispo = async (accountId: number, field: string, value: string | boolean) => {
    const body: Record<string, unknown> = { accountId };
    if (field === "dispo1") body.dispo1 = value;
    if (field === "dispo2") body.dispo2 = value;
    if (field === "dispoDate") body.dispoDate = value;
    if (field === "emailSent") body.emailSent = value;

    try {
      await fetch("/api/cs/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // Update local state
      setAccounts((prev) =>
        prev.map((a) => {
          if (a.id !== accountId) return a;
          const updated = { ...a };
          if (field === "dispo1") updated.dispo_1 = value as string;
          if (field === "dispo2") updated.dispo_2 = value as string;
          if (field === "dispoDate") updated.dispo_date = value as string;
          if (field === "emailSent") updated.email_sent = value as boolean;
          return updated;
        })
      );
    } catch {
      // silent fail for inline edits
    }
  };

  // Handle scrub upload
  const handleScrub = async () => {
    if (!file) return;
    setUploading(true);
    setScrubResult(null);
    setError("");

    const workingReps = schedule.filter((s) => s.is_working).map((s) => s.name);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("schedule", JSON.stringify(workingReps));

    try {
      const res = await fetch("/api/cs/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.ok) {
        setScrubResult(data.summary);
        setFile(null);
        // Switch to work list
        setTimeout(() => {
          setDate(todayStr());
          setTab("Overview");
        }, 3000);
      } else {
        setError(data.error || "Scrub failed");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  };

  // Save schedule
  const saveSchedule = async () => {
    const repSchedule = schedule.map((s) => ({
      repId: s.id,
      isWorking: s.is_working,
      zeroPayPct: s.zero_pay_pct,
      nonZeroPayPct: s.non_zero_pay_pct,
    }));
    try {
      await fetch("/api/cs/reps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_schedule", date: todayStr(), repSchedule }),
      });
    } catch {
      // silent
    }
  };

  // Get unique reps from accounts for filter dropdown
  const uniqueReps = [...new Set(accounts.map((a) => a.assigned_rep))].filter(Boolean).sort();

  // Manage Reps modal (combines schedule + upload)
  const [showManageReps, setShowManageReps] = useState(false);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.text }}>
      {/* ── Sticky Header ───────────────────────────────────────────────────── */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          background: `linear-gradient(135deg, ${C.tealDark} 0%, ${C.bg} 100%)`,
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
          {/* Logo Section */}
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <a href="/" style={{ color: C.secondary, textDecoration: "none", fontSize: 13 }}>
              &larr; Home
            </a>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text, fontFamily: FONT, lineHeight: 1.2 }}>
                Guardian Protection Group
              </div>
              <div style={{ fontSize: 12, color: C.secondary, fontFamily: FONT }}>
                Customer Service Dashboard
              </div>
            </div>
          </div>

          {/* Last scrub indicator */}
          {upload && (
            <div style={{ fontSize: 11, color: C.secondary, textAlign: "right" }}>
              <div style={{ fontWeight: 600, color: C.text }}>Last Scrub</div>
              <div>{new Date(upload.uploaded_at).toLocaleString()} &middot; {fmt(upload.final_row_count)} accounts</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Tab Bar ─────────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "16px 24px 0" }}>
        <div
          style={{
            display: "flex",
            background: C.card,
            borderRadius: 12,
            padding: 4,
            gap: 4,
          }}
        >
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
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
                color: tab === t ? "#000" : C.secondary,
                background: tab === t ? `linear-gradient(135deg, ${C.teal}, ${C.tealDark})` : "transparent",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* ── Error Banner ────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ maxWidth: 1400, margin: "8px auto 0", padding: "0 24px" }}>
          <div
            style={{
              padding: "8px 12px",
              background: "#7F1D1D",
              color: "#FCA5A5",
              borderRadius: 6,
              fontSize: 12,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>{error}</span>
            <button
              onClick={() => setError("")}
              style={{ background: "none", border: "none", color: "#FCA5A5", cursor: "pointer" }}
            >
              X
            </button>
          </div>
        </div>
      )}

      {/* ── Pull Status Banner ──────────────────────────────────────────────── */}
      {pullStatus?.pull_status === "waiting_schedule" && (
        <div style={{ maxWidth: 1400, margin: "8px auto 0", padding: "0 24px" }}>
          <div
            style={{
              padding: "10px 16px",
              background: "linear-gradient(135deg, #78350F 0%, #92400E 100%)",
              color: "#FDE68A",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={{ fontSize: 18 }}>!</span>
            <span>
              PBS pull is waiting — set today&apos;s rep schedule and save it. The pull will run automatically once saved.
            </span>
            <button
              onClick={() => { setTab("Performance"); setShowManageReps(true); }}
              style={{
                marginLeft: "auto",
                padding: "5px 14px",
                borderRadius: 6,
                border: "none",
                background: "#F59E0B",
                color: "#000",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT,
                whiteSpace: "nowrap",
              }}
            >
              Manage Reps
            </button>
          </div>
        </div>
      )}
      {pullStatus?.pull_status === "complete" && pullStatus.accounts_distributed && pullStatus.accounts_distributed > 0 && (
        <div style={{ maxWidth: 1400, margin: "8px auto 0", padding: "0 24px" }}>
          <div
            style={{
              padding: "8px 16px",
              background: "rgba(16,185,129,0.1)",
              border: `1px solid rgba(16,185,129,0.3)`,
              color: C.green,
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            Today&apos;s pull complete — {fmt(pullStatus.accounts_distributed)} accounts distributed
          </div>
        </div>
      )}

      {/* ── Tab Content ─────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "16px 24px 48px" }}>
        {tab === "Overview" && (
          <WorkListTab
            accounts={accounts}
            dispoOptions={dispoOptions}
            date={date}
            setDate={setDate}
            repFilter={repFilter}
            setRepFilter={setRepFilter}
            uniqueReps={uniqueReps}
            loading={loading}
            updateDispo={updateDispo}
            overview={overview}
            overviewStart={overviewStart}
            overviewEnd={overviewEnd}
            setOverviewStart={setOverviewStart}
            setOverviewEnd={setOverviewEnd}
            overviewLoading={overviewLoading}
          />
        )}
        {tab === "Performance" && (
          <PerformanceTab
            perfData={perfData}
            perfMonth={perfMonth}
            setPerfMonth={setPerfMonth}
            onManageReps={() => setShowManageReps(true)}
            csReps={schedule.map(s => s.name)}
          />
        )}
        {tab === "Availability" && (
          <ComingSoon
            title="Availability — Coming Soon"
            desc="Real-time agent availability tracking: Idle, Talk, RONA, and Break time per rep. Same metrics as the Sales dashboard's availability view, scoped to the Collections team."
          />
        )}
        {tab === "Trends" && (
          <ComingSoon
            title="Trends — Coming Soon"
            desc="Daily and weekly trend charts for collections, conversion rates, call volume, and disposition mix. Powered by historical data from the daily stats sync."
          />
        )}
        {tab === "Text Owners" && (
          <ComingSoon
            title="Text Owners — Coming Soon"
            desc="Send SMS reminders to account owners with past-due balances. Pending Twilio A2P 10DLC campaign approval."
          />
        )}
      </div>

      {/* ── Manage Reps Modal ───────────────────────────────────────────────── */}
      {showManageReps && (
        <ManageRepsModal
          schedule={schedule}
          setSchedule={setSchedule}
          saveSchedule={saveSchedule}
          file={file}
          setFile={setFile}
          uploading={uploading}
          scrubResult={scrubResult}
          handleScrub={handleScrub}
          onClose={() => setShowManageReps(false)}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   WORK LIST TAB
   ══════════════════════════════════════════════════════════════════════════════ */
function WorkListTab({
  accounts,
  dispoOptions,
  date,
  setDate,
  repFilter,
  setRepFilter,
  uniqueReps,
  loading,
  updateDispo,
  overview,
  overviewStart,
  overviewEnd,
  setOverviewStart,
  setOverviewEnd,
  overviewLoading,
}: {
  accounts: Account[];
  dispoOptions: DispoOption[];
  date: string;
  setDate: (d: string) => void;
  repFilter: string;
  setRepFilter: (r: string) => void;
  uniqueReps: string[];
  loading: boolean;
  updateDispo: (id: number, field: string, value: string | boolean) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  overview: any;
  overviewStart: string;
  overviewEnd: string;
  setOverviewStart: (d: string) => void;
  setOverviewEnd: (d: string) => void;
  overviewLoading: boolean;
}) {
  const [sortCol, setSortCol] = useState<string>("assigned_rep");
  const [sortAsc, setSortAsc] = useState(true);
  const [showFollowUps, setShowFollowUps] = useState(false);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  const FOLLOW_UP_DISPOS = ["follow up", "scheduled pdp", "mailed check", "mailed c."];
  const filtered = showFollowUps
    ? accounts.filter((a) => a.dispo_1 && FOLLOW_UP_DISPOS.includes(a.dispo_1.trim().toLowerCase()))
    : accounts;

  const sorted = [...filtered].sort((a, b) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const av = (a as any)[sortCol];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bv = (b as any)[sortCol];
    const aVal = av == null ? "" : av;
    const bVal = bv == null ? "" : bv;
    if (typeof aVal === "number" && typeof bVal === "number") {
      return sortAsc ? aVal - bVal : bVal - aVal;
    }
    const cmp = String(aVal).localeCompare(String(bVal));
    return sortAsc ? cmp : -cmp;
  });

  // Summary stats
  const repCounts: Record<string, number> = {};
  const carryoverCount = accounts.filter((a) => a.is_carryover).length;
  accounts.forEach((a) => {
    if (a.assigned_rep) repCounts[a.assigned_rep] = (repCounts[a.assigned_rep] || 0) + 1;
  });

  const arrow = (col: string) => (sortCol === col ? (sortAsc ? " \u25B2" : " \u25BC") : "");

  // ─── Overview stat boxes (v2 — 4-row layout) ─────────────────────────────
  const m = overview?.metrics;
  const records = m?.records;
  const calls = m?.calls;
  const pct = m?.percentages;
  const amts = m?.amounts;
  const isTodayRange = overviewStart === overviewEnd && overviewStart === todayStr();

  const quickRange = (days: number) => {
    const end = todayStr();
    const [y, m, d] = end.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - (days - 1));
    const start = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    setOverviewStart(start);
    setOverviewEnd(end);
  };
  const setTodayRange = () => { const t = todayStr(); setOverviewStart(t); setOverviewEnd(t); };
  const setMTD = () => { const t = todayStr(); setOverviewStart(t.slice(0, 8) + "01"); setOverviewEnd(t); };
  const setYesterday = () => {
    const [y, m, d] = todayStr().split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    const yd = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    setOverviewStart(yd);
    setOverviewEnd(yd);
  };

  const StatBox = ({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) => (
    <div
      style={{
        flex: "1 1 160px",
        minWidth: 160,
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || C.text, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.secondary, marginTop: 4 }}>{sub}</div>}
    </div>
  );

  const quickBtn = (label: string, onClick: () => void, active: boolean) => (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px",
        borderRadius: 6,
        border: `1px solid ${active ? C.teal : C.border}`,
        background: active ? C.teal : "transparent",
        color: active ? "#000" : C.secondary,
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer",
        fontFamily: FONT,
      }}
    >
      {label}
    </button>
  );

  const dateInputStyle: React.CSSProperties = {
    background: C.input, color: C.text, border: `1px solid ${C.border}`,
    borderRadius: 4, padding: "4px 8px", fontSize: 12, fontFamily: FONT,
  };

  return (
    <>
      {/* ═══ Range selector ═══ */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.secondary, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Range
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {quickBtn("Today", setTodayRange, isTodayRange)}
          {quickBtn("MTD", setMTD, false)}
          {overviewLoading && <span style={{ fontSize: 11, color: C.muted }}>Loading…</span>}
        </div>
      </div>

      {/* ═══ ROW 1 — RECORDS ═══ */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.secondary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Records
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <StatBox label="Total Count" value={records ? fmt(records.total) : "—"} />
        <StatBox label={"\u00D8 Pay Count"} value={records ? fmt(records.zero) : "—"} color={C.amber} />
        <StatBox label={`Non \u00D8 Pay Count`} value={records ? fmt(records.non_zero) : "—"} />
        <StatBox
          label="Follow Ups"
          value={records ? fmt(records.followups) : "—"}
          color={C.teal}
          sub={records ? `${fmt(records.followups_zero)} \u00D8P \u00B7 ${fmt(records.followups_non_zero)} N\u00D8P` : undefined}
        />
      </div>

      {/* ═══ ROW 2 — CALLS ═══ */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.secondary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Calls
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <StatBox label={`Outbound to \u00D8 Pay`} value={calls ? fmt(calls.zero_pay_calls) : "—"} color={C.amber} />
        <StatBox label={`Outbound to N\u00D8P`} value={calls ? fmt(calls.non_zero_calls) : "—"} />
        <StatBox label="Inbound" value={calls ? fmt(calls.inbound_answered) : "—"} color={C.green} />
        <StatBox label="Unanswered" value={calls ? fmt(calls.unanswered_phones ?? calls.abandoned) : "—"} color={C.red} />
      </div>

      {/* ═══ ROW 3 — PERCENTAGES ═══ */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.secondary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Percentages
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <StatBox
          label="List Complete"
          value={pct ? `${pct.list_complete.toFixed(1)}%` : "—"}
          color={pct && pct.list_complete >= 80 ? C.green : C.amber}
        />
        <StatBox
          label={`\u00D8 Pay %`}
          value={pct ? `${pct.zero_pay_pct.toFixed(1)}%` : "—"}
          color={C.amber}
        />
        <StatBox
          label={`N\u00D8P %`}
          value={pct ? `${pct.non_zero_pct.toFixed(1)}%` : "—"}
        />
        <StatBox
          label="Unanswered %"
          value={pct ? `${(pct.unanswered_pct ?? 0).toFixed(1)}%` : "—"}
          color={C.red}
        />
      </div>

      {/* ═══ ROW 4 — AMOUNTS ═══ */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.secondary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Amounts
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        <StatBox
          label="Total Amount Collected"
          value={amts ? fmtMoney(amts.total_collected) : "—"}
          color={C.green}
          sub={amts && amts.amt_due_workable ? `${((amts.total_collected / amts.amt_due_workable) * 100).toFixed(1)}% of list collected` : undefined}
        />
        <StatBox
          label={`\u00D8 Pay`}
          value={amts ? fmtMoney(amts.zero_pay_collected) : "—"}
          color={C.amber}
        />
        <StatBox
          label={`N\u00D8P`}
          value={amts ? fmtMoney(amts.non_zero_collected) : "—"}
        />
        <StatBox
          label="Total Amount on List"
          value={amts ? fmtMoney(amts.amt_due_workable ?? 0) : "—"}
          sub="100% collectible universe"
        />
      </div>

      {/* ═══ WORK LIST (always today, unaffected by range) ═══ */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.secondary, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
        Work List
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <label style={{ fontSize: 11, color: C.muted, marginRight: 6 }}>Rep:</label>
          <select
            value={repFilter}
            onChange={(e) => setRepFilter(e.target.value)}
            style={{
              background: C.input,
              color: C.text,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 12,
              fontFamily: FONT,
            }}
          >
            <option value="">All Reps</option>
            {uniqueReps.map((r) => (
              <option key={r} value={r}>{r} ({repCounts[r] || 0})</option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 12, color: C.secondary }}>
          {fmt(showFollowUps ? filtered.length : accounts.length)} accounts
          {carryoverCount > 0 && (
            <span style={{ color: C.teal, marginLeft: 8 }}>({carryoverCount} carry-overs)</span>
          )}
        </div>
        <label
          style={{
            display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: showFollowUps ? C.teal : C.muted, cursor: "pointer",
            background: showFollowUps ? `${C.teal}18` : "transparent",
            border: `1px solid ${showFollowUps ? C.teal : C.border}`,
            borderRadius: 4, padding: "3px 8px",
          }}
        >
          <input
            type="checkbox"
            checked={showFollowUps}
            onChange={(e) => setShowFollowUps(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          Follow-ups Only
        </label>
        {/* Rep breakdown pills */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginLeft: "auto" }}>
          {Object.entries(repCounts)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([rep, count]) => (
              <span
                key={rep}
                onClick={() => setRepFilter(repFilter === rep ? "" : rep)}
                style={{
                  padding: "2px 8px",
                  borderRadius: 10,
                  fontSize: 10,
                  fontWeight: 600,
                  background: repFilter === rep ? C.teal : C.card,
                  color: repFilter === rep ? "#000" : C.secondary,
                  cursor: "pointer",
                  border: `1px solid ${C.border}`,
                }}
              >
                {rep}: {count}
              </span>
            ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: C.muted }}>Loading...</div>
      ) : accounts.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: C.muted }}>
          No accounts found for this date. Upload a PBS report in the Upload tab.
        </div>
      ) : (
        <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: C.card }}>
                <Th onClick={() => handleSort("assigned_rep")}>Rep{arrow("assigned_rep")}</Th>
                <Th onClick={() => handleSort("account_number")}>Account{arrow("account_number")}</Th>
                <Th onClick={() => handleSort("insured_name")}>Name{arrow("insured_name")}</Th>
                <Th onClick={() => handleSort("installments_made")}>Inst{arrow("installments_made")}</Th>
                <Th onClick={() => handleSort("amount_due")}>Amt Due{arrow("amount_due")}</Th>
                <Th onClick={() => handleSort("next_due_date")}>Due Date{arrow("next_due_date")}</Th>
                <Th onClick={() => handleSort("sched_cxl_date")}>CXL Date{arrow("sched_cxl_date")}</Th>
                <Th>Phone 1</Th>
                <Th onClick={() => handleSort("last_called_phone1")}>Called{arrow("last_called_phone1")}</Th>
                <Th>Phone 2</Th>
                <Th onClick={() => handleSort("last_called_phone2")}>Called{arrow("last_called_phone2")}</Th>
                <Th>Mobile</Th>
                <Th onClick={() => handleSort("last_called_mobile")}>Called{arrow("last_called_mobile")}</Th>
                <Th onClick={() => handleSort("billing_method")}>Billing{arrow("billing_method")}</Th>
                <Th onClick={() => handleSort("state")}>State{arrow("state")}</Th>
                <Th style={{ minWidth: 120 }}>Dispo 1</Th>
                <Th style={{ minWidth: 100 }}>Dispo 2</Th>
                <Th style={{ minWidth: 90 }}>Date</Th>
                <Th>Email</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr
                  key={a.id}
                  style={{
                    borderLeft: a.is_carryover
                      ? `3px solid ${C.teal}`
                      : a.installments_made === 0
                      ? `3px solid ${C.amber}`
                      : "3px solid transparent",
                  }}
                >
                  <Td style={{ fontWeight: 600, fontSize: 11 }}>{a.assigned_rep}</Td>
                  <Td style={{ fontSize: 11, fontFamily: "monospace" }}>
                    {a.account_number}
                    {a.is_carryover && (
                      <span style={{
                        marginLeft: 4, fontSize: 8, fontWeight: 700, fontFamily: FONT,
                        color: C.teal, border: `1px solid ${C.teal}`, borderRadius: 3,
                        padding: "0 3px", verticalAlign: "middle",
                      }}>CO</span>
                    )}
                  </Td>
                  <Td style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {a.insured_name}
                  </Td>
                  <Td
                    style={{
                      textAlign: "center",
                      color: a.installments_made === 0 ? C.amber : C.text,
                      fontWeight: a.installments_made === 0 ? 700 : 400,
                    }}
                  >
                    {a.installments_made}
                  </Td>
                  <Td style={{ textAlign: "right" }}>{fmtMoney(a.amount_due)}</Td>
                  <Td>{shortDate(a.next_due_date)}</Td>
                  <Td>{shortDate(a.sched_cxl_date)}</Td>
                  <Td style={{ fontSize: 11 }}>{a.main_phone}</Td>
                  <Td style={{ fontSize: 10, textAlign: "center" }}>
                    {(() => {
                      if (!a.last_called_phone1) return <span style={{ color: C.muted }}>--</span>;
                      const today = todayStr();
                      const d = a.last_called_phone1.slice(0, 10);
                      const daysAgo = Math.floor((new Date(today).getTime() - new Date(d).getTime()) / 86400000);
                      const color = daysAgo === 0 ? C.green : daysAgo <= 2 ? C.amber : C.red;
                      return <span style={{ color, fontWeight: 600 }}>{shortDateTime(a.last_called_phone1)}</span>;
                    })()}
                  </Td>
                  <Td style={{ fontSize: 11, color: a.work_phone && a.work_phone !== a.main_phone ? C.text : C.muted }}>
                    {a.work_phone && a.work_phone !== a.main_phone ? a.work_phone : ""}
                  </Td>
                  <Td style={{ fontSize: 10, textAlign: "center" }}>
                    {(() => {
                      if (!a.work_phone || a.work_phone === a.main_phone || !a.last_called_phone2) return <span style={{ color: C.muted }}>--</span>;
                      const today = todayStr();
                      const d = a.last_called_phone2.slice(0, 10);
                      const daysAgo = Math.floor((new Date(today).getTime() - new Date(d).getTime()) / 86400000);
                      const color = daysAgo === 0 ? C.green : daysAgo <= 2 ? C.amber : C.red;
                      return <span style={{ color, fontWeight: 600 }}>{shortDateTime(a.last_called_phone2)}</span>;
                    })()}
                  </Td>
                  <Td style={{ fontSize: 11, color: a.mobile_phone && a.mobile_phone !== a.main_phone && a.mobile_phone !== a.work_phone ? C.text : C.muted }}>
                    {a.mobile_phone && a.mobile_phone !== a.main_phone && a.mobile_phone !== a.work_phone ? a.mobile_phone : ""}
                  </Td>
                  <Td style={{ fontSize: 10, textAlign: "center" }}>
                    {(() => {
                      if (!a.mobile_phone || a.mobile_phone === a.main_phone || a.mobile_phone === a.work_phone || !a.last_called_mobile) return <span style={{ color: C.muted }}>--</span>;
                      const today = todayStr();
                      const d = a.last_called_mobile.slice(0, 10);
                      const daysAgo = Math.floor((new Date(today).getTime() - new Date(d).getTime()) / 86400000);
                      const color = daysAgo === 0 ? C.green : daysAgo <= 2 ? C.amber : C.red;
                      return <span style={{ color, fontWeight: 600 }}>{shortDateTime(a.last_called_mobile)}</span>;
                    })()}
                  </Td>
                  <Td style={{ fontSize: 10 }}>{a.billing_method}</Td>
                  <Td style={{ textAlign: "center", fontSize: 10 }}>{a.state}</Td>
                  <Td>
                    <select
                      value={a.dispo_1 || ""}
                      onChange={(e) => updateDispo(a.id, "dispo1", e.target.value)}
                      style={{
                        background: C.input,
                        color: C.text,
                        border: `1px solid ${C.border}`,
                        borderRadius: 3,
                        padding: "2px 4px",
                        fontSize: 11,
                        fontFamily: FONT,
                        width: "100%",
                      }}
                    >
                      <option value="">--</option>
                      {dispoOptions.map((d) => (
                        <option key={d.id} value={d.label}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <input
                      type="text"
                      value={a.dispo_2 || ""}
                      onChange={(e) => updateDispo(a.id, "dispo2", e.target.value)}
                      placeholder=""
                      style={{
                        background: C.input,
                        color: C.text,
                        border: `1px solid ${C.border}`,
                        borderRadius: 3,
                        padding: "2px 4px",
                        fontSize: 11,
                        fontFamily: FONT,
                        width: "100%",
                      }}
                    />
                  </Td>
                  <Td>
                    <input
                      type="date"
                      value={a.dispo_date?.slice(0, 10) || ""}
                      onChange={(e) => updateDispo(a.id, "dispoDate", e.target.value)}
                      style={{
                        background: C.input,
                        color: C.text,
                        border: `1px solid ${C.border}`,
                        borderRadius: 3,
                        padding: "2px 4px",
                        fontSize: 10,
                        fontFamily: FONT,
                        width: 90,
                      }}
                    />
                  </Td>
                  <Td style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={a.email_sent || false}
                      onChange={(e) => updateDispo(a.id, "emailSent", e.target.checked)}
                      style={{ cursor: "pointer" }}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   UPLOAD TAB
   ══════════════════════════════════════════════════════════════════════════════ */
function UploadTab({
  file,
  setFile,
  schedule,
  setSchedule,
  uploading,
  scrubResult,
  handleScrub,
  saveSchedule,
}: {
  file: File | null;
  setFile: (f: File | null) => void;
  schedule: RepScheduleEntry[];
  setSchedule: (s: RepScheduleEntry[]) => void;
  uploading: boolean;
  scrubResult: ScrubSummary | null;
  handleScrub: () => void;
  saveSchedule: () => void;
}) {
  const toggleRep = (id: number) => {
    setSchedule(
      schedule.map((s) => (s.id === id ? { ...s, is_working: !s.is_working } : s))
    );
  };

  const workingCount = schedule.filter((s) => s.is_working).length;

  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
      {/* Left: Upload + Run */}
      <div style={{ flex: "1 1 400px" }}>
        {/* File Drop Zone */}
        <div
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) setFile(f);
          }}
          onDragOver={(e) => e.preventDefault()}
          style={{
            background: C.card,
            border: `2px dashed ${file ? C.teal : C.border}`,
            borderRadius: 12,
            padding: 32,
            textAlign: "center",
            marginBottom: 16,
          }}
        >
          {file ? (
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.teal }}>{file.name}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                {(file.size / 1024).toFixed(0)} KB
              </div>
              <button
                onClick={() => setFile(null)}
                style={{
                  marginTop: 8,
                  background: "none",
                  border: "none",
                  color: C.red,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 14, color: C.muted, marginBottom: 8 }}>
                Drop PBS Excel file here or click to browse
              </div>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setFile(f);
                }}
                style={{ fontSize: 12 }}
              />
            </div>
          )}
        </div>

        {/* Run Scrub Button */}
        <button
          onClick={handleScrub}
          disabled={!file || uploading || workingCount === 0}
          style={{
            width: "100%",
            padding: "12px 24px",
            borderRadius: 8,
            border: "none",
            fontSize: 14,
            fontWeight: 700,
            fontFamily: FONT,
            cursor: file && !uploading && workingCount > 0 ? "pointer" : "not-allowed",
            background: file && !uploading && workingCount > 0 ? C.teal : C.border,
            color: file && !uploading && workingCount > 0 ? "#000" : C.muted,
          }}
        >
          {uploading ? "Running Scrub..." : "Run Morning Scrub"}
        </button>

        {/* Scrub Result */}
        {scrubResult && (
          <div
            style={{
              marginTop: 16,
              background: C.card,
              border: `1px solid ${C.teal}`,
              borderRadius: 8,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: C.teal, marginBottom: 8 }}>
              Scrub Complete
            </div>
            <div style={{ fontSize: 12, color: C.secondary, lineHeight: 1.8 }}>
              <strong>PBS Import:</strong> {fmt(scrubResult.rawRowCount)} total accounts
              <br />
              Removed (not yet past due): {fmt(scrubResult.notYetDueCount)}
              <br />
              Past due accounts: {fmt(scrubResult.pastDueCount)}
              <br />
              <br />
              <strong>Carry-overs:</strong>
              <br />
              Kept: {fmt(scrubResult.carryOverKept)} | Stale: {fmt(scrubResult.carryOverStale)} |
              Resolved: {fmt(scrubResult.carryOverResolved)}
              <br />
              Duplicates removed: {fmt(scrubResult.dupeCount)}
              <br />
              <br />
              <strong>Final List:</strong> {fmt(scrubResult.finalCount)} accounts
              <br />
              Working reps ({scrubResult.workingReps.length}): {scrubResult.workingReps.join(", ")}
              <br />
              <br />
              <strong>Per Rep:</strong>
              <br />
              {Object.entries(scrubResult.repBreakdown)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([rep, count]) => (
                  <span key={rep} style={{ marginRight: 12 }}>
                    {rep}: {count}
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Right: Rep Schedule */}
      <div style={{ flex: "0 0 240px" }}>
        <div
          style={{
            background: C.card,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            padding: 16,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
            Working Today ({workingCount}/{schedule.length})
          </div>
          {schedule.map((s) => (
            <label
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                fontSize: 13,
                cursor: "pointer",
                color: s.is_working ? C.text : C.muted,
              }}
            >
              <input
                type="checkbox"
                checked={s.is_working}
                onChange={() => toggleRep(s.id)}
                style={{ cursor: "pointer" }}
              />
              {s.name}
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              onClick={() => setSchedule(schedule.map((s) => ({ ...s, is_working: true })))}
              style={{
                flex: 1,
                padding: "4px 8px",
                borderRadius: 4,
                border: `1px solid ${C.border}`,
                background: "transparent",
                color: C.secondary,
                fontSize: 10,
                cursor: "pointer",
                fontFamily: FONT,
              }}
            >
              All On
            </button>
            <button
              onClick={() => setSchedule(schedule.map((s) => ({ ...s, is_working: false })))}
              style={{
                flex: 1,
                padding: "4px 8px",
                borderRadius: 4,
                border: `1px solid ${C.border}`,
                background: "transparent",
                color: C.secondary,
                fontSize: 10,
                cursor: "pointer",
                fontFamily: FONT,
              }}
            >
              All Off
            </button>
          </div>
          <button
            onClick={saveSchedule}
            style={{
              width: "100%",
              marginTop: 8,
              padding: "6px 12px",
              borderRadius: 4,
              border: "none",
              background: C.tealDark,
              color: C.text,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FONT,
            }}
          >
            Save Schedule
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   PERFORMANCE TAB — Weekly Report (mirrors CS Director Weekly Workbook)
   ══════════════════════════════════════════════════════════════════════════════ */

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 15, fontWeight: 800, color: C.teal, marginTop: 28, marginBottom: 10,
      padding: "8px 12px", background: "rgba(20,184,166,0.08)", borderRadius: 6,
      borderLeft: `3px solid ${C.teal}`,
    }}>
      {children}
    </div>
  );
}

function WTh({ children, style, colSpan }: { children?: React.ReactNode; style?: React.CSSProperties; colSpan?: number }) {
  return (
    <th colSpan={colSpan} style={{
      padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: 10,
      color: C.secondary, borderBottom: `1px solid ${C.border}`,
      whiteSpace: "nowrap", ...style,
    }}>
      {children}
    </th>
  );
}

function WTd({ children, style, colSpan }: { children?: React.ReactNode; style?: React.CSSProperties; colSpan?: number }) {
  return (
    <td colSpan={colSpan} style={{
      padding: "5px 8px", fontSize: 12, color: C.text,
      borderBottom: `1px solid ${C.border}`, textAlign: "right",
      whiteSpace: "nowrap", ...style,
    }}>
      {children}
    </td>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PerformanceTab({ perfData, perfMonth, setPerfMonth, onManageReps, csReps }: { perfData: any; perfMonth: string; setPerfMonth: (m: string) => void; onManageReps: () => void; csReps: string[] }) {
  const csRepSet = new Set(csReps.map(r => r.trim().toLowerCase()));
  const isCsRep = (name: string) => csRepSet.size === 0 || csRepSet.has((name || "").trim().toLowerCase());
  // Date range for stats view
  const [statsStart, setStatsStart] = useState(todayStr());
  const [statsEnd, setStatsEnd] = useState(todayStr());
  const [statsData, setStatsData] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Calls Made date range state (separate from stats)
  const [callsStart, setCallsStart] = useState(todayStr());
  const [callsEnd, setCallsEnd] = useState(todayStr());
  const [callsData, setCallsData] = useState<Record<string, number> | null>(null);
  const [callsLoading, setCallsLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Fetch daily stats when date range changes
  useEffect(() => {
    if (!statsStart || !statsEnd) return;
    setStatsLoading(true);
    fetch(`/api/cs/daily-stats?start=${statsStart}&end=${statsEnd}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setStatsData(d); })
      .catch(() => {})
      .finally(() => setStatsLoading(false));
  }, [statsStart, statsEnd]);

  // Fetch calls made when dates change
  useEffect(() => {
    if (!callsStart || !callsEnd) return;
    setCallsLoading(true);
    fetch(`/api/cs/calls-made?start=${callsStart}&end=${callsEnd}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setCallsData(d.callsByRep); })
      .catch(() => {})
      .finally(() => setCallsLoading(false));
  }, [callsStart, callsEnd]);

  // Quick-set today only — drives both stats and calls
  const setToday = () => {
    const t = todayStr();
    setStatsStart(t); setStatsEnd(t);
    setCallsStart(t); setCallsEnd(t);
  };

  // Quick-set MTD (1st of month through today)
  const setMTD = () => {
    const t = todayStr();
    const first = t.slice(0, 8) + "01";
    setStatsStart(first); setStatsEnd(t);
    setCallsStart(first); setCallsEnd(t);
  };
  const isToday = statsStart === todayStr() && statsEnd === todayStr();

  // Weekly report data for export
  const { weeks, collections, callVolume, conversion, reps, dispoByRep, accountsByRepWeek } = perfData || {};
  const weekCount = weeks?.length || 0;

  // Calls Made data
  const allCallReps = callsData ? Object.keys(callsData).filter(isCsRep).sort() : [];
  const totalCalls = allCallReps.reduce((s, r) => s + (callsData?.[r] || 0), 0);

  const dateInputStyle: React.CSSProperties = {
    background: C.input, color: C.text, border: `1px solid ${C.border}`,
    borderRadius: 4, padding: "4px 8px", fontSize: 12, fontFamily: FONT,
  };

  const quickBtnStyle: React.CSSProperties = {
    background: "transparent", color: C.teal, border: `1px solid ${C.teal}`,
    borderRadius: 4, padding: "4px 10px", fontSize: 11, fontWeight: 700,
    cursor: "pointer", fontFamily: FONT,
  };

  // Stats from daily-stats API
  const byRep = statsData?.byRep || {};
  const totals = statsData?.totals || {};
  const statsReps = (statsData?.reps || []).filter((r: string) => isCsRep(r));

  // ── Export Weekly Report CSV ──
  const exportCSV = () => {
    if (!perfData) return;
    setExporting(true);
    try {
      const csvRows: string[][] = [];
      const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

      // Section 1: Collections WoW
      csvRows.push(["COLLECTIONS — WEEK OVER WEEK"]);
      csvRows.push(["Rep", ...(weeks || []).flatMap((w: string) => [`${w} Coll`, `${w} 0-Pay`, `${w} Amt`])]);
      for (const rep of reps || []) {
        const rd = collections?.byRep?.[rep] || [];
        const vals: (string | number)[] = [rep];
        for (let wi = 0; wi < weekCount; wi++) {
          const d = rd[wi] || { collections: 0, zeroPays: 0, amtCollected: 0 };
          vals.push(d.collections, d.zeroPays, d.amtCollected.toFixed(2));
        }
        csvRows.push(vals.map(v => String(v)));
      }
      const totVals: (string | number)[] = ["TOTAL"];
      for (const t of collections?.totals || []) { totVals.push(t.collections, t.zeroPays, t.amtCollected.toFixed(2)); }
      csvRows.push(totVals.map(v => String(v)));
      csvRows.push([]);

      // Section 2: Outbound Calls by Rep
      csvRows.push(["OUTBOUND CALLS BY REP — WEEK OVER WEEK"]);
      csvRows.push(["Rep", ...(weeks || []), "Total"]);
      const mtdOutbound = (callVolume?.outboundTotals || []).reduce((s: number, n: number) => s + n, 0);
      for (const [agent, weekCounts] of Object.entries(callVolume?.outboundByRep || {}).sort(([a], [b]) => a.localeCompare(b))) {
        const counts = weekCounts as number[];
        const total = counts.reduce((s, n) => s + n, 0);
        if (total > 0) csvRows.push([agent, ...counts.map(String), String(total)]);
      }
      csvRows.push(["TOTAL", ...(callVolume?.outboundTotals || []).map(String), String(mtdOutbound)]);
      csvRows.push([]);

      // Section 3: Inbound Calls
      csvRows.push(["INBOUND CALLS — WEEK OVER WEEK"]);
      csvRows.push(["Metric", ...(weeks || [])]);
      csvRows.push(["Total Calls", ...(callVolume?.inboundTotals || []).map((d: { total: number }) => String(d.total))]);
      csvRows.push(["Dropped", ...(callVolume?.inboundTotals || []).map((d: { dropped: number }) => String(d.dropped))]);
      csvRows.push(["Drop Rate %", ...(callVolume?.inboundTotals || []).map((d: { total: number; dropped: number }) =>
        d.total > 0 ? ((d.dropped / d.total) * 100).toFixed(1) + "%" : "0%"
      )]);
      csvRows.push([]);

      // Section 4: Conversion %
      csvRows.push(["CONVERSION % — WEEK OVER WEEK"]);
      csvRows.push(["Rep", ...(weeks || [])]);
      for (const rep of reps || []) {
        const pcts = conversion?.byRep?.[rep] || [];
        csvRows.push([rep, ...Array.from({ length: weekCount }).map((_, wi) => {
          const p = pcts[wi] || 0;
          return p > 0 ? (p * 100).toFixed(1) + "%" : "0%";
        })]);
      }
      csvRows.push([]);

      // Section 5: Full Disposition Breakdown
      csvRows.push(["DISPOSITION BREAKDOWN — MTD"]);
      const allDispos = new Set<string>();
      for (const rep of reps || []) { for (const k of Object.keys(dispoByRep?.[rep] || {})) allDispos.add(k); }
      const dispoList = [...allDispos].sort();
      csvRows.push(["Rep", ...dispoList, "Total"]);
      for (const rep of reps || []) {
        const d = dispoByRep?.[rep] || {};
        const total = Object.values(d as Record<string, number>).reduce((s: number, v: number) => s + v, 0);
        csvRows.push([rep, ...dispoList.map(k => String((d as Record<string, number>)[k] || 0)), String(total)]);
      }
      csvRows.push([]);

      // Section 6: Account Totals
      if (accountsByRepWeek) {
        csvRows.push(["ACCOUNTS ASSIGNED — WEEK OVER WEEK"]);
        csvRows.push(["Rep", ...(weeks || [])]);
        for (const rep of reps || []) {
          const wk = accountsByRepWeek[rep] || [];
          csvRows.push([rep, ...Array.from({ length: weekCount }).map((_, wi) => String(wk[wi] || 0))]);
        }
      }

      const csv = csvRows.map(r => r.map(esc).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `CS_Weekly_Report_${perfMonth}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      {/* Header: Title + Export + Manage Reps */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Collections Performance</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <input type="month" value={perfMonth} onChange={(e) => setPerfMonth(e.target.value)} style={dateInputStyle} />
          <button
            onClick={exportCSV}
            disabled={exporting || !perfData}
            style={{
              background: C.teal, color: "#000", border: "none", borderRadius: 8,
              padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
              opacity: exporting || !perfData ? 0.6 : 1,
            }}
          >
            {exporting ? "Exporting..." : "Export Weekly Report"}
          </button>
          <button
            onClick={onManageReps}
            style={{
              background: C.card,
              color: C.secondary,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: FONT,
              cursor: "pointer",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.teal; e.currentTarget.style.color = C.text; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.secondary; }}
          >
            &#9881; Manage Reps
          </button>
        </div>
      </div>

      {/* ═══ COLLECTIONS STATS — DATE RANGE ═══ */}
      <SectionHeader>COLLECTIONS STATS</SectionHeader>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <button onClick={setToday} style={quickBtnStyle}>Today</button>
        <button onClick={setMTD} style={quickBtnStyle}>MTD</button>
        {statsLoading && <span style={{ fontSize: 11, color: C.muted }}>Loading...</span>}
      </div>

      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#1a365d" }}>
              <WTh style={{ textAlign: "left", minWidth: 140, color: "#fff" }}>Rep</WTh>
              <WTh style={{ color: "#fff" }}>Collection</WTh>
              <WTh style={{ color: "#fff" }}>0Pay</WTh>
              <WTh style={{ color: "#fff" }}>PIF (2 pmts+)</WTh>
              <WTh style={{ color: "#fff" }}>Chargeback</WTh>
              <WTh style={{ color: "#fff" }}>Amt Collected</WTh>
              <WTh style={{ color: "#fff" }}>Sold</WTh>
              <WTh style={{ color: "#fff" }}>DP Amount Collected</WTh>
              <WTh style={{ color: "#fff" }}>Total</WTh>
            </tr>
          </thead>
          <tbody>
            {statsReps.map((rep: string) => {
              const d = byRep[rep] || {};
              return (
                <tr key={rep}>
                  <WTd style={{ textAlign: "left", fontWeight: 600 }}>{rep}</WTd>
                  <WTd style={{ color: d.collections > 0 ? C.green : C.muted }}>{d.collections || 0}</WTd>
                  <WTd style={{ color: d.zero_pays > 0 ? C.amber : C.muted }}>{d.zero_pays || 0}</WTd>
                  <WTd style={{ color: d.pif > 0 ? C.text : C.muted }}>{d.pif || 0}</WTd>
                  <WTd style={{ color: d.chargebacks > 0 ? C.red : C.muted }}>{d.chargebacks || 0}</WTd>
                  <WTd>{d.amt_collected > 0 ? fmtMoney(d.amt_collected) : "$0.00"}</WTd>
                  <WTd style={{ color: d.sold > 0 ? C.green : C.muted }}>{d.sold || 0}</WTd>
                  <WTd>{d.dp_amt_collected > 0 ? fmtMoney(d.dp_amt_collected) : "$0.00"}</WTd>
                  <WTd style={{ fontWeight: 700, color: d.total > 0 ? C.text : C.muted }}>{d.total || 0}</WTd>
                </tr>
              );
            })}
            {/* Totals row */}
            {statsReps.length > 0 && (
              <tr style={{ background: "rgba(16,185,129,0.08)" }}>
                <WTd style={{ textAlign: "left", fontWeight: 800, color: C.teal }}>Total</WTd>
                <WTd style={{ fontWeight: 700, color: C.green }}>{totals.collections || 0}</WTd>
                <WTd style={{ fontWeight: 700, color: C.amber }}>{totals.zero_pays || 0}</WTd>
                <WTd style={{ fontWeight: 700 }}>{totals.pif || 0}</WTd>
                <WTd style={{ fontWeight: 700, color: totals.chargebacks > 0 ? C.red : C.muted }}>{totals.chargebacks || 0}</WTd>
                <WTd style={{ fontWeight: 700, color: C.green }}>{fmtMoney(totals.amt_collected || 0)}</WTd>
                <WTd style={{ fontWeight: 700 }}>{totals.sold || 0}</WTd>
                <WTd style={{ fontWeight: 700 }}>{fmtMoney(totals.dp_amt_collected || 0)}</WTd>
                <WTd style={{ fontWeight: 800, color: C.teal }}>{totals.total || 0}</WTd>
              </tr>
            )}
            {statsReps.length === 0 && !statsLoading && (
              <tr><WTd colSpan={9} style={{ textAlign: "center", color: C.muted, padding: 20 }}>
                No stats data for this date range. Run a sync first.
              </WTd></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ═══ CALLS MADE — CUSTOM DATE RANGE ═══ */}
      <SectionHeader>CALLS MADE BY REP</SectionHeader>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: C.muted }}>{isToday ? "Today" : "MTD"}</span>
        {callsLoading && <span style={{ fontSize: 11, color: C.muted }}>Loading...</span>}
      </div>
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left", minWidth: 140 }}>Rep</WTh>
              <WTh>Calls Made</WTh>
            </tr>
          </thead>
          <tbody>
            {callsData && allCallReps.map((rep) => (
              <tr key={rep}>
                <WTd style={{ textAlign: "left", fontWeight: 600 }}>{rep}</WTd>
                <WTd style={{ color: callsData[rep] > 0 ? C.text : C.muted }}>{fmt(callsData[rep])}</WTd>
              </tr>
            ))}
            {callsData && (
              <tr style={{ background: "rgba(20,184,166,0.06)" }}>
                <WTd style={{ textAlign: "left", fontWeight: 800, color: C.teal }}>TOTAL</WTd>
                <WTd style={{ fontWeight: 700, color: C.teal }}>{fmt(totalCalls)}</WTd>
              </tr>
            )}
            {!callsData && !callsLoading && (
              <tr><WTd colSpan={2} style={{ textAlign: "center", color: C.muted }}>No data</WTd></tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   REP SCHEDULE TAB
   ══════════════════════════════════════════════════════════════════════════════ */
function ScheduleTab({
  schedule,
  setSchedule,
  saveSchedule,
}: {
  schedule: RepScheduleEntry[];
  setSchedule: (s: RepScheduleEntry[]) => void;
  saveSchedule: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!loaded) {
      fetch(`/api/cs/reps?action=schedule&date=${todayStr()}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) setSchedule(d.schedule.map((s: RepScheduleEntry) => ({
            ...s,
            zero_pay_pct: parseFloat(String(s.zero_pay_pct)) || 0,
            non_zero_pay_pct: parseFloat(String(s.non_zero_pay_pct)) || 0,
          })));
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [loaded, setSchedule]);

  // Auto-balance percentages evenly among working reps
  const autoBalance = (sched: RepScheduleEntry[]): RepScheduleEntry[] => {
    const working = sched.filter(s => s.is_working);
    if (working.length === 0) return sched.map(s => ({ ...s, zero_pay_pct: 0, non_zero_pay_pct: 0 }));
    const evenPct = Math.round((100 / working.length) * 10) / 10;
    return sched.map(s => ({
      ...s,
      zero_pay_pct: s.is_working ? evenPct : 0,
      non_zero_pay_pct: s.is_working ? evenPct : 0,
    }));
  };

  const toggleRep = (id: number) => {
    const updated = schedule.map((s) =>
      s.id === id ? { ...s, is_working: !s.is_working } : s
    );
    // Auto-balance when toggling
    setSchedule(autoBalance(updated));
    setSaved(false);
  };

  const updatePct = (id: number, field: "zero_pay_pct" | "non_zero_pay_pct", value: number) => {
    setSchedule(schedule.map(s => s.id === id ? { ...s, [field]: value } : s));
    setSaved(false);
  };

  const handleSave = async () => {
    await saveSchedule();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const workingReps = schedule.filter(s => s.is_working);
  const workingCount = workingReps.length;

  // Sum percentages for validation
  const zeroPayTotal = workingReps.reduce((s, r) => s + r.zero_pay_pct, 0);
  const nonZeroPayTotal = workingReps.reduce((s, r) => s + r.non_zero_pay_pct, 0);
  const zeroPayOk = Math.abs(zeroPayTotal - 100) < 1;
  const nonZeroPayOk = Math.abs(nonZeroPayTotal - 100) < 1;

  const pctInputStyle: React.CSSProperties = {
    width: 56,
    padding: "4px 6px",
    borderRadius: 4,
    border: `1px solid ${C.border}`,
    background: C.input,
    color: C.text,
    fontSize: 12,
    textAlign: "right" as const,
    fontFamily: FONT,
  };

  return (
    <div style={{ maxWidth: 700 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Rep Schedule for {todayStr()}
      </h3>
      <p style={{ fontSize: 12, color: C.secondary, marginBottom: 12, marginTop: 0 }}>
        {workingCount}/{schedule.length} working &mdash; Set the percentage of 0-pay and non-0-pay accounts each rep receives
      </p>

      <div
        style={{
          background: C.card,
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <Th>Rep</Th>
              <Th style={{ textAlign: "center", width: 70 }}>Working</Th>
              <Th style={{ textAlign: "center" }}>0-Pay %</Th>
              <Th style={{ textAlign: "center" }}>Non-0-Pay %</Th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((s, i) => (
              <tr
                key={s.id}
                style={{
                  background: i % 2 === 1 ? "rgba(255,255,255,0.02)" : "transparent",
                  opacity: s.is_working ? 1 : 0.4,
                }}
              >
                <Td style={{ fontWeight: 600 }}>{s.name}</Td>
                <Td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={s.is_working}
                    onChange={() => toggleRep(s.id)}
                    style={{ cursor: "pointer", width: 16, height: 16 }}
                  />
                </Td>
                <Td style={{ textAlign: "center" }}>
                  {s.is_working ? (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={s.zero_pay_pct}
                      onChange={(e) => updatePct(s.id, "zero_pay_pct", parseFloat(e.target.value) || 0)}
                      style={pctInputStyle}
                    />
                  ) : (
                    <span style={{ color: C.muted }}>—</span>
                  )}
                </Td>
                <Td style={{ textAlign: "center" }}>
                  {s.is_working ? (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={s.non_zero_pay_pct}
                      onChange={(e) => updatePct(s.id, "non_zero_pay_pct", parseFloat(e.target.value) || 0)}
                      style={pctInputStyle}
                    />
                  ) : (
                    <span style={{ color: C.muted }}>—</span>
                  )}
                </Td>
              </tr>
            ))}
            {/* Totals row */}
            <tr style={{ borderTop: `2px solid ${C.border}` }}>
              <Td style={{ fontWeight: 700, fontSize: 11 }}>TOTAL</Td>
              <Td>{""}</Td>
              <Td style={{ textAlign: "center", fontWeight: 700, color: zeroPayOk ? C.green : C.red }}>
                {zeroPayTotal.toFixed(1)}%
              </Td>
              <Td style={{ textAlign: "center", fontWeight: 700, color: nonZeroPayOk ? C.green : C.red }}>
                {nonZeroPayTotal.toFixed(1)}%
              </Td>
            </tr>
          </tbody>
        </table>
      </div>

      {(!zeroPayOk || !nonZeroPayOk) && workingCount > 0 && (
        <p style={{ fontSize: 11, color: C.amber, marginTop: 8, marginBottom: 0 }}>
          Percentages should total 100%. Distribution will normalize automatically but uneven totals may cause unexpected splits.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button
          onClick={() => { setSchedule(autoBalance(schedule.map(s => ({ ...s, is_working: true })))); setSaved(false); }}
          style={{
            padding: "6px 16px",
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: "transparent",
            color: C.secondary,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: FONT,
          }}
        >
          All On
        </button>
        <button
          onClick={() => { setSchedule(schedule.map(s => ({ ...s, is_working: false, zero_pay_pct: 0, non_zero_pay_pct: 0 }))); setSaved(false); }}
          style={{
            padding: "6px 16px",
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: "transparent",
            color: C.secondary,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: FONT,
          }}
        >
          All Off
        </button>
        <button
          onClick={() => { setSchedule(autoBalance(schedule)); setSaved(false); }}
          style={{
            padding: "6px 16px",
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: "transparent",
            color: C.amber,
            fontSize: 12,
            cursor: "pointer",
            fontFamily: FONT,
          }}
        >
          Even Split
        </button>
        <button
          onClick={handleSave}
          style={{
            padding: "6px 16px",
            borderRadius: 6,
            border: "none",
            background: saved ? C.green : C.teal,
            color: "#000",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: FONT,
            marginLeft: "auto",
            transition: "background 0.2s",
          }}
        >
          {saved ? "Saved!" : "Save Schedule"}
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MANAGE REPS MODAL
   ══════════════════════════════════════════════════════════════════════════════ */
function ManageRepsModal({
  schedule,
  setSchedule,
  saveSchedule,
  file,
  setFile,
  uploading,
  scrubResult,
  handleScrub,
  onClose,
}: {
  schedule: RepScheduleEntry[];
  setSchedule: (s: RepScheduleEntry[]) => void;
  saveSchedule: () => void;
  file: File | null;
  setFile: (f: File | null) => void;
  uploading: boolean;
  scrubResult: ScrubSummary | null;
  handleScrub: () => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<"schedule" | "upload">("schedule");

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "60px 20px 20px",
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.bg,
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          maxWidth: 820,
          width: "100%",
          maxHeight: "90vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: `linear-gradient(135deg, ${C.tealDark} 0%, ${C.bg} 100%)`,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>Manage Reps</h2>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              color: C.secondary,
              borderRadius: 6,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: FONT,
            }}
          >
            Close
          </button>
        </div>

        {/* Section toggle */}
        <div style={{ padding: "12px 20px 0", display: "flex", gap: 6 }}>
          <button
            onClick={() => setSection("schedule")}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: FONT,
              cursor: "pointer",
              background: section === "schedule" ? C.teal : "transparent",
              color: section === "schedule" ? "#000" : C.secondary,
            }}
          >
            Schedule & Distribution
          </button>
          <button
            onClick={() => setSection("upload")}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: FONT,
              cursor: "pointer",
              background: section === "upload" ? C.teal : "transparent",
              color: section === "upload" ? "#000" : C.secondary,
            }}
          >
            Upload PBS Report
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: "auto", flex: 1 }}>
          {section === "schedule" && (
            <ScheduleTab
              schedule={schedule}
              setSchedule={setSchedule}
              saveSchedule={saveSchedule}
            />
          )}
          {section === "upload" && (
            <UploadTab
              file={file}
              setFile={setFile}
              schedule={schedule}
              setSchedule={setSchedule}
              uploading={uploading}
              scrubResult={scrubResult}
              handleScrub={handleScrub}
              saveSchedule={saveSchedule}
            />
          )}
        </div>
      </div>
    </div>
  );
}
