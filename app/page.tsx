"use client";
import { useState, useEffect, useCallback, useRef } from "react";

interface ListStats { t: number; o: number; s: number; min: number; cost: number; listCost: number; }
interface AgentStats { calls: number; min: number; cost: number; t: number; deals: number; }
interface MatrixCell { t: number; o: number; d: number; }
interface DashData {
  byList: Record<string, ListStats>;
  byAgent: Record<string, AgentStats>;
  matrix: Record<string, Record<string, MatrixCell>>;
  nonListSales: NonListSale[];
  totalSales: number;
  listCosts: Record<string, number>;
  allLists: string[];
  allAgents: string[];
  loadedFiles: string[];
  lastUpdated: string;
  hasData: boolean;
  dataDateRange?: { min: string | null; max: string | null };
  error?: string;
}
interface AimData {
  ok: boolean;
  byList: Record<string, { t: number; min: number; cost: number; listCost: number }>;
  byAgent: Record<string, { t: number; min: number; cost: number }>;
  lastUpdated: string;
}
interface NonListSale {
  firstName: string; lastName: string; soldDate: string;
  promoCode: string; salesperson: string;
  homePhone: string; mobilePhone: string; onOpened: boolean;
}

type DatePreset = "itd" | "today" | "yesterday" | "week" | "custom";

function getPresetDates(preset: DatePreset): { start: string | null; end: string | null } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = iso(now);
  if (preset === "itd") return { start: null, end: null };
  if (preset === "today") return { start: today, end: today };
  if (preset === "yesterday") { const y = new Date(now); y.setDate(y.getDate() - 1); return { start: iso(y), end: iso(y) }; }
  if (preset === "week") { const mon = new Date(now); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); return { start: iso(mon), end: today }; }
  return { start: null, end: null };
}

function daysPast7(start: string | null): number {
  if (!start) return 0;
  const campaignStart = new Date("2026-02-25");
  const startDate = new Date(start);
  const diffDays = Math.ceil((campaignStart.getTime() - startDate.getTime()) / 86400000);
  return Math.max(0, diffDays);
}

const DEMO: DashData = {
  byList: {
    RT:         { t:987, o:597, s:37, min:8200,  cost:1640, listCost:0     },
    JL021926LP: { t:208, o:124, s:6,  min:1750,  cost:350,  listCost:8000  },
    BL021926BO: { t:145, o:93,  s:4,  min:1200,  cost:240,  listCost:8000  },
    JH022326MN: { t:67,  o:38,  s:0,  min:580,   cost:116,  listCost:8000  },
    JL021926CR: { t:36,  o:15,  s:0,  min:310,   cost:62,   listCost:8000  },
    DG021726SC: { t:55,  o:24,  s:1,  min:460,   cost:92,   listCost:5000  },
    JL022526RS: { t:30,  o:12,  s:0,  min:260,   cost:52,   listCost:6000  },
  },
  byAgent: {
    "Moxy OG":   { calls:12400, min:9800, cost:1960, t:907, deals:15 },
    Activation:  { calls:2100,  min:1680, cost:336,  t:170, deals:9  },
    "Female v3": { calls:1400,  min:1120, cost:224,  t:112, deals:6  },
    "Moxy v2":   { calls:1050,  min:840,  cost:168,  t:84,  deals:4  },
    "Male v3":   { calls:930,   min:740,  cost:148,  t:74,  deals:3  },
  },
  matrix: {
    "Moxy OG":   { RT:{t:550,o:340,d:10},JL021926LP:{t:130,o:80,d:3},BL021926BO:{t:90,o:55,d:2},JH022326MN:{t:67,o:38,d:0},JL021926CR:{t:36,o:15,d:0},DG021726SC:{t:30,o:14,d:0},JL022526RS:{t:4,o:2,d:0}},
    Activation:  { RT:{t:100,o:60,d:4},JL021926LP:{t:45,o:25,d:2},BL021926BO:{t:0,o:0,d:0},JH022326MN:{t:0,o:0,d:0},JL021926CR:{t:0,o:0,d:0},DG021726SC:{t:25,o:10,d:1},JL022526RS:{t:0,o:0,d:0}},
    "Female v3": { RT:{t:85,o:52,d:3},JL021926LP:{t:27,o:16,d:2},BL021926BO:{t:0,o:0,d:0},JH022326MN:{t:0,o:0,d:0},JL021926CR:{t:0,o:0,d:0},DG021726SC:{t:0,o:0,d:1},JL022526RS:{t:0,o:0,d:0}},
    "Moxy v2":   { RT:{t:84,o:51,d:4},JL021926LP:{t:0,o:0,d:0},BL021926BO:{t:0,o:0,d:0},JH022326MN:{t:0,o:0,d:0},JL021926CR:{t:0,o:0,d:0},DG021726SC:{t:0,o:0,d:0},JL022526RS:{t:0,o:0,d:0}},
    "Male v3":   { RT:{t:68,o:42,d:2},JL021926LP:{t:6,o:3,d:1},BL021926BO:{t:0,o:0,d:0},JH022326MN:{t:0,o:0,d:0},JL021926CR:{t:0,o:0,d:0},DG021726SC:{t:0,o:0,d:0},JL022526RS:{t:0,o:0,d:0}},
  },
  nonListSales: [],
  totalSales: 48,
  listCosts: { RT:0,JL021926LP:8000,BL021926BO:8000,JH022326MN:8000,JL021926CR:8000,DG021726SC:5000,JL022526RS:6000 },
  allLists: ["RT","JL021926LP","BL021926BO","JH022326MN","JL021926CR","DG021726SC","JL022526RS"],
  allAgents: ["Moxy OG","Activation","Female v3","Moxy v2","Male v3"],
  loadedFiles: [],
  lastUpdated: new Date().toISOString(),
  hasData: false,
};

const f = (n: number) => (n || 0).toLocaleString();
const fc = (n: number) => "$" + (n || 0).toFixed(2);
const pct = (n: number, d: number) => d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "-";
const C = {
  bg: "#06080F", surface: "#0C0F1A", card: "#101525", border: "#1B2440",
  accent: "#00D4B8", amber: "#F59E0B", red: "#EF4444", green: "#22C55E",
  text: "#C8D6E8", muted: "#3D5275", dim: "#1E2D45",
};

function ClosePct({ n, d }: { n: number; d: number }) {
  const v = d > 0 ? (n / d) * 100 : 0;
  const color = v >= 5 ? C.green : v >= 3 ? C.amber : C.muted;
  return <span style={{ fontFamily: "monospace", fontSize: 12, color }}>{pct(n, d)}</span>;
}
function Th({ children, left }: { children: React.ReactNode; left?: boolean }) {
  return <th style={{ background: C.surface, color: C.muted, fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", padding: "9px 12px", textAlign: left ? "left" : "right", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{children}</th>;
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "8px 12px", textAlign: "right", fontSize: 13, borderBottom: `1px solid ${C.dim}`, ...style }}>{children}</td>;
}

function DateFilterBar({ preset, setPreset, customStart, setCustomStart, customEnd, setCustomEnd, onApply, onApplyWithPreset, dataRange, warnDays }: {
  preset: DatePreset; setPreset: (p: DatePreset) => void;
  customStart: string; setCustomStart: (s: string) => void;
  customEnd: string; setCustomEnd: (s: string) => void;
  onApply: () => void;
  onApplyWithPreset: (preset: DatePreset) => void;
  dataRange?: { min: string | null; max: string | null };
  warnDays: number;
}) {
  const presets: { id: DatePreset; label: string }[] = [
    { id: "itd", label: "ITD" }, { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" }, { id: "week", label: "This Week" },
    { id: "custom", label: "Custom" },
  ];

  // Format the display date range based on active preset
  const getDisplayRange = () => {
    if (preset === "custom") return customStart && customEnd ? `${customStart} to ${customEnd}` : null;
    const { start, end } = getPresetDates(preset);
    if (!start && !end) return "2026-02-25 to " + new Date().toISOString().slice(0, 10);
    return `${start} to ${end}`;
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: C.muted, letterSpacing: ".1em", textTransform: "uppercase", marginRight: 4 }}>Date Range:</span>
        {presets.map(p => (
          <button key={p.id} onClick={() => {
            setPreset(p.id);
            if (p.id !== "custom") onApplyWithPreset(p.id); // ← FIX: pass preset directly, no stale closure
          }}
            style={{ padding: "4px 12px", borderRadius: 4, border: `1px solid ${preset === p.id ? C.accent : C.dim}`, background: preset === p.id ? "rgba(0,212,184,.1)" : "transparent", color: preset === p.id ? C.accent : C.muted, cursor: "pointer", fontSize: 12, fontWeight: preset === p.id ? 600 : 400 }}>
            {p.label}
          </button>
        ))}
        {preset === "custom" && (
          <>
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
              style={{ padding: "3px 8px", borderRadius: 4, border: `1px solid ${C.dim}`, background: C.card, color: C.text, fontSize: 12 }} />
            <span style={{ color: C.muted, fontSize: 12 }}>to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
              style={{ padding: "3px 8px", borderRadius: 4, border: `1px solid ${C.dim}`, background: C.card, color: C.text, fontSize: 12 }} />
            <button onClick={onApply}
              style={{ padding: "4px 14px", borderRadius: 4, border: "none", background: C.accent, color: C.bg, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Apply</button>
          </>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: C.muted }}>Date: {getDisplayRange()}</span>
      </div>
      {warnDays > 0 && (
        <div style={{ padding: "8px 16px", background: "rgba(245,158,11,.08)", borderBottom: `1px solid rgba(245,158,11,.25)`, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14 }}>⚠️</span>
          <span style={{ fontSize: 12, color: C.amber }}>
            This date range may result in longer load times (~{warnDays * 2} min — 2 min per day past 7 days)
          </span>
        </div>
      )}
    </div>
  );
}

function ITDView({ data, showListCost }: { data: DashData; showListCost: boolean }) {
  const lists = data.allLists?.length ? data.allLists : Object.keys(data.byList);
  const totals = lists.reduce((a, li) => {
    const r = data.byList[li] || { t:0,o:0,s:0,min:0,cost:0,listCost:0 };
    return { t:a.t+r.t, o:a.o+r.o, s:a.s+r.s, min:a.min+r.min, cost:a.cost+r.cost, listCost: showListCost ? a.listCost+r.listCost : 0 };
  }, { t:0,o:0,s:0,min:0,cost:0,listCost:0 });
  const kpis = [
    { label: "Transfers", val: f(totals.t), color: C.accent },
    { label: "Opened", val: f(totals.o), color: C.text },
    { label: "Sales", val: f(totals.s), color: C.green },
    { label: "Close Rate", val: pct(totals.s, totals.o), color: C.amber },
    { label: "Minutes", val: f(Math.round(totals.min)), color: C.muted },
    { label: "Dial Cost", val: fc(totals.cost), color: C.muted },
  ];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 10, marginBottom: 20 }}>
        {kpis.map(k => (
          <div key={k.label} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 7, padding: "13px 15px" }}>
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontFamily: "monospace", fontSize: 22, color: k.color, fontWeight: "bold" }}>{k.val}</div>
          </div>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><Th left>List</Th>{showListCost && <Th>List Cost</Th>}<Th>Transfers</Th><Th>Opened</Th><Th>Sales</Th><Th>Close %</Th><Th>Minutes</Th><Th>Dial Cost</Th>{showListCost && <Th>Cost/Sale</Th>}</tr></thead>
          <tbody>
            {lists.map(li => {
              const r = data.byList[li] || { t:0,o:0,s:0,min:0,cost:0,listCost:0 };
              const cps = r.s > 0 ? (r.listCost + r.cost) / r.s : null;
              return (
                <tr key={li}>
                  <Td style={{ textAlign: "left" }}><span style={{ color: C.accent, fontWeight: 600, fontSize: 14 }}>{li}</span></Td>
                  {showListCost && <Td><span style={{ fontFamily: "monospace", color: r.listCost > 0 ? C.text : C.muted }}>{r.listCost > 0 ? fc(r.listCost) : "free"}</span></Td>}
                  <Td><span style={{ fontFamily: "monospace", color: C.accent }}>{f(r.t)}</span></Td>
                  <Td><span style={{ fontFamily: "monospace" }}>{f(r.o)}</span></Td>
                  <Td><span style={{ fontFamily: "monospace", color: r.s > 0 ? C.green : C.muted, fontWeight: r.s > 0 ? 600 : 400 }}>{r.s}</span></Td>
                  <Td><ClosePct n={r.s} d={r.o} /></Td>
                  <Td><span style={{ fontFamily: "monospace", color: C.muted }}>{f(Math.round(r.min))}</span></Td>
                  <Td><span style={{ fontFamily: "monospace", color: C.muted }}>{fc(r.cost)}</span></Td>
                  {showListCost && <Td>{cps ? <span style={{ fontFamily: "monospace", color: cps > 1000 ? C.red : cps > 500 ? C.amber : C.green }}>{fc(cps)}</span> : <span style={{ color: C.dim }}>-</span>}</Td>}
                </tr>
              );
            })}
            <tr style={{ background: C.surface, borderTop: `1px solid ${C.border}` }}>
              <Td style={{ textAlign: "left", fontWeight: 700, color: C.text }}>TOTAL</Td>
              {showListCost && <Td><span style={{ fontFamily: "monospace" }}>{fc(totals.listCost)}</span></Td>}
              <Td><span style={{ fontFamily: "monospace", color: C.accent, fontWeight: 600 }}>{f(totals.t)}</span></Td>
              <Td><span style={{ fontFamily: "monospace" }}>{f(totals.o)}</span></Td>
              <Td><span style={{ fontFamily: "monospace", color: C.green, fontWeight: 700 }}>{totals.s}</span></Td>
              <Td><ClosePct n={totals.s} d={totals.o} /></Td>
              <Td><span style={{ fontFamily: "monospace", color: C.muted }}>{f(Math.round(totals.min))}</span></Td>
              <Td><span style={{ fontFamily: "monospace", color: C.muted }}>{fc(totals.cost)}</span></Td>
              {showListCost && <Td>{totals.s > 0 ? <span style={{ fontFamily: "monospace", color: C.amber }}>{fc((totals.listCost + totals.cost) / totals.s)}</span> : <span style={{ color: C.dim }}>-</span>}</Td>}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatrixView({ data }: { data: DashData }) {
  const lists = data.allLists?.length ? data.allLists : Object.keys(data.byList);
  const agents = data.allAgents?.length ? data.allAgents : Object.keys(data.byAgent);
  return (
    <div>
      <div style={{ marginBottom: 10, fontSize: 11, color: C.muted }}>Each cell: <span style={{ color: C.accent }}>Transfers</span> / <span style={{ color: C.text }}>Opened</span> / <span style={{ color: C.green }}>Deals</span> / Close%</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><Th left>Agent</Th>{lists.map(li => <Th key={li}>{li}</Th>)}<Th>Tot. T</Th><Th>Tot. D</Th><Th>Close %</Th></tr></thead>
          <tbody>
            {agents.map(agent => {
              const m = data.matrix[agent] || {};
              let tT = 0, tD = 0, tO = 0;
              for (const li of lists) { const c = m[li] || {t:0,o:0,d:0}; tT+=c.t; tD+=c.d; tO+=c.o; }
              return (
                <tr key={agent} style={{ borderBottom: `1px solid ${C.dim}` }}>
                  <Td style={{ textAlign: "left", color: C.text, fontWeight: 600, fontSize: 13 }}>{agent}</Td>
                  {lists.map(li => {
                    const c = m[li] || {t:0,o:0,d:0};
                    if (!c.t && !c.o && !c.d) return <Td key={li} style={{ color: C.dim }}>-</Td>;
                    return (
                      <td key={li} style={{ padding: "5px 10px", textAlign: "right", borderBottom: `1px solid ${C.dim}` }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-end" }}>
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: C.accent }}>{f(c.t)}</span>
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: C.muted }}>{f(c.o)}</span>
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: c.d > 0 ? C.green : C.dim }}>{c.d}</span>
                          <span style={{ fontFamily: "monospace", fontSize: 10, color: c.d > 0 ? C.amber : C.dim }}>{pct(c.d, c.o)}</span>
                        </div>
                      </td>
                    );
                  })}
                  <Td><span style={{ fontFamily: "monospace", color: C.accent }}>{f(tT)}</span></Td>
                  <Td><span style={{ fontFamily: "monospace", color: tD > 0 ? C.green : C.muted, fontWeight: 600 }}>{tD}</span></Td>
                  <Td><ClosePct n={tD} d={tO} /></Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgentView({ data }: { data: DashData }) {
  const agents = data.allAgents?.length ? data.allAgents : Object.keys(data.byAgent);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><Th left>Agent</Th><Th>Calls</Th><Th>Minutes</Th><Th>Dial Cost</Th><Th>Transfers</Th><Th>Deals</Th><Th>Close %</Th><Th>Cost/Deal</Th></tr></thead>
        <tbody>
          {agents.map(agent => {
            const a = data.byAgent[agent] || { calls:0,min:0,cost:0,t:0,deals:0 };
            const cpd = a.deals > 0 ? a.cost / a.deals : null;
            return (
              <tr key={agent} style={{ borderBottom: `1px solid ${C.dim}` }}>
                <Td style={{ textAlign: "left", color: C.accent, fontWeight: 600, fontSize: 14 }}>{agent}</Td>
                <Td><span style={{ fontFamily: "monospace" }}>{f(a.calls)}</span></Td>
                <Td><span style={{ fontFamily: "monospace" }}>{f(Math.round(a.min))}</span></Td>
                <Td><span style={{ fontFamily: "monospace", color: C.muted }}>{fc(a.cost)}</span></Td>
                <Td><span style={{ fontFamily: "monospace", color: C.accent }}>{f(a.t)}</span></Td>
                <Td><span style={{ fontFamily: "monospace", color: a.deals > 0 ? C.green : C.muted, fontWeight: 600 }}>{a.deals}</span></Td>
                <Td><ClosePct n={a.deals} d={a.t} /></Td>
                <Td>{cpd ? <span style={{ fontFamily: "monospace", color: cpd > 200 ? C.red : cpd > 100 ? C.amber : C.green }}>{fc(cpd)}</span> : <span style={{ color: C.dim }}>-</span>}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NonListView({ data }: { data: DashData }) {
  const sales = data.nonListSales || [];
  if (!sales.length) return (
    <div style={{ padding: "40px 24px", textAlign: "center", color: C.muted }}>
      <div style={{ fontSize: 14 }}>No non-list sales detected</div>
    </div>
  );
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><Th left>Name</Th><Th>Date</Th><Th>Promo</Th><Th>Salesperson</Th><Th>Home #</Th><Th>Mobile #</Th><Th>On Opened</Th></tr></thead>
        <tbody>
          {sales.map((s, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${C.dim}` }}>
              <Td style={{ textAlign: "left", color: C.text }}>{s.firstName} {s.lastName}</Td>
              <Td><span style={{ fontFamily: "monospace", fontSize: 12, color: C.muted }}>{s.soldDate || "-"}</span></Td>
              <Td><span style={{ fontSize: 11, color: C.amber }}>{s.promoCode}</span></Td>
              <Td><span style={{ color: C.muted, fontSize: 12 }}>{s.salesperson}</span></Td>
              <Td><span style={{ fontFamily: "monospace", fontSize: 12, color: C.muted }}>{s.homePhone || "-"}</span></Td>
              <Td><span style={{ fontFamily: "monospace", fontSize: 12, color: C.muted }}>{s.mobilePhone || "-"}</span></Td>
              <Td style={{ textAlign: "center" }}>{s.onOpened ? <span style={{ color: C.green }}>Y</span> : <span style={{ color: C.dim }}>N</span>}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<DashData>(DEMO);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string>("");
  const [tab, setTab] = useState("itd");
  const [preset, setPreset] = useState<DatePreset>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeStart = preset === "custom" ? customStart : getPresetDates(preset).start;
  const warnDays = daysPast7(activeStart);

  const loadData = useCallback(async (start: string | null, end: string | null) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (start) qs.set("start", start);
      if (end) qs.set("end", end);
      const q = qs.toString() ? "?" + qs.toString() : "";

      const [fileRes, aimRes] = await Promise.allSettled([
        fetch(`/api/data${q}`).then(r => r.json()),
        fetch(`/api/aim${q}`).then(r => r.json()),
      ]);

      const fileData: DashData | null = fileRes.status === "fulfilled" && fileRes.value?.hasData ? fileRes.value : null;
      const aimData: AimData | null = aimRes.status === "fulfilled" && aimRes.value?.ok ? aimRes.value : null;

      if (!fileData && !aimData) { setIsLive(false); setData(DEMO); return; }

      const base: DashData = fileData || DEMO;

      if (aimData) {
        const allLists = base.allLists?.length ? base.allLists : Object.keys(base.byList);
        const newByList: Record<string, ListStats> = {};
        for (const li of allLists) {
          const fl = base.byList[li] || { t:0,o:0,s:0,min:0,cost:0,listCost:0 };
          const al = aimData.byList[li];
          newByList[li] = { ...fl, t: al?.t ?? fl.t, min: al?.min ?? fl.min, cost: al?.cost ?? fl.cost, listCost: al?.listCost ?? fl.listCost };
        }
        const allAgents = base.allAgents?.length ? base.allAgents : Object.keys(base.byAgent);
        const newByAgent: Record<string, AgentStats> = {};
        for (const ag of allAgents) {
          const fa = base.byAgent[ag] || { calls:0,min:0,cost:0,t:0,deals:0 };
          const aa = aimData.byAgent[ag];
          newByAgent[ag] = { ...fa, t: aa?.t ?? fa.t, min: aa?.min ?? fa.min, cost: aa?.cost ?? fa.cost };
        }
        for (const ag of Object.keys(aimData.byAgent)) {
          if (!newByAgent[ag]) { const a = aimData.byAgent[ag]; newByAgent[ag] = { calls:0, min:a.min, cost:a.cost, t:a.t, deals:0 }; }
        }
        setData({ ...base, byList: newByList, byAgent: newByAgent, lastUpdated: aimData.lastUpdated });
        setIsLive(true);
      } else {
        setData(base);
        setIsLive(!!fileData);
      }
      setLastRefresh(new Date().toLocaleTimeString());
    } catch { setIsLive(false); }
    finally { setLoading(false); }
  }, []);

  // FIX: handleApplyWithPreset accepts preset directly to avoid stale closure
  const handleApplyWithPreset = useCallback((newPreset: DatePreset) => {
    const { start, end } = getPresetDates(newPreset);
    loadData(start, end);
  }, [loadData]);

  const handleApply = useCallback(() => {
    const { start, end } = preset === "custom"
      ? { start: customStart || null, end: customEnd || null }
      : getPresetDates(preset);
    loadData(start, end);
  }, [preset, customStart, customEnd, loadData]);

  // Load today on mount (not ITD)
  useEffect(() => {
    const { start, end } = getPresetDates("today");
    loadData(start, end);
  }, [loadData]);

  // Auto-refresh every 15 min using current preset
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(handleApply, 15 * 60 * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [handleApply]);

  const tabs = [
    { id: "itd", label: "By List" }, { id: "matrix", label: "Agent x List" },
    { id: "agents", label: "Agent Summary" }, { id: "nonlist", label: "Non-List Sales" },
  ];
  const sideTotal = Object.values(data.byList).reduce((a, r) => a + (r.s || 0), 0);
  const lists = data.allLists?.length ? data.allLists : Object.keys(data.byList);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "13px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.accent, boxShadow: `0 0 10px ${C.accent}`, animation: "pulse 2s infinite" }} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, letterSpacing: ".06em", textTransform: "uppercase" }}>APC - AI Voice Agent Dashboard</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>Auto Protection Center · AIM Now / Moxy · AI-Attributed Sales Only</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {loading && <span style={{ fontSize: 11, color: C.muted, fontFamily: "monospace" }}>Loading...</span>}
          {!loading && lastRefresh && <span style={{ fontSize: 10, color: C.muted, fontFamily: "monospace" }}>↻ {lastRefresh}</span>}
          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", background: isLive ? "rgba(34,197,94,.12)" : "rgba(245,158,11,.12)", color: isLive ? C.green : C.amber, border: `1px solid ${isLive ? "rgba(34,197,94,.3)" : "rgba(245,158,11,.3)"}` }}>
            {isLive ? "Live Data" : "Demo Mode"}
          </span>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: C.muted }}>
            {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </span>
        </div>
      </div>

      <DateFilterBar
        preset={preset} setPreset={setPreset}
        customStart={customStart} setCustomStart={setCustomStart}
        customEnd={customEnd} setCustomEnd={setCustomEnd}
        onApply={handleApply}
        onApplyWithPreset={handleApplyWithPreset}
        dataRange={data.dataDateRange}
        warnDays={warnDays}
      />

      <div style={{ display: "flex", minHeight: "calc(100vh - 100px)" }}>
        <div style={{ width: 200, flexShrink: 0, background: C.surface, borderRight: `1px solid ${C.border}`, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 10, color: C.muted, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 2 }}>Data Sources</div>
          {[
            { label: "AIM Live API", live: isLive },
            { label: "sales.csv/xls", live: data.loadedFiles?.some(f => f.toLowerCase().startsWith("sales")) },
            { label: "opened.csv/xls", live: data.loadedFiles?.some(f => f.toLowerCase().startsWith("opened")) },
          ].map(item => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: C.card, borderRadius: 4, border: `1px solid ${item.live ? "rgba(34,197,94,.3)" : C.border}` }}>
              <span style={{ color: item.live ? C.green : C.dim, fontSize: 12 }}>{item.live ? "✓" : "○"}</span>
              <span style={{ fontSize: 11, color: item.live ? C.text : C.muted }}>{item.label}</span>
            </div>
          ))}

          <div style={{ fontSize: 10, color: C.muted, letterSpacing: ".12em", textTransform: "uppercase", marginTop: 8 }}>Lists</div>
          {lists.map(li => (
            <div key={li} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: C.card, borderRadius: 4, border: `1px solid ${isLive ? "rgba(0,212,184,.2)" : C.border}` }}>
              <span style={{ color: isLive ? C.accent : C.dim, fontSize: 12 }}>{isLive ? "✓" : "○"}</span>
              <span style={{ fontSize: 11, color: isLive ? C.accent : C.muted, fontWeight: isLive ? 600 : 400 }}>{li}</span>
            </div>
          ))}

          <button onClick={handleApply} style={{ marginTop: 8, padding: "9px 0", background: C.accent, color: C.bg, border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase" }}>
            ↻ Refresh
          </button>

          <div style={{ marginTop: "auto", paddingTop: 14, borderTop: `1px solid ${C.dim}` }}>
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 8 }}>Snapshot</div>
            {lists.map(li => {
              const r = data.byList[li] || { t: 0, s: 0 };
              return (
                <div key={li} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", borderBottom: `1px solid ${C.dim}` }}>
                  <span style={{ fontSize: 11, color: C.accent }}>{li}</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: C.muted }}>{r.t}T</span>
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: r.s > 0 ? C.green : C.dim }}>{r.s}S</span>
                  </span>
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6 }}>
              <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>Total</span>
              <span style={{ fontFamily: "monospace", fontSize: 12, color: C.green, fontWeight: 600 }}>{sideTotal} sales</span>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, padding: "18px 22px", minWidth: 0 }}>
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
            {tabs.map(t => (
              <div key={t.id} onClick={() => setTab(t.id)}
                style={{ padding: "8px 16px", cursor: "pointer", fontSize: 13, letterSpacing: ".08em", textTransform: "uppercase", borderBottom: `2px solid ${tab === t.id ? C.accent : "transparent"}`, color: tab === t.id ? C.accent : C.muted, transition: "all .2s" }}>
                {t.label}
              </div>
            ))}
          </div>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 18 }}>
            {tab === "itd" && <ITDView data={data} showListCost={preset === "itd"} />}
            {tab === "matrix" && <MatrixView data={data} />}
            {tab === "agents" && <AgentView data={data} />}
            {tab === "nonlist" && <NonListView data={data} />}
          </div>
          {isLive && data.lastUpdated && (
            <div style={{ marginTop: 10, fontSize: 10, color: C.muted, textAlign: "right" }}>
              Last updated: {new Date(data.lastUpdated).toLocaleString()} · Auto-refreshes every 15 min
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
    </div>
  );
}
