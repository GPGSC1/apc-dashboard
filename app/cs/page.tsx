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
const TABS = ["Work List", "Upload & Scrub", "Performance", "Rep Schedule"] as const;
type TabName = (typeof TABS)[number];

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════════════════ */
export default function CSPage() {
  const [tab, setTab] = useState<TabName>("Work List");
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

  // Fetch accounts on date/rep change
  useEffect(() => {
    if (tab === "Work List") fetchAccounts();
  }, [tab, fetchAccounts]);

  // Fetch schedule when upload tab activates
  useEffect(() => {
    if (tab === "Upload & Scrub") {
      fetch(`/api/cs/reps?action=schedule&date=${todayStr()}`)
        .then((r) => r.json())
        .then((d) => { if (d.ok) setSchedule(d.schedule); })
        .catch(() => {});
    }
  }, [tab]);

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
          setTab("Work List");
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
    const repSchedule = schedule.map((s) => ({ repId: s.id, isWorking: s.is_working }));
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

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.text }}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a href="/" style={{ color: C.muted, textDecoration: "none", fontSize: 13 }}>
            &larr; Home
          </a>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>CS Collections</h1>
          {upload && (
            <span style={{ fontSize: 11, color: C.muted }}>
              Last scrub: {new Date(upload.uploaded_at).toLocaleString()} ({fmt(upload.final_row_count)} accounts)
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: FONT,
                cursor: "pointer",
                background: tab === t ? C.teal : "transparent",
                color: tab === t ? "#000" : C.secondary,
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* ── Error Banner ────────────────────────────────────────────────────── */}
      {error && (
        <div
          style={{
            margin: "8px 24px",
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
      )}

      {/* ── Tab Content ─────────────────────────────────────────────────────── */}
      <div style={{ padding: "16px 24px" }}>
        {tab === "Work List" && (
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
          />
        )}
        {tab === "Upload & Scrub" && (
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
        {tab === "Performance" && <PerformanceTab perfData={perfData} perfMonth={perfMonth} setPerfMonth={setPerfMonth} />}
        {tab === "Rep Schedule" && (
          <ScheduleTab schedule={schedule} setSchedule={setSchedule} saveSchedule={saveSchedule} />
        )}
      </div>
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
}) {
  const [sortCol, setSortCol] = useState<string>("assigned_rep");
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  const sorted = [...accounts].sort((a, b) => {
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

  return (
    <>
      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <label style={{ fontSize: 11, color: C.muted, marginRight: 6 }}>Date:</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{
              background: C.input,
              color: C.text,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 12,
              fontFamily: FONT,
            }}
          />
        </div>
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
          {fmt(accounts.length)} accounts
          {carryoverCount > 0 && (
            <span style={{ color: C.teal, marginLeft: 8 }}>({carryoverCount} carry-overs)</span>
          )}
        </div>
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
                  <Td style={{ fontSize: 11, fontFamily: "monospace" }}>{a.account_number}</Td>
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

function WTh({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{
      padding: "6px 8px", textAlign: "right", fontWeight: 700, fontSize: 10,
      color: C.secondary, borderBottom: `1px solid ${C.border}`,
      whiteSpace: "nowrap", ...style,
    }}>
      {children}
    </th>
  );
}

function WTd({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td style={{
      padding: "5px 8px", fontSize: 12, color: C.text,
      borderBottom: `1px solid ${C.border}`, textAlign: "right",
      whiteSpace: "nowrap", ...style,
    }}>
      {children}
    </td>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PerformanceTab({ perfData, perfMonth, setPerfMonth }: { perfData: any; perfMonth: string; setPerfMonth: (m: string) => void }) {
  if (!perfData) return <div style={{ padding: 40, textAlign: "center", color: C.muted }}>Loading weekly report...</div>;

  const { weeks, collections, callVolume, conversion, retention, reps, dispoByRep } = perfData;
  const weekCount = weeks?.length || 0;

  const pctStr = (n: number) => n > 0 ? (n * 100).toFixed(1) + "%" : "--";

  return (
    <div>
      {/* Month Selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>CS Weekly Report</h2>
        <input
          type="month"
          value={perfMonth}
          onChange={(e) => setPerfMonth(e.target.value)}
          style={{
            background: C.input, color: C.text, border: `1px solid ${C.border}`,
            borderRadius: 4, padding: "4px 8px", fontSize: 12, fontFamily: FONT,
          }}
        />
      </div>

      {/* ═══ COLLECTIONS — WEEK OVER WEEK ═══ */}
      <SectionHeader>COLLECTIONS — WEEK OVER WEEK</SectionHeader>
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}` }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left", minWidth: 120 }}>Rep</WTh>
              {weeks?.map((w: string, i: number) => (
                <WTh key={i} colSpan={3} style={{ textAlign: "center", borderLeft: `1px solid ${C.border}` }}>{w}</WTh>
              ))}
            </tr>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left" }}></WTh>
              {weeks?.map((_: string, i: number) => (
                <React.Fragment key={i}>
                  <WTh style={{ borderLeft: `1px solid ${C.border}` }}>Coll</WTh>
                  <WTh>0 Pay</WTh>
                  <WTh>Amt $</WTh>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {(reps || []).map((rep: string) => {
              const repData = collections?.byRep?.[rep] || [];
              return (
                <tr key={rep}>
                  <WTd style={{ textAlign: "left", fontWeight: 600 }}>{rep}</WTd>
                  {Array.from({ length: weekCount }).map((_, wi) => {
                    const d = repData[wi] || { collections: 0, zeroPays: 0, amtCollected: 0 };
                    return (
                      <React.Fragment key={wi}>
                        <WTd style={{ borderLeft: `1px solid ${C.border}`, color: d.collections > 0 ? C.green : C.muted }}>
                          {d.collections || "--"}
                        </WTd>
                        <WTd style={{ color: d.zeroPays > 0 ? C.amber : C.muted }}>{d.zeroPays || "--"}</WTd>
                        <WTd>{d.amtCollected > 0 ? fmtMoney(d.amtCollected) : "--"}</WTd>
                      </React.Fragment>
                    );
                  })}
                </tr>
              );
            })}
            {/* Totals row */}
            <tr style={{ background: "rgba(20,184,166,0.06)" }}>
              <WTd style={{ textAlign: "left", fontWeight: 800, color: C.teal }}>TOTAL</WTd>
              {(collections?.totals || []).map((t: { collections: number; zeroPays: number; amtCollected: number }, wi: number) => (
                <React.Fragment key={wi}>
                  <WTd style={{ borderLeft: `1px solid ${C.border}`, fontWeight: 700, color: C.teal }}>{t.collections}</WTd>
                  <WTd style={{ fontWeight: 700, color: C.amber }}>{t.zeroPays}</WTd>
                  <WTd style={{ fontWeight: 700 }}>{fmtMoney(t.amtCollected)}</WTd>
                </React.Fragment>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* ═══ CALL VOLUME — WEEK OVER WEEK ═══ */}
      <SectionHeader>CALL VOLUME — WEEK OVER WEEK</SectionHeader>

      {/* Outbound Summary */}
      <div style={{ fontSize: 12, fontWeight: 700, color: C.secondary, marginBottom: 6 }}>Outbound Collections Calls</div>
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left", minWidth: 120 }}>Metric</WTh>
              {weeks?.map((w: string, i: number) => <WTh key={i}>{w}</WTh>)}
            </tr>
          </thead>
          <tbody>
            <tr>
              <WTd style={{ textAlign: "left", fontWeight: 600 }}>Total Calls</WTd>
              {(callVolume?.outboundTotals || []).map((n: number, i: number) => (
                <WTd key={i}>{n > 0 ? fmt(n) : "--"}</WTd>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Inbound Summary */}
      <div style={{ fontSize: 12, fontWeight: 700, color: C.secondary, marginBottom: 6 }}>Inbound Collections Calls</div>
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left", minWidth: 120 }}>Metric</WTh>
              {weeks?.map((w: string, i: number) => <WTh key={i}>{w}</WTh>)}
            </tr>
          </thead>
          <tbody>
            <tr>
              <WTd style={{ textAlign: "left", fontWeight: 600 }}>Total Calls</WTd>
              {(callVolume?.inboundTotals || []).map((d: { total: number }, i: number) => (
                <WTd key={i}>{d.total > 0 ? fmt(d.total) : "--"}</WTd>
              ))}
            </tr>
            <tr>
              <WTd style={{ textAlign: "left", fontWeight: 600 }}>Dropped Calls</WTd>
              {(callVolume?.inboundTotals || []).map((d: { dropped: number }, i: number) => (
                <WTd key={i} style={{ color: d.dropped > 0 ? C.red : C.muted }}>{d.dropped > 0 ? fmt(d.dropped) : "--"}</WTd>
              ))}
            </tr>
            <tr>
              <WTd style={{ textAlign: "left", fontWeight: 600 }}>Drop Rate %</WTd>
              {(callVolume?.inboundTotals || []).map((d: { total: number; dropped: number }, i: number) => (
                <WTd key={i} style={{ color: d.total > 0 && (d.dropped / d.total) > 0.1 ? C.red : C.text }}>
                  {d.total > 0 ? ((d.dropped / d.total) * 100).toFixed(1) + "%" : "--"}
                </WTd>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Outbound Calls by Rep */}
      <div style={{ fontSize: 12, fontWeight: 700, color: C.secondary, marginBottom: 6 }}>Outbound Calls by Rep</div>
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left", minWidth: 120 }}>Rep</WTh>
              {weeks?.map((w: string, i: number) => <WTh key={i}>{w}</WTh>)}
              <WTh>Total</WTh>
            </tr>
          </thead>
          <tbody>
            {Object.entries(callVolume?.outboundByRep || {}).sort(([a], [b]) => a.localeCompare(b)).map(([agent, weekCounts]) => {
              const counts = weekCounts as number[];
              const total = counts.reduce((s, n) => s + n, 0);
              if (total === 0) return null;
              return (
                <tr key={agent}>
                  <WTd style={{ textAlign: "left", fontWeight: 600 }}>{agent}</WTd>
                  {counts.map((n: number, i: number) => (
                    <WTd key={i}>{n > 0 ? fmt(n) : "--"}</WTd>
                  ))}
                  <WTd style={{ fontWeight: 700 }}>{fmt(total)}</WTd>
                </tr>
              );
            })}
            <tr style={{ background: "rgba(20,184,166,0.06)" }}>
              <WTd style={{ textAlign: "left", fontWeight: 800, color: C.teal }}>TOTAL</WTd>
              {(callVolume?.outboundTotals || []).map((n: number, i: number) => (
                <WTd key={i} style={{ fontWeight: 700, color: C.teal }}>{n > 0 ? fmt(n) : "--"}</WTd>
              ))}
              <WTd style={{ fontWeight: 700, color: C.teal }}>
                {fmt((callVolume?.outboundTotals || []).reduce((s: number, n: number) => s + n, 0))}
              </WTd>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ═══ CONVERSION % — WEEK OVER WEEK ═══ */}
      <SectionHeader>CONVERSION % — WEEK OVER WEEK</SectionHeader>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>Collections / Outbound Calls</div>
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left", minWidth: 120 }}>Rep</WTh>
              {weeks?.map((w: string, i: number) => <WTh key={i}>{w}</WTh>)}
            </tr>
          </thead>
          <tbody>
            {(reps || []).map((rep: string) => {
              const pcts = conversion?.byRep?.[rep] || [];
              return (
                <tr key={rep}>
                  <WTd style={{ textAlign: "left", fontWeight: 600 }}>{rep}</WTd>
                  {Array.from({ length: weekCount }).map((_, wi) => {
                    const p = pcts[wi] || 0;
                    return (
                      <WTd key={wi} style={{ color: p >= 0.04 ? C.green : p >= 0.02 ? C.amber : p > 0 ? C.red : C.muted }}>
                        {pctStr(p)}
                      </WTd>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ═══ DEAL STATUS / RETENTION ═══ */}
      <SectionHeader>DEAL STATUS — WEEK OVER WEEK</SectionHeader>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>From Moxy deals (auto + home combined by sold date)</div>
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}`, marginBottom: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left", minWidth: 120 }}>Metric</WTh>
              {weeks?.map((w: string, i: number) => <WTh key={i}>{w}</WTh>)}
            </tr>
          </thead>
          <tbody>
            {[
              { label: "Active / Sold", key: "activeSold", color: C.green },
              { label: "Cancelled", key: "cancelled", color: C.red },
              { label: "Cancel POA", key: "cancelPOA", color: C.amber },
              { label: "Back Out", key: "backOut", color: C.red },
              { label: "Total Deals", key: "totalDeals", color: C.text },
            ].map(({ label, key, color }) => (
              <tr key={key}>
                <WTd style={{ textAlign: "left", fontWeight: 600 }}>{label}</WTd>
                {(retention || []).map((r: Record<string, number>, i: number) => (
                  <WTd key={i} style={{ color: r[key] > 0 ? color : C.muted }}>
                    {r[key] > 0 ? fmt(r[key]) : "--"}
                  </WTd>
                ))}
              </tr>
            ))}
            <tr>
              <WTd style={{ textAlign: "left", fontWeight: 600 }}>Cancel Rate</WTd>
              {(retention || []).map((r: { totalDeals: number; cancelled: number; cancelPOA: number }, i: number) => {
                const cancels = (r.cancelled || 0) + (r.cancelPOA || 0);
                const rate = r.totalDeals > 0 ? cancels / r.totalDeals : 0;
                return (
                  <WTd key={i} style={{ color: rate > 0.15 ? C.red : rate > 0.1 ? C.amber : C.green, fontWeight: 600 }}>
                    {r.totalDeals > 0 ? (rate * 100).toFixed(1) + "%" : "--"}
                  </WTd>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {/* ═══ DISPOSITION BREAKDOWN ═══ */}
      <SectionHeader>DISPOSITION BREAKDOWN — MTD</SectionHeader>
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}` }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: C.card }}>
              <WTh style={{ textAlign: "left", minWidth: 120 }}>Rep</WTh>
              {["Collected", "LVM", "No Voicemail", "VM Full", "Follow Up", "Sent Email", "PUHU", "Scheduled PDP", "Wrong #/NIS", "Sent To CS", "Other"].map(d => (
                <WTh key={d} style={{ fontSize: 9 }}>{d}</WTh>
              ))}
              <WTh>Total</WTh>
            </tr>
          </thead>
          <tbody>
            {(reps || []).map((rep: string) => {
              const d = dispoByRep?.[rep] || {};
              const namedDispos = ["Collected", "LVM", "No Voicemail", "VM Full", "Follow Up", "Sent Email", "PUHU", "Scheduled PDP", "Wrong #/NIS", "Sent To CS"];
              const other = Object.entries(d).filter(([k]) => !namedDispos.includes(k)).reduce((s, [, v]) => s + (v as number), 0);
              const total = Object.values(d).reduce((s, v) => s + (v as number), 0);
              return (
                <tr key={rep}>
                  <WTd style={{ textAlign: "left", fontWeight: 600 }}>{rep}</WTd>
                  {namedDispos.map(name => (
                    <WTd key={name} style={{ color: (d[name] || 0) > 0 ? (name === "Collected" ? C.green : C.text) : C.muted }}>
                      {d[name] || "--"}
                    </WTd>
                  ))}
                  <WTd style={{ color: other > 0 ? C.text : C.muted }}>{other || "--"}</WTd>
                  <WTd style={{ fontWeight: 700 }}>{total || "--"}</WTd>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ═══ FUTURE SECTIONS (Placeholders) ═══ */}
      {[
        "FUNDING BREAKDOWNS",
        "QA — COMPLIANCE",
        "MERCHANT INFORMATION — CHARGEBACKS",
        "BOUNCED ACH & WALCO RETURN PAYMENTS",
        "REFUNDS",
      ].map(title => (
        <div key={title}>
          <SectionHeader>{title}</SectionHeader>
          <div style={{
            padding: "20px 16px", background: C.card, borderRadius: 8,
            border: `1px dashed ${C.border}`, color: C.muted, fontSize: 12, textAlign: "center",
          }}>
            Coming soon — requires additional data source integration
          </div>
        </div>
      ))}
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

  useEffect(() => {
    if (!loaded) {
      fetch(`/api/cs/reps?action=schedule&date=${todayStr()}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) setSchedule(d.schedule);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [loaded, setSchedule]);

  const toggleRep = (id: number) => {
    setSchedule(schedule.map((s) => (s.id === id ? { ...s, is_working: !s.is_working } : s)));
  };

  const workingCount = schedule.filter((s) => s.is_working).length;

  return (
    <div style={{ maxWidth: 400 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>
        Rep Schedule for {todayStr()} ({workingCount}/{schedule.length} working)
      </h3>
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
              <Th>Rep Name</Th>
              <Th style={{ textAlign: "center" }}>Working Today?</Th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((s, i) => (
              <tr
                key={s.id}
                style={{ background: i % 2 === 1 ? "rgba(255,255,255,0.02)" : "transparent" }}
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          onClick={() => setSchedule(schedule.map((s) => ({ ...s, is_working: true })))}
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
          onClick={() => setSchedule(schedule.map((s) => ({ ...s, is_working: false })))}
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
          onClick={saveSchedule}
          style={{
            padding: "6px 16px",
            borderRadius: 6,
            border: "none",
            background: C.teal,
            color: "#000",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: FONT,
            marginLeft: "auto",
          }}
        >
          Save Schedule
        </button>
      </div>
    </div>
  );
}
