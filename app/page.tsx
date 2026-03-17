"use client";
import { useState, useEffect, useCallback, useRef } from "react";

interface ListStats { o: number; s: number; t: number; min: number; cost: number; listCost: number; }
interface DashData {
  byList:      Record<string, ListStats>;
  totalSales:  number;
  listCosts:   Record<string, number>;
  allLists:    string[];
  loadedFiles: string[];
  lastUpdated: string;
  hasData:     boolean;
  staleness?:  { cx: string | null; aim: string | null; moxy: string | null };
  apiSources?: { openedCount: number; salesCount: number; listFilesLoaded: number; dateRange: { from: string; to: string } };
  aimByAgent?: Record<string, Record<string, { min: number; cost: number; transfers: number }>>;
  error?:      string;
}

type DatePreset  = "today" | "yesterday" | "week" | "itd" | "custom";
type CampaignTab = "transfer" | "outbound" | "inbound" | "meta" | "overview" | "agentmapping";
type ViewMode    = "bylist" | "byagent";

interface AgentAssignment { name: string; campaign: "transfer" | "outbound" | "inbound" | "unassigned"; }
interface AgentStats      { name: string; t: number; o: number; s: number; min: number; cost: number; }

function getPresetDates(preset: DatePreset): { start: string | null; end: string | null } {
  const now = new Date(); const iso = (d: Date) => d.toISOString().slice(0, 10); const today = iso(now);
  if (preset === "itd")       return { start: null, end: null };
  if (preset === "today")     return { start: today, end: today };
  if (preset === "yesterday") { const y = new Date(now); y.setDate(y.getDate() - 1); return { start: iso(y), end: iso(y) }; }
  if (preset === "week")      { const mon = new Date(now); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); return { start: iso(mon), end: today }; }
  return { start: null, end: null };
}

const DEMO: DashData = {
  byList: {
    RT:         { o:1642, s:113, t:2421, min:80116, cost:23291, listCost:0    },
    JL021926LP: { o:164,  s:9,   t:268,  min:10609, cost:3085,  listCost:8000 },
    BL021926BO: { o:187,  s:9,   t:294,  min:13688, cost:3991,  listCost:8000 },
    JH022326MN: { o:168,  s:5,   t:272,  min:21385, cost:6226,  listCost:8000 },
    JL021926CR: { o:15,   s:0,   t:38,   min:5938,  cost:1729,  listCost:8000 },
    DG021726SC: { o:105,  s:3,   t:182,  min:12424, cost:3621,  listCost:5000 },
    JL022526RS: { o:12,   s:0,   t:30,   min:979,   cost:285,   listCost:6000 },
  },
  totalSales:  139,
  listCosts:   { RT:0, JL021926LP:8000, BL021926BO:8000, JH022326MN:8000, JL021926CR:8000, DG021726SC:5000, JL022526RS:6000 },
  allLists:    ["RT","JL021926LP","BL021926BO","JH022326MN","JL021926CR","DG021726SC","JL022526RS"],
  loadedFiles: [], lastUpdated: new Date().toISOString(), hasData: false,
};

const DEMO_AGENTS: AgentAssignment[] = [
  { name: "Overflow Agent with Spanish Transfer",             campaign: "transfer"   },
  { name: "Transfer Activation Outbound Agent with Moxy",    campaign: "transfer"   },
  { name: "Purchased Data Transfer Agent with Moxy",         campaign: "transfer"   },
  { name: "Meta Transfer Agent",                             campaign: "transfer"   },
  { name: "Cancels Transfer Agent",                          campaign: "unassigned" },
  { name: "Home Overflow Agent",                             campaign: "transfer"   },
  { name: "Overflow Transfer Sales Agent",                   campaign: "transfer"   },
  { name: "Picaso Agent",                                    campaign: "unassigned" },
  { name: "Transfer Outbound Agent with Moxy",               campaign: "outbound"   },
  { name: "BF Agent with Moxy Tools",                        campaign: "unassigned" },
  { name: "Canceled Home 4 Transfer Agent",                  campaign: "transfer"   },
  { name: "Transfer Outbound Agent with Moxy version 2",     campaign: "outbound"   },
  { name: "Copy of Picaso Agent (improving)",                campaign: "unassigned" },
  { name: "Black Friday Agent",                              campaign: "unassigned" },
  { name: "Outbound Jr. Closer to TO Agent with Moxy Tools", campaign: "outbound"   },
  { name: "Home Outbound Agent",                             campaign: "outbound"   },
];

const DEMO_AGENT_STATS: AgentStats[] = [
  { name: "Transfer Activation Outbound Agent with Moxy", t:1843, o:1291, s:102, min:68546, cost:19936 },
  { name: "Transfer Outbound Agent with Moxy",            t:712,  o:499,  s:14,  min:21877, cost:6363  },
  { name: "Purchased Data Transfer Agent with Moxy",      t:389,  o:217,  s:8,   min:17503, cost:5101  },
  { name: "Meta Transfer Agent",                          t:198,  o:120,  s:7,   min:6669,  cost:1944  },
  { name: "Transfer Outbound Agent with Moxy version 2",  t:89,   o:43,   s:4,   min:3179,  cost:924   },
  { name: "Overflow Agent with Spanish Transfer",         t:74,   o:53,   s:4,   min:3659,  cost:1063  },
  { name: "Home Overflow Agent",                          t:42,   o:0,    s:0,   min:7740,  cost:2251  },
  { name: "Overflow Transfer Sales Agent",                t:158,  o:0,    s:0,   min:1048,  cost:304   },
];

const STALE_HOURS = 2;
const f   = (n: number) => (n || 0).toLocaleString();
const fc  = (n: number) => "$" + (n || 0).toFixed(2);
const pct = (n: number, d: number) => d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—";

const C = {
  bg:"#06080F", surface:"#0C0F1A", card:"#101525", border:"#1B2440",
  accent:"#00D4B8", amber:"#F59E0B", red:"#EF4444", green:"#22C55E",
  text:"#C8D6E8", muted:"#3D5275", dim:"#1E2D45",
};

// ── STALE BANNER ──────────────────────────────────────────────────────────────
function StaleBanner({ staleness, onRefresh }: { staleness: DashData["staleness"]; onRefresh: () => void }) {
  if (!staleness) return null;
  const now = Date.now(); const threshold = STALE_HOURS * 60 * 60 * 1000;
  const sources = [{ label:"3CX", ts:staleness.cx }, { label:"AIM", ts:staleness.aim }, { label:"Moxy", ts:staleness.moxy }];
  const stale = sources.filter(s => !s.ts || now - new Date(s.ts).getTime() > threshold);
  if (stale.length === 0) return null;
  const labels = stale.map(s => {
    if (!s.ts) return `${s.label} (never)`;
    const mins = Math.round((now - new Date(s.ts).getTime()) / 60000);
    const hrs = Math.floor(mins / 60); const rem = mins % 60;
    return `${s.label} (${hrs > 0 ? `${hrs}h ${rem}m` : `${mins}m`} ago)`;
  });
  return (
    <div style={{ background:"rgba(245,158,11,.08)", borderBottom:`1px solid rgba(245,158,11,.3)`, borderLeft:`3px solid ${C.amber}`, padding:"7px 20px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
      <span>⚠️</span>
      <span style={{ fontSize:12, color:C.amber, fontWeight:600 }}>Stale data:</span>
      <span style={{ fontSize:12, color:C.text }}>{labels.join(" · ")} {stale.length > 1 ? "are" : "is"} more than {STALE_HOURS}h old.</span>
      <button onClick={onRefresh} style={{ marginLeft:"auto", padding:"3px 12px", borderRadius:4, border:`1px solid ${C.amber}`, background:"transparent", color:C.amber, cursor:"pointer", fontSize:12, fontWeight:600 }}>↻ Refresh Now</button>
    </div>
  );
}

// ── TABLE PRIMITIVES ──────────────────────────────────────────────────────────
function Th({ children, left }: { children: React.ReactNode; left?: boolean }) {
  return <th style={{ background:C.surface, color:C.muted, fontSize:10, letterSpacing:".12em", textTransform:"uppercase", padding:"9px 14px", textAlign:left?"left":"right", borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap" }}>{children}</th>;
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding:"9px 14px", textAlign:"right", fontSize:13, borderBottom:`1px solid ${C.dim}`, ...style }}>{children}</td>;
}
function ClosePct({ n, d }: { n: number; d: number }) {
  const v = d > 0 ? (n / d) * 100 : 0;
  const color = v >= 7 ? C.green : v >= 4 ? C.amber : v > 0 ? C.red : C.muted;
  return <span style={{ fontFamily:"monospace", fontSize:12, color, fontWeight:600 }}>{pct(n, d)}</span>;
}

// ── DATE FILTER BAR ───────────────────────────────────────────────────────────
function DateFilterBar({ preset, setPreset, customStart, setCustomStart, customEnd, setCustomEnd, onApply, onApplyWithPreset }: {
  preset: DatePreset; setPreset: (p: DatePreset) => void;
  customStart: string; setCustomStart: (s: string) => void;
  customEnd: string; setCustomEnd: (s: string) => void;
  onApply: () => void; onApplyWithPreset: (p: DatePreset) => void;
}) {
  const presets: { id: DatePreset; label: string }[] = [
    { id:"today", label:"Today" }, { id:"yesterday", label:"Yesterday" },
    { id:"week", label:"This Week" }, { id:"itd", label:"ITD" }, { id:"custom", label:"Custom" },
  ];
  return (
    <div style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 20px", background:C.surface, borderBottom:`1px solid ${C.border}`, flexWrap:"wrap" }}>
      <span style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginRight:4 }}>Range:</span>
      {presets.map(p => (
        <button key={p.id} onClick={() => { setPreset(p.id); if (p.id !== "custom") onApplyWithPreset(p.id); }}
          style={{ padding:"4px 13px", borderRadius:4, border:`1px solid ${preset===p.id?C.accent:C.dim}`, background:preset===p.id?"rgba(0,212,184,.1)":"transparent", color:preset===p.id?C.accent:C.muted, cursor:"pointer", fontSize:12, fontWeight:preset===p.id?600:400 }}>
          {p.label}
        </button>
      ))}
      {preset === "custom" && (
        <>
          <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ padding:"3px 8px", borderRadius:4, border:`1px solid ${C.dim}`, background:C.card, color:C.text, fontSize:12 }} />
          <span style={{ color:C.muted, fontSize:12 }}>to</span>
          <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ padding:"3px 8px", borderRadius:4, border:`1px solid ${C.dim}`, background:C.card, color:C.text, fontSize:12 }} />
          <button onClick={onApply} style={{ padding:"4px 14px", borderRadius:4, border:"none", background:C.accent, color:C.bg, cursor:"pointer", fontSize:12, fontWeight:700 }}>Apply</button>
        </>
      )}
    </div>
  );
}

// ── VIEW TOGGLE ───────────────────────────────────────────────────────────────
function ViewToggle({ viewMode, setViewMode }: { viewMode: ViewMode; setViewMode: (v: ViewMode) => void }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:6, padding:"10px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface }}>
      <span style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginRight:4 }}>View:</span>
      {(["bylist","byagent"] as ViewMode[]).map(id => (
        <button key={id} onClick={() => setViewMode(id)} style={{
          padding:"4px 14px", borderRadius:4, fontSize:12, fontWeight:viewMode===id?600:400, cursor:"pointer",
          border:`1px solid ${viewMode===id?C.accent:C.dim}`,
          background:viewMode===id?"rgba(0,212,184,.1)":"transparent",
          color:viewMode===id?C.accent:C.muted,
        }}>{id === "bylist" ? "By List" : "By Agent"}</button>
      ))}
    </div>
  );
}

// ── BY LIST VIEW ──────────────────────────────────────────────────────────────
function ByListView({ data }: { data: DashData }) {
  const lists  = data.allLists?.length ? data.allLists : Object.keys(data.byList);
  const totals = lists.reduce((a, li) => {
    const r = data.byList[li] || { o:0, s:0, t:0, min:0, cost:0, listCost:0 };
    if (r.listCost === 0) return a;
    return { t:a.t+r.t, o:a.o+r.o, s:a.s+r.s, min:a.min+r.min, cost:a.cost+r.cost, listCost:a.listCost+r.listCost };
  }, { t:0, o:0, s:0, min:0, cost:0, listCost:0 });

  return (
    <div style={{ display:"flex" }}>
      {/* LEFT PANEL */}
      <div style={{ width:180, flexShrink:0, borderRight:`1px solid ${C.border}`, padding:"10px", display:"flex", flexDirection:"column", gap:6, background:C.surface }}>
        <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Active Lists</div>
        {lists.map(li => {
          const r = data.byList[li] || { s:0, listCost:0 };
          const cps = r.s > 0 ? r.listCost / r.s : null;
          return (
            <div key={li} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px" }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.accent, marginBottom:4 }}>{li}</div>
              <div style={{ fontFamily:"monospace", fontSize:12, color:r.listCost>0?C.text:C.muted }}>{r.listCost>0?fc(r.listCost):"free"}</div>
              <div style={{ fontFamily:"monospace", fontSize:12, color:cps==null?C.dim:cps>1000?C.red:cps>500?C.amber:C.green, marginTop:2 }}>{cps!=null?fc(cps):"—"}</div>
            </div>
          );
        })}
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px", marginTop:4 }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.text, marginBottom:4 }}>TOTAL</div>
          <div style={{ fontFamily:"monospace", fontSize:12, color:C.text }}>{fc(totals.listCost)}</div>
          <div style={{ fontFamily:"monospace", fontSize:12, color:C.amber, marginTop:2 }}>{totals.s>0?fc(totals.listCost/totals.s):"—"}</div>
        </div>
      </div>

      {/* MAIN TABLE */}
      <div style={{ flex:1, overflowX:"auto" }}>
        <table style={{ borderCollapse:"collapse", width:"100%" }}>
          <thead>
            <tr>
              <Th left>List Name</Th>
              <Th>XFR Count</Th><Th>Queue Count</Th><Th>Sales</Th>
              <Th>Closing %</Th><Th>Minutes</Th><Th>Dial Cost</Th><Th>Cost / Sale</Th>
            </tr>
          </thead>
          <tbody>
            {lists.map(li => {
              const r = data.byList[li] || { o:0, s:0, t:0, min:0, cost:0, listCost:0 };
              const dcps = r.s > 0 ? r.cost / r.s : null;
              return (
                <tr key={li} onMouseEnter={e=>(e.currentTarget.style.background="rgba(0,212,184,.04)")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
                  <Td style={{ textAlign:"left" }}><span style={{ color:C.accent, fontWeight:600, fontSize:13 }}>{li}</span></Td>
                  <Td><span style={{ fontFamily:"monospace", color:C.text }}>{f(r.t)}</span></Td>
                  <Td><span style={{ fontFamily:"monospace", color:C.accent }}>{f(r.o)}</span></Td>
                  <Td><span style={{ fontFamily:"monospace", color:r.s>0?C.green:C.muted, fontWeight:r.s>0?700:400 }}>{r.s}</span></Td>
                  <Td><ClosePct n={r.s} d={r.o} /></Td>
                  <Td><span style={{ fontFamily:"monospace", color:C.muted }}>{f(Math.round(r.min))}</span></Td>
                  <Td><span style={{ fontFamily:"monospace", color:C.muted }}>{fc(r.cost)}</span></Td>
                  <Td>{dcps!=null?<span style={{ fontFamily:"monospace", color:dcps>500?C.red:dcps>250?C.amber:C.green }}>{fc(dcps)}</span>:<span style={{ color:C.dim }}>—</span>}</Td>
                </tr>
              );
            })}
            <tr style={{ background:C.surface, borderTop:`2px solid ${C.border}` }}>
              <Td style={{ textAlign:"left", fontWeight:700, color:C.text, fontSize:13 }}>TOTAL</Td>
              <Td><span style={{ fontFamily:"monospace", fontWeight:600 }}>{f(totals.t)}</span></Td>
              <Td><span style={{ fontFamily:"monospace", color:C.accent, fontWeight:600 }}>{f(totals.o)}</span></Td>
              <Td><span style={{ fontFamily:"monospace", color:C.green, fontWeight:700 }}>{totals.s}</span></Td>
              <Td><ClosePct n={totals.s} d={totals.o} /></Td>
              <Td><span style={{ fontFamily:"monospace", color:C.muted }}>{f(Math.round(totals.min))}</span></Td>
              <Td><span style={{ fontFamily:"monospace", color:C.muted }}>{fc(totals.cost)}</span></Td>
              <Td>{totals.s>0?<span style={{ fontFamily:"monospace", color:C.amber, fontWeight:600 }}>{fc(totals.cost/totals.s)}</span>:<span style={{ color:C.dim }}>—</span>}</Td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── BY AGENT VIEW (agent × list cross-tab) ───────────────────────────────────
function ByAgentView({ agents, lists, crossData }: { 
  agents: AgentStats[]; 
  lists: string[];
  crossData: Record<string, Record<string, { min: number; cost: number; transfers: number }>> | null;
}) {
  const cross = crossData ?? {};

  const totals = agents.reduce((a, ag) => ({
    t:a.t+ag.t, o:a.o+ag.o, s:a.s+ag.s, min:a.min+ag.min, cost:a.cost+ag.cost,
  }), { t:0, o:0, s:0, min:0, cost:0 });

  // Column totals per list
  const listTotals: Record<string, { min:number; t:number; s:number }> = {};
  for (const li of lists) {
    listTotals[li] = { min:0, t:0, s:0 };
    for (const ag of agents) {
      const cell = cross[ag.name]?.[li];
      if (cell) {
        listTotals[li].min += cell.min;
        listTotals[li].t   += (cell as any).t ?? (cell as any).transfers ?? 0;
        listTotals[li].s   += (cell as any).s ?? 0;
      }
    }
  }

  return (
    <div style={{ display:"flex" }}>
      {/* LEFT PANEL */}
      <div style={{ width:220, flexShrink:0, borderRight:`1px solid ${C.border}`, padding:"10px", display:"flex", flexDirection:"column", gap:6, background:C.surface }}>
        <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Active Agents</div>
        {agents.map(ag => {
          const cps = ag.s > 0 ? ag.cost / ag.s : null;
          return (
            <div key={ag.name} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px" }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.accent, marginBottom:3, lineHeight:1.3 }}>{ag.name}</div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:4 }}>{f(ag.o)} opened · {ag.s} deals</div>
              <div style={{ fontFamily:"monospace", fontSize:12, color:C.muted }}>{fc(ag.cost)}</div>
              <div style={{ fontFamily:"monospace", fontSize:12, color:cps==null?C.dim:cps>500?C.red:cps>250?C.amber:C.green, marginTop:2 }}>
                {cps!=null?fc(cps)+" / sale":"—"}
              </div>
            </div>
          );
        })}
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px", marginTop:4 }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.text, marginBottom:3 }}>TOTAL</div>
          <div style={{ fontSize:10, color:C.muted, marginBottom:4 }}>{f(totals.o)} opened · {totals.s} deals</div>
          <div style={{ fontFamily:"monospace", fontSize:12, color:C.text }}>{fc(totals.cost)}</div>
          <div style={{ fontFamily:"monospace", fontSize:12, color:C.amber, marginTop:2 }}>{totals.s>0?fc(totals.cost/totals.s)+" / sale":"—"}</div>
        </div>
      </div>

      {/* CROSS-TAB GRID */}
      <div style={{ flex:1, overflowX:"auto" }}>
        <table style={{ borderCollapse:"collapse", width:"100%" }}>
          <thead>
            <tr>
              <th style={{ background:C.surface, color:C.muted, fontSize:10, letterSpacing:".12em", textTransform:"uppercase", padding:"9px 14px", textAlign:"left", borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap" }}>Agent</th>
              {lists.map(li => (
                <th key={li} style={{ background:C.surface, color:C.accent, fontSize:11, fontWeight:700, padding:"9px 14px", textAlign:"center", borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap", borderLeft:`1px solid ${C.border}` }}>{li}</th>
              ))}
            </tr>
            {/* no sub-header row */}
          </thead>
          <tbody>
            {agents.map(ag => (
              <tr key={ag.name} onMouseEnter={e=>(e.currentTarget.style.background="rgba(0,212,184,.04)")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
                <td style={{ padding:"8px 14px", fontSize:12, fontWeight:600, color:C.text, borderBottom:`1px solid ${C.dim}`, whiteSpace:"nowrap" }}>{ag.name}</td>
                {lists.map(li => {
                  const raw  = cross[ag.name]?.[li];
                  const cell = raw ? {
                    min: raw.min,
                    t:   (raw as any).t ?? (raw as any).transfers ?? 0,
                    s:   (raw as any).s ?? 0,
                  } : null;
                  return (
                    <td key={li} style={{ padding:"6px 10px", textAlign:"center", borderBottom:`1px solid ${C.dim}`, borderLeft:`1px solid ${C.dim}`, minWidth:90 }}>
                      {cell ? (
                        <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                          <span style={{ fontFamily:"monospace", fontSize:11, color:C.text }}><span style={{ color:C.muted }}>Mins: </span>{f(cell.min)}</span>
                          <span style={{ fontFamily:"monospace", fontSize:11, color:C.accent }}><span style={{ color:C.muted }}>Que: </span>{f(cell.t)}</span>
                          <span style={{ fontFamily:"monospace", fontSize:11, color:cell.s>0?C.green:C.dim, fontWeight:cell.s>0?700:400 }}><span style={{ color:C.muted, fontWeight:400 }}>Sales: </span>{cell.s}</span>
                          <span style={{ fontFamily:"monospace", fontSize:11, color:C.amber }}><span style={{ color:C.muted }}>Cls%: </span>{pct(cell.s, cell.t)}</span>
                        </div>
                      ) : (
                        <span style={{ color:C.dim, fontSize:12 }}>—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {/* totals row */}
            <tr style={{ background:C.surface, borderTop:`2px solid ${C.border}` }}>
              <td style={{ padding:"8px 14px", fontSize:12, fontWeight:700, color:C.text }}>TOTAL</td>
              {lists.map(li => {
                const lt = listTotals[li] || { min:0, t:0, s:0 };
                return (
                  <td key={li} style={{ padding:"6px 10px", textAlign:"center", borderLeft:`1px solid ${C.border}` }}>
                    <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                      <span style={{ fontFamily:"monospace", fontSize:11, color:C.text, fontWeight:600 }}><span style={{ color:C.muted, fontWeight:400 }}>Mins: </span>{f(lt.min)}</span>
                      <span style={{ fontFamily:"monospace", fontSize:11, color:C.accent, fontWeight:600 }}><span style={{ color:C.muted, fontWeight:400 }}>Que: </span>{f(lt.t)}</span>
                      <span style={{ fontFamily:"monospace", fontSize:11, color:lt.s>0?C.green:C.dim, fontWeight:700 }}><span style={{ color:C.muted, fontWeight:400 }}>Sales: </span>{lt.s}</span>
                      <span style={{ fontFamily:"monospace", fontSize:11, color:C.amber, fontWeight:600 }}><span style={{ color:C.muted, fontWeight:400 }}>Cls%: </span>{pct(lt.s, lt.t)}</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── TRANSFER VIEW (wrapper with toggle) ───────────────────────────────────────
function TransferView({ data }: { data: DashData }) {
  const [viewMode, setViewMode] = useState<ViewMode>("bylist");
  const lists     = data.allLists?.length ? data.allLists : Object.keys(data.byList);
  const crossData = data.aimByAgent ?? null;
  return (
    <div>
      <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
      {viewMode === "bylist"  && <ByListView  data={data} />}
      {viewMode === "byagent" && <ByAgentView agents={DEMO_AGENT_STATS} lists={lists} crossData={crossData} />}
    </div>
  );
}

// ── COMING SOON ───────────────────────────────────────────────────────────────
function ComingSoon({ label }: { label: string }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 20px", gap:12 }}>
      <div style={{ fontSize:32, opacity:.25 }}>🚧</div>
      <div style={{ fontSize:14, color:C.muted, fontWeight:600, letterSpacing:".12em", textTransform:"uppercase" }}>{label}</div>
      <div style={{ fontSize:11, color:C.dim }}>Coming soon</div>
    </div>
  );
}

// ── AGENT MAPPING VIEW ────────────────────────────────────────────────────────
function AgentMappingView() {
  const [agents, setAgents] = useState<AgentAssignment[]>(DEMO_AGENTS);
  const setAgent = (name: string, campaign: AgentAssignment["campaign"]) =>
    setAgents(prev => prev.map(a => a.name === name ? { ...a, campaign } : a));
  const campaignColor = (c: AgentAssignment["campaign"]) =>
    c==="transfer"?C.accent : c==="outbound"?C.amber : c==="inbound"?C.green : C.muted;
  const groups: { id: AgentAssignment["campaign"]; label: string }[] = [
    { id:"transfer", label:"Transfer" }, { id:"outbound", label:"Outbound" },
    { id:"inbound",  label:"Inbound"  }, { id:"unassigned", label:"⚠ Unassigned" },
  ];
  return (
    <div style={{ padding:20 }}>
      <div style={{ marginBottom:18, fontSize:12, color:C.muted }}>
        Assign each AIM agent to a campaign. Metrics will roll up into the corresponding campaign tab.
      </div>
      {groups.map(group => {
        const groupAgents = agents.filter(a => a.campaign === group.id);
        if (groupAgents.length === 0) return null;
        return (
          <div key={group.id} style={{ marginBottom:24 }}>
            <div style={{ fontSize:10, color:campaignColor(group.id), letterSpacing:".14em", textTransform:"uppercase", fontWeight:700, marginBottom:8, paddingBottom:6, borderBottom:`1px solid ${C.border}` }}>
              {group.label} <span style={{ color:C.dim, fontWeight:400 }}>({groupAgents.length})</span>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
              {groupAgents.map(a => (
                <div key={a.name} style={{ display:"flex", alignItems:"center", gap:12, padding:"8px 12px", background:C.card, borderRadius:6, border:`1px solid ${C.border}` }}>
                  <span style={{ flex:1, fontSize:13, color:C.text }}>{a.name}</span>
                  <div style={{ display:"flex", gap:5 }}>
                    {(["transfer","outbound","inbound","unassigned"] as AgentAssignment["campaign"][]).map(opt => (
                      <button key={opt} onClick={() => setAgent(a.name, opt)} style={{
                        padding:"3px 10px", borderRadius:4, fontSize:11, fontWeight:600, cursor:"pointer", textTransform:"capitalize",
                        border:`1px solid ${a.campaign===opt?campaignColor(opt):C.dim}`,
                        background:a.campaign===opt?`${campaignColor(opt)}22`:"transparent",
                        color:a.campaign===opt?campaignColor(opt):C.muted,
                      }}>{opt}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── SOURCE HEALTH BAR ─────────────────────────────────────────────────────────
function SourceHealthBar({ staleness }: { staleness: DashData["staleness"] }) {
  const now = Date.now();
  const sources = [
    { label: "AIM",  ts: staleness?.aim  },
    { label: "3CX",  ts: staleness?.cx   },
    { label: "Moxy", ts: staleness?.moxy },
  ];
  const getColor = (ts: string | null | undefined) => {
    if (!ts) return C.muted;
    const mins = Math.round((now - new Date(ts).getTime()) / 60000);
    if (mins <= 60)  return C.green;
    if (mins <= 120) return C.amber;
    return C.red;
  };
  const getAge = (ts: string | null | undefined) => {
    if (!ts) return "never";
    const mins = Math.round((now - new Date(ts).getTime()) / 60000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins/60)}h ${mins%60}m`;
  };
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:3 }}>
      {sources.map(s => (
        <div key={s.label} style={{ display:"flex", alignItems:"center", gap:3 }}>
          <div style={{ width:6, height:6, borderRadius:"50%", background:getColor(s.ts), boxShadow:`0 0 4px ${getColor(s.ts)}` }} />
          <span style={{ fontSize:10, color:getColor(s.ts), fontFamily:"monospace" }}>
            {s.label}
          </span>
          <span style={{ fontSize:9, color:C.muted, fontFamily:"monospace" }}>
            ({getAge(s.ts)})
          </span>
        </div>
      ))}
    </div>
  );
}

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────
export default function Home() {
  const [data, setData]               = useState<DashData>(DEMO);
  const [isLive, setIsLive]           = useState(false);
  const [loading, setLoading]         = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string>("");
  const [campaign, setCampaign]       = useState<CampaignTab>("transfer");
  const [preset, setPreset]           = useState<DatePreset>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd]     = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadData = useCallback(async (start: string | null, end: string | null) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (start) qs.set("start", start);
      if (end)   qs.set("end", end);
      const q = qs.toString() ? "?" + qs.toString() : "";
      const res  = await fetch(`/api/data${q}`);
      const json = await res.json();
      if (json?.hasData) { setData(json); setIsLive(true); }
      else               { setData(DEMO); setIsLive(false); }
      setLastRefresh(new Date().toLocaleTimeString());
    } catch { setIsLive(false); }
    finally  { setLoading(false); }
  }, []);

  const handleApplyWithPreset = useCallback((p: DatePreset) => {
    const { start, end } = getPresetDates(p); loadData(start, end);
  }, [loadData]);

  const handleApply = useCallback(() => {
    const { start, end } = preset === "custom"
      ? { start: customStart || null, end: customEnd || null }
      : getPresetDates(preset);
    loadData(start, end);
  }, [preset, customStart, customEnd, loadData]);

  useEffect(() => {
    const { start, end } = getPresetDates("today"); loadData(start, end);
  }, [loadData]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(handleApply, 15 * 60 * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [handleApply]);

  const tabs: { id: CampaignTab; label: string; active: boolean }[] = [
    { id:"transfer",     label:"Transfer",      active:true  },
    { id:"outbound",     label:"Outbound",      active:false },
    { id:"inbound",      label:"Inbound",       active:false },
    { id:"meta",         label:"Meta",          active:false },
    { id:"overview",     label:"Overview",      active:false },
    { id:"agentmapping", label:"Agent Mapping", active:true  },
  ];

  return (
    <div style={{ background:C.bg, minHeight:"100vh", color:C.text, fontFamily:"system-ui, sans-serif" }}>

      {/* HEADER */}
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"11px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:8, height:8, borderRadius:"50%", background:C.accent, boxShadow:`0 0 10px ${C.accent}`, animation:"pulse 2s infinite" }} />
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:C.text, letterSpacing:".06em", textTransform:"uppercase" }}>GPG — AI Voice Agent Dashboard</div>
            <SourceHealthBar staleness={data.staleness} />
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {(loading || !isLive) && (
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ width:18, height:18, borderRadius:"50%", border:`2px solid ${C.dim}`, borderTopColor:C.amber, animation:"spin 0.8s linear infinite" }} />
              <span style={{ fontSize:11, color:C.amber, fontFamily:"monospace" }}>{loading?"Loading…":"Awaiting Data"}</span>
            </div>
          )}
          {!loading && isLive && lastRefresh && <span style={{ fontSize:10, color:C.muted, fontFamily:"monospace" }}>↻ {lastRefresh}</span>}
          {!loading && isLive && (
            <span style={{ padding:"2px 8px", borderRadius:3, fontSize:10, fontWeight:600, letterSpacing:".08em", textTransform:"uppercase", background:"rgba(34,197,94,.12)", color:C.green, border:"1px solid rgba(34,197,94,.3)" }}>Live Data</span>
          )}
          <span style={{ fontFamily:"monospace", fontSize:11, color:C.muted }}>
            {new Date().toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" })}
          </span>
        </div>
      </div>

      {/* CAMPAIGN TAB BAR */}
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"0 20px", display:"flex", alignItems:"stretch" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => t.active && setCampaign(t.id)} style={{
            padding:"11px 20px", background:"transparent", border:"none",
            borderBottom:`2px solid ${campaign===t.id?C.accent:"transparent"}`,
            color:!t.active?C.dim:campaign===t.id?C.accent:C.muted,
            cursor:t.active?"pointer":"not-allowed", fontSize:12, fontWeight:campaign===t.id?700:500,
            letterSpacing:".1em", textTransform:"uppercase", opacity:t.active?1:0.38,
          }}>
            {t.label}
            {!t.active && <span style={{ fontSize:8, marginLeft:5, opacity:.6 }}>SOON</span>}
          </button>
        ))}
        <button onClick={handleApply} style={{ marginLeft:"auto", padding:"8px 16px", background:"transparent", border:"none", color:C.muted, cursor:"pointer", fontSize:12 }}>
          ↻ Refresh
        </button>
      </div>

      {/* STALE BANNER */}
      {isLive && <StaleBanner staleness={data.staleness} onRefresh={handleApply} />}

      {/* DATE FILTER BAR */}
      {campaign !== "agentmapping" && (
        <DateFilterBar
          preset={preset} setPreset={setPreset}
          customStart={customStart} setCustomStart={setCustomStart}
          customEnd={customEnd} setCustomEnd={setCustomEnd}
          onApply={handleApply} onApplyWithPreset={handleApplyWithPreset}
        />
      )}

      {/* MAIN CONTENT */}
      <div style={{ padding:"20px" }}>
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden" }}>
          {campaign === "transfer"     && <TransferView data={data} />}
          {campaign === "outbound"     && <ComingSoon label="Outbound" />}
          {campaign === "inbound"      && <ComingSoon label="Inbound" />}
          {campaign === "meta"         && <ComingSoon label="Meta" />}
          {campaign === "overview"     && <ComingSoon label="Overview" />}
          {campaign === "agentmapping" && <AgentMappingView />}
        </div>
        {isLive && data.lastUpdated && campaign !== "agentmapping" && (
          <div style={{ marginTop:8, fontSize:10, color:C.muted, textAlign:"right" }}>
            Last updated: {new Date(data.lastUpdated).toLocaleString()} · Auto-refreshes every 15 min
          </div>
        )}
        {isLive && data.apiSources && campaign !== "agentmapping" && (
          <div style={{ marginTop:3, fontSize:10, color:C.dim, textAlign:"right" }}>
            {data.apiSources.openedCount} opened · {data.apiSources.salesCount} sales checked · {data.apiSources.listFilesLoaded} list files loaded
          </div>
        )}
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
