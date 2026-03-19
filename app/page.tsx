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
  aimByAgent?: Record<string, Record<string, { min: number; cost: number; t: number; s: number }>>;
  byAgent?:    Record<string, { calls: number; min: number; cost: number; t: number; deals: number }>;
  allAgents?:  string[];
  error?:      string;
}

type DatePreset  = "today" | "yesterday" | "week" | "m2d" | "itd" | "custom";
type CampaignTab = "transfer" | "outbound" | "inbound" | "meta" | "overview" | "agentmapping";
type ViewMode    = "bylist" | "byagent";

interface AgentAssignment { name: string; campaign: "transfer" | "outbound" | "inbound" | "unassigned"; }
interface AgentStats      { name: string; t: number; o: number; s: number; min: number; cost: number; }

interface MetaCall {
  date: string;
  time: string;
  status: "transferred" | "answered" | "unanswered";
}

interface MetaLead {
  phone: string;
  calls: MetaCall[];
  mail6TalkTimeSec: number;
  isSold: boolean;
}

interface MetaResponse {
  ok: boolean;
  leads: MetaLead[];
  summary: { totalLeads: number; transferred: number; answered: number; unanswered: number; sold: number };
  lastUpdated: string;
  error?: string;
}

function getPresetDates(preset: DatePreset): { start: string | null; end: string | null } {
  // Use Central Time for business day alignment (auto-detect CDT vs CST)
  const now = new Date();
  const centralStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
  const central = new Date(centralStr);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = iso(central);
  if (preset === "itd")       return { start: null, end: null };
  if (preset === "today")     return { start: today, end: today };
  if (preset === "yesterday") { const y = new Date(central.getTime()); y.setDate(y.getDate() - 1); return { start: iso(y), end: iso(y) }; }
  if (preset === "week")      { const mon = new Date(central.getTime()); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); return { start: iso(mon), end: today }; }
  if (preset === "m2d")       { const m1 = new Date(central.getFullYear(), central.getMonth(), 1); return { start: iso(m1), end: today }; }
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

// DEMO_AGENTS and DEMO_AGENT_STATS removed — agent data comes from live API

const STALE_HOURS = 2;
const f   = (n: number) => (n || 0).toLocaleString();
const fc  = (n: number) => "$" + (n || 0).toFixed(2);
const pct = (n: number, d: number) => d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—";

const C = {
  bg:"#06080F", surface:"#0C0F1A", card:"#101525", border:"#1B2440",
  accent:"#00D4B8", amber:"#F59E0B", red:"#EF4444", green:"#22C55E",
  text:"#C8D6E8", muted:"#3D5275", dim:"#1E2D45",
};


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

function LoadingSpinner() {
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 14,
      height: 14,
      borderRadius: "50%",
      border: `2px solid ${C.dim}`,
      borderTopColor: C.accent,
      animation: "spin 0.8s linear infinite"
    }} />
  );
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
    { id:"week", label:"This Week" }, { id:"m2d", label:"M2D" }, { id:"itd", label:"ITD" }, { id:"custom", label:"Custom" },
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
function ByListView({ data, itdData, loading }: { data: DashData; itdData: DashData; loading: boolean }) {
  const lists  = data.allLists?.length ? data.allLists : Object.keys(data.byList);
  const totals = lists.reduce((a, li) => {
    const r = data.byList[li] || { o:0, s:0, t:0, min:0, cost:0, listCost:0 };
    return { t:a.t+r.t, o:a.o+r.o, s:a.s+r.s, min:a.min+r.min, cost:a.cost+r.cost, listCost:a.listCost+r.listCost };
  }, { t:0, o:0, s:0, min:0, cost:0, listCost:0 });

  return (
    <div style={{ display:"flex" }}>
      {/* LEFT PANEL - ITD DATA */}
      <div style={{ width:180, flexShrink:0, borderRight:`1px solid ${C.border}`, padding:"10px", display:"flex", flexDirection:"column", gap:6, background:C.surface }}>
        <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Active Lists</div>
        {lists.map(li => {
          const itdListData = itdData.byList[li] || { s:0, listCost:0 };
          const listCost = itdListData.listCost;
          const itdSalesCount = itdListData.s || 0;
          const costPerDeal = itdSalesCount > 0 ? listCost / itdSalesCount : null;
          return (
            <div key={li} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px" }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.accent, marginBottom:4 }}>{li}</div>
              <div style={{ fontFamily:"monospace", fontSize:12, color:listCost>0?C.text:C.muted, marginBottom:4 }}>{listCost>0?fc(listCost):"free"}</div>
              <div style={{ fontSize:9, color:C.muted, marginBottom:2 }}>ITD Deal Count</div>
              <div style={{ fontFamily:"monospace", fontSize:12, color:C.text, marginBottom:4 }}>{itdSalesCount}</div>
              <div style={{ fontSize:9, color:C.muted, marginBottom:2 }}>Cost/Deal</div>
              <div style={{ fontFamily:"monospace", fontSize:12, color:costPerDeal==null?C.dim:costPerDeal>1000?C.red:costPerDeal>500?C.amber:C.green }}>{costPerDeal!=null?fc(costPerDeal):"—"}</div>
            </div>
          );
        })}
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px", marginTop:4 }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.text, marginBottom:4 }}>TOTAL</div>
          <div style={{ fontFamily:"monospace", fontSize:12, color:C.text, marginBottom:4 }}>{fc(totals.listCost)}</div>
          <div style={{ fontSize:9, color:C.muted, marginBottom:2 }}>ITD Deal Count</div>
          <div style={{ fontFamily:"monospace", fontSize:12, color:C.text, marginBottom:4 }}>{Object.values(itdData.byList).reduce((a, r) => a + (r.s || 0), 0)}</div>
          <div style={{ fontSize:9, color:C.muted, marginBottom:2 }}>Cost/Deal</div>
          <div style={{ fontFamily:"monospace", fontSize:12, color:C.amber }}>{totals.s>0?fc(totals.listCost/totals.s):"—"}</div>
        </div>
      </div>

      {/* MAIN TABLE */}
      <div style={{ flex:1, overflowX:"auto" }}>
        <table style={{ borderCollapse:"collapse", width:"100%" }}>
          <thead>
            <tr>
              <Th left>List Name</Th>
              <Th>Sales</Th><Th>Closing %</Th>
              <Th>Calls</Th><Th>Minutes</Th><Th>Dial Cost</Th><Th>Cost / Sale</Th>
            </tr>
          </thead>
          <tbody>
            {lists.map(li => {
              const r = data.byList[li] || { o:0, s:0, t:0, min:0, cost:0, listCost:0 };
              const dcps = r.s > 0 ? r.cost / r.s : null;
              return (
                <tr key={li} onMouseEnter={e=>(e.currentTarget.style.background="rgba(0,212,184,.04)")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
                  <Td style={{ textAlign:"left" }}><span style={{ color:C.accent, fontWeight:600, fontSize:13 }}>{li}</span></Td>
                  <Td>{loading ? <LoadingSpinner /> : <span style={{ fontFamily:"monospace", color:r.s>0?C.green:C.muted, fontWeight:r.s>0?700:400 }}>{r.s}</span>}</Td>
                  <Td>{loading ? <LoadingSpinner /> : <ClosePct n={r.s} d={r.o} />}</Td>
                  <Td>{loading ? <LoadingSpinner /> : <span style={{ fontFamily:"monospace", color:C.accent }}>{f(r.o)}</span>}</Td>
                  <Td>{loading ? <LoadingSpinner /> : <span style={{ fontFamily:"monospace", color:C.muted }}>{f(Math.round(r.min))}</span>}</Td>
                  <Td>{loading ? <LoadingSpinner /> : <span style={{ fontFamily:"monospace", color:C.muted }}>{fc(r.cost)}</span>}</Td>
                  <Td>{loading ? <LoadingSpinner /> : (dcps!=null?<span style={{ fontFamily:"monospace", color:dcps>500?C.red:dcps>250?C.amber:C.green }}>{fc(dcps)}</span>:<span style={{ color:C.dim }}>—</span>)}</Td>
                </tr>
              );
            })}
            <tr style={{ background:C.surface, borderTop:`2px solid ${C.border}` }}>
              <Td style={{ textAlign:"left", fontWeight:700, color:C.text, fontSize:13 }}>TOTAL</Td>
              <Td>{loading ? <LoadingSpinner /> : <span style={{ fontFamily:"monospace", color:C.green, fontWeight:700 }}>{totals.s}</span>}</Td>
              <Td>{loading ? <LoadingSpinner /> : <ClosePct n={totals.s} d={totals.o} />}</Td>
              <Td>{loading ? <LoadingSpinner /> : <span style={{ fontFamily:"monospace", color:C.accent, fontWeight:600 }}>{f(totals.o)}</span>}</Td>
              <Td>{loading ? <LoadingSpinner /> : <span style={{ fontFamily:"monospace", color:C.muted }}>{f(Math.round(totals.min))}</span>}</Td>
              <Td>{loading ? <LoadingSpinner /> : <span style={{ fontFamily:"monospace", color:C.muted }}>{fc(totals.cost)}</span>}</Td>
              <Td>{loading ? <LoadingSpinner /> : (totals.s>0?<span style={{ fontFamily:"monospace", color:C.amber, fontWeight:600 }}>{fc(totals.cost/totals.s)}</span>:<span style={{ color:C.dim }}>—</span>)}</Td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── BY AGENT VIEW (agent stat cards) ──────────────────────────────────────
function ByAgentView({ agents, lists, crossData, itdData, loading }: {
  agents: AgentStats[];
  lists: string[];
  crossData: Record<string, Record<string, { min: number; cost: number; t: number; s: number }>> | null;
  itdData: DashData;
  loading: boolean;
}) {
  const cross = crossData ?? {};

  const totals = agents.reduce((a, ag) => ({
    t:a.t+ag.t, o:a.o+ag.o, s:a.s+ag.s, min:a.min+ag.min, cost:a.cost+ag.cost,
  }), { t:0, o:0, s:0, min:0, cost:0 });

  // Separate active and unused agents
  const activeAgents = agents.filter(ag => ag.t > 0 || ag.o > 0 || ag.min > 0 || ag.cost > 0);
  const unusedAgents = agents.filter(ag => ag.t === 0 && ag.o === 0 && ag.min === 0 && ag.cost === 0);

  // Column totals per list (only for active agents for the table)
  const listTotals: Record<string, { min:number; t:number; s:number }> = {};
  for (const li of lists) {
    listTotals[li] = { min:0, t:0, s:0 };
    for (const ag of activeAgents) {
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
      {/* LEFT PANEL - AGENT CARDS */}
      <div style={{ width:180, flexShrink:0, borderRight:`1px solid ${C.border}`, padding:"10px", display:"flex", flexDirection:"column", gap:6, background:C.surface }}>
        <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Active Agents</div>
        {activeAgents.map(ag => {
          // Per-agent ITD data from byAgent (cost, transfers, deals)
          const agentItd = (itdData.byAgent as any)?.[ag.name] ?? { cost: 0, t: 0, deals: 0 };
          const itdDialCost = agentItd.cost ?? 0;
          const itdTransfers = agentItd.t ?? 0;
          const itdDeals = agentItd.deals ?? 0;
          const costPerCall = itdTransfers > 0 ? itdDialCost / itdTransfers : null;
          const costPerDeal = itdDeals > 0 ? itdDialCost / itdDeals : null;
          return (
            <div key={ag.name} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px" }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.accent, marginBottom:4, wordBreak:"break-word" }}>{ag.name}</div>
              <div style={{ fontFamily:"monospace", fontSize:12, color:C.text, marginBottom:4 }}>{fc(itdDialCost)}</div>
              <div style={{ fontSize:9, color:C.muted, marginBottom:1 }}>Cost/Call · Cost/Deal</div>
              <div style={{ fontFamily:"monospace", fontSize:11, color:C.text, display:"flex", gap:2, justifyContent:"space-between" }}>
                <span style={{ color:costPerCall==null?C.dim:costPerCall>100?C.red:costPerCall>50?C.amber:C.green }}>{costPerCall!=null?fc(costPerCall):"—"}</span>
                <span style={{ color:costPerDeal==null?C.dim:costPerDeal>500?C.red:costPerDeal>250?C.amber:C.green }}>{costPerDeal!=null?fc(costPerDeal):"—"}</span>
              </div>
            </div>
          );
        })}
        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px", marginTop:4 }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.text, marginBottom:4 }}>TOTAL</div>
          <div style={{ fontFamily:"monospace", fontSize:12, color:C.text, marginBottom:4 }}>{fc(totals.cost)}</div>
          <div style={{ fontSize:9, color:C.muted, marginBottom:1 }}>Cost/Call · Cost/Sale</div>
          <div style={{ fontFamily:"monospace", fontSize:11, color:C.text, display:"flex", gap:2, justifyContent:"space-between" }}>
            <span style={{ color:totals.o>0?C.amber:C.dim }}>{totals.o>0?fc(totals.cost/totals.o):"—"}</span>
            <span style={{ color:totals.s>0?C.green:C.dim }}>{totals.s>0?fc(totals.cost/totals.s):"—"}</span>
          </div>
        </div>

        {/* UNUSED AGENTS */}
        {unusedAgents.length > 0 && (
          <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${C.border}` }}>
            <div style={{ fontSize:9, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", fontWeight:600, marginBottom:6 }}>
              Unused Agents
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
              {unusedAgents.map(ag => (
                <div key={ag.name} style={{ padding:"6px 8px", background:C.surface, border:`1px solid ${C.dim}`, borderRadius:4, fontSize:10, color:C.muted, opacity:0.5, wordBreak:"break-word" }}>
                  {ag.name}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* MAIN CONTENT - AGENT STAT CARDS BY LIST */}
      <div style={{ flex:1, overflowX:"auto", padding:"12px" }}>
        {activeAgents.length > 0 && (
          <div>
            {/* Grid header row with list names (with agent name column) */}
            <div style={{ display:"grid", gridTemplateColumns:`80px repeat(${lists.length}, 1fr)`, gap:6, marginBottom:6 }}>
              <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", fontWeight:600 }}>Agent</div>
              {lists.map(li => (
                <div key={li} style={{ fontSize:10, color:C.accent, letterSpacing:".12em", textTransform:"uppercase", fontWeight:700, textAlign:"center" }}>
                  {li}
                </div>
              ))}
            </div>

            {/* Agent rows with stat cards */}
            {activeAgents.map(ag => (
              <div key={ag.name} style={{ display:"grid", gridTemplateColumns:`80px repeat(${lists.length}, 1fr)`, gap:6, marginBottom:8 }}>
                {/* Agent name label */}
                <div style={{ fontSize:9, color:C.muted, padding:"8px", alignSelf:"start", wordBreak:"break-word", maxHeight:90, overflow:"hidden" }}>
                  {ag.name}
                </div>
                {/* Stat cards for each list */}
                {lists.map(li => {
                  const raw = cross[ag.name]?.[li];
                  const cell = raw ? {
                    min: raw.min,
                    t:   (raw as any).t ?? (raw as any).transfers ?? 0,
                    s:   (raw as any).s ?? 0,
                  } : null;

                  const hasMins = cell && cell.min > 0;
                  const hasTransfers = cell && cell.t > 0;
                  const hasSales = cell && cell.s > 0;

                  return (
                    <div
                      key={li}
                      style={{
                        background: cell && (cell.min > 0 || cell.t > 0 || cell.s > 0) ? C.card : C.surface,
                        border: `1px solid ${C.border}`,
                        borderRadius: 4,
                        padding: "8px",
                        fontSize: 10,
                        minHeight: 90,
                      }}
                    >
                      {cell && (cell.min > 0 || cell.t > 0 || cell.s > 0) ? (
                        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                          <div style={{ fontFamily:"monospace", color: hasMins ? C.text : C.dim, fontWeight:500 }}>
                            <span style={{ color:C.muted }}>Mins: </span>{f(Math.round(cell.min))}
                          </div>
                          <div style={{ fontFamily:"monospace", color: hasTransfers ? C.accent : C.dim, fontWeight:500 }}>
                            <span style={{ color:C.muted }}>Calls: </span>{f(cell.t)}
                          </div>
                          <div style={{ fontFamily:"monospace", color: hasSales ? C.green : C.dim, fontWeight:hasSales?600:400 }}>
                            <span style={{ color:C.muted }}>Sales: </span>{cell.s}
                          </div>
                          <div style={{ fontFamily:"monospace", color: C.amber, fontWeight:500 }}>
                            <span style={{ color:C.muted }}>Cls%: </span>{pct(cell.s, cell.t)}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color:C.dim, fontSize:10 }}>—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {/* TOTAL ROW */}
            <div style={{ display:"grid", gridTemplateColumns:`80px repeat(${lists.length}, 1fr)`, gap:6, marginTop:12, paddingTop:12, borderTop:`2px solid ${C.border}` }}>
              {/* TOTAL label */}
              <div style={{ fontSize:9, color:C.text, fontWeight:700, padding:"8px", alignSelf:"start" }}>TOTAL</div>
              {lists.map(li => {
                const lt = listTotals[li] || { min:0, t:0, s:0 };
                return (
                  <div
                    key={li}
                    style={{
                      background: C.surface,
                      border: `1px solid ${C.border}`,
                      borderRadius: 4,
                      padding: "8px",
                      fontSize: 10,
                      minHeight: 90,
                      display:"flex",
                      flexDirection:"column",
                      gap:4,
                    }}
                  >
                    <div style={{ fontFamily:"monospace", color: C.text, fontWeight:600 }}>
                      <span style={{ color:C.muted, fontWeight:400 }}>Mins: </span>{f(Math.round(lt.min))}
                    </div>
                    <div style={{ fontFamily:"monospace", color: C.accent, fontWeight:600 }}>
                      <span style={{ color:C.muted, fontWeight:400 }}>Calls: </span>{f(lt.t)}
                    </div>
                    <div style={{ fontFamily:"monospace", color: lt.s>0?C.green:C.dim, fontWeight:700 }}>
                      <span style={{ color:C.muted, fontWeight:400 }}>Sales: </span>{lt.s}
                    </div>
                    <div style={{ fontFamily:"monospace", color: C.amber, fontWeight:600 }}>
                      <span style={{ color:C.muted, fontWeight:400 }}>Cls%: </span>{pct(lt.s, lt.t)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── TRANSFER VIEW (wrapper with toggle) ───────────────────────────────────────
function TransferView({ data, itdData, loading }: { data: DashData; itdData: DashData; loading: boolean }) {
  const [viewMode, setViewMode] = useState<ViewMode>("bylist");
  const lists     = data.allLists?.length ? data.allLists : Object.keys(data.byList);
  const crossData = data.aimByAgent ?? null;
  return (
    <div>
      <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
      {viewMode === "bylist"  && <ByListView data={data} itdData={itdData} loading={loading} />}
      {viewMode === "byagent" && <ByAgentView agents={
        // Build agents from ITD data (all agents), with selected-range metrics overlaid
        (() => {
          const itdAgents = itdData.byAgent || {};
          const rangeAgents = data.byAgent || {};
          // Merge: use all ITD agent names, populate range metrics from selected data
          const allNames = new Set([...Object.keys(itdAgents), ...Object.keys(rangeAgents)]);
          return Array.from(allNames).map(name => {
            const ra = (rangeAgents as any)[name];
            return {
              name,
              t: ra?.t ?? 0,
              o: 0,
              s: ra?.deals ?? 0,
              min: ra?.min ?? 0,
              cost: ra?.cost ?? 0,
            };
          });
        })()
      } lists={lists} crossData={crossData} itdData={itdData} loading={loading} />}
    </div>
  );
}

// ── META VIEW ─────────────────────────────────────────────────────────────────
function MetaView({ metaData, loading }: { metaData: MetaResponse | null; loading: boolean }) {
  if (loading) {
    return (
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", padding:"40px 20px" }}>
        <div style={{ width:24, height:24, borderRadius:"50%", border:`2px solid ${C.dim}`, borderTopColor:C.accent, animation:"spin 0.8s linear infinite" }} />
      </div>
    );
  }

  if (!metaData?.ok) {
    return <div style={{ padding:"20px", color:C.red }}>Error loading Meta data: {metaData?.error}</div>;
  }

  const { leads, summary } = metaData;

  const callStatusColor = (status: "transferred" | "answered" | "unanswered") => {
    if (status === "transferred") return C.green;
    if (status === "answered") return C.amber;
    return C.red;
  };

  const callStatusBg = (status: "transferred" | "answered" | "unanswered") => {
    if (status === "transferred") return "rgba(34,197,94,.15)";
    if (status === "answered") return "rgba(245,158,11,.15)";
    return "rgba(239,68,68,.15)";
  };

  const talkTimeColor = (secs: number) => {
    if (secs <= 30) return C.red;
    if (secs <= 420) return C.amber;
    return C.green;
  };

  const formatCallTime = (date: string, time: string) => {
    const [y, m, d] = date.split('-');
    return `${m}/${d} ${time}`;
  };

  const formatTalkTime = (secs: number) => {
    if (secs === 0) return "—";
    const mins = Math.floor(secs / 60);
    const sec = secs % 60;
    return mins > 0 ? `${mins}m ${sec}s` : `${sec}s`;
  };

  return (
    <div>
      {/* Summary Bar */}
      <div style={{ display:"flex", gap:12, padding:"12px 20px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexWrap:"wrap" }}>
        <div style={{ flex:"0 1 auto" }}>
          <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Total Leads</div>
          <div style={{ fontSize:18, fontWeight:700, color:C.text, fontFamily:"monospace" }}>{f(summary.totalLeads)}</div>
        </div>
        <div style={{ flex:"0 1 auto" }}>
          <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Transferred</div>
          <div style={{ fontSize:18, fontWeight:700, color:C.green, fontFamily:"monospace" }}>{f(summary.transferred)}</div>
        </div>
        <div style={{ flex:"0 1 auto" }}>
          <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Answered</div>
          <div style={{ fontSize:18, fontWeight:700, color:C.amber, fontFamily:"monospace" }}>{f(summary.answered)}</div>
        </div>
        <div style={{ flex:"0 1 auto" }}>
          <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Unanswered</div>
          <div style={{ fontSize:18, fontWeight:700, color:C.red, fontFamily:"monospace" }}>{f(summary.unanswered)}</div>
        </div>
        <div style={{ flex:"0 1 auto" }}>
          <div style={{ fontSize:10, color:C.muted, letterSpacing:".12em", textTransform:"uppercase", marginBottom:4 }}>Sold</div>
          <div style={{ fontSize:18, fontWeight:700, color:C.green, fontFamily:"monospace" }}>{f(summary.sold)}</div>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX:"auto" }}>
        <table style={{ borderCollapse:"collapse", width:"100%" }}>
          <thead>
            <tr>
              <Th left>Phone</Th>
              <Th>Call 1</Th>
              <Th>Call 2</Th>
              <Th>Call 3</Th>
              <Th>Call 4</Th>
              <Th>Call 5</Th>
              <Th>Call 6</Th>
              <Th>Talk Time (Mail 6)</Th>
              <Th>Sold</Th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead, idx) => (
              <tr key={lead.phone} onMouseEnter={e=>(e.currentTarget.style.background="rgba(0,212,184,.04)")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
                <Td style={{ textAlign:"left" }}>
                  <span style={{ color:lead.isSold?C.green:C.text, fontWeight:lead.isSold?700:500, fontFamily:"monospace" }}>
                    {lead.phone}
                  </span>
                </Td>

                {/* Call cells 1-6 */}
                {[0, 1, 2, 3, 4, 5].map(i => {
                  const call = lead.calls[i];
                  return (
                    <Td key={i} style={{ padding:"9px 8px" }}>
                      {call ? (
                        <div style={{
                          padding:"4px 8px",
                          borderRadius:3,
                          background:callStatusBg(call.status),
                          color:callStatusColor(call.status),
                          fontSize:11,
                          fontFamily:"monospace",
                          fontWeight:600,
                          textAlign:"center",
                          whiteSpace:"nowrap",
                        }}>
                          {formatCallTime(call.date, call.time)}
                        </div>
                      ) : (
                        <span style={{ color:C.dim, fontSize:11 }}>—</span>
                      )}
                    </Td>
                  );
                })}

                {/* Talk time */}
                <Td style={{ textAlign:"center" }}>
                  <span style={{ fontFamily:"monospace", fontSize:11, color:talkTimeColor(lead.mail6TalkTimeSec), fontWeight:600 }}>
                    {formatTalkTime(lead.mail6TalkTimeSec)}
                  </span>
                </Td>

                {/* Sold indicator */}
                <Td style={{ textAlign:"center" }}>
                  {lead.isSold ? (
                    <span style={{ color:C.green, fontWeight:700, fontSize:12 }}>✓ SOLD</span>
                  ) : (
                    <span style={{ color:C.dim, fontSize:11 }}>—</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {leads.length === 0 && (
        <div style={{ padding:"40px 20px", textAlign:"center", color:C.muted }}>
          No leads found for the selected date range.
        </div>
      )}
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
  const [agents, setAgents] = useState<AgentAssignment[]>([]);
  const setAgent = (name: string, campaign: AgentAssignment["campaign"]) =>
    setAgents(prev => prev.map(a => a.name === name ? { ...a, campaign } : a));
  const campaignColor = (c: AgentAssignment["campaign"]) =>
    c==="transfer"?C.accent : c==="outbound"?C.amber : c==="inbound"?C.green : C.muted;

  return (
    <div style={{ overflowX:"auto" }}>
      <table style={{ borderCollapse:"collapse", width:"100%" }}>
        <thead>
          <tr>
            <th style={{ background:C.surface, color:C.muted, fontSize:10, letterSpacing:".12em", textTransform:"uppercase", padding:"9px 14px", textAlign:"left", borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap" }}>Agent Name</th>
            <th style={{ background:C.surface, color:C.muted, fontSize:10, letterSpacing:".12em", textTransform:"uppercase", padding:"9px 14px", textAlign:"left", borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap" }}>Campaign</th>
          </tr>
        </thead>
        <tbody>
          {agents.map(a => (
            <tr key={a.name} onMouseEnter={e=>(e.currentTarget.style.background="rgba(0,212,184,.04)")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
              <td style={{ padding:"9px 14px", fontSize:13, borderBottom:`1px solid ${C.dim}`, color:C.text }}>{a.name}</td>
              <td style={{ padding:"9px 14px", fontSize:13, borderBottom:`1px solid ${C.dim}` }}>
                <select value={a.campaign} onChange={e => setAgent(a.name, e.target.value as AgentAssignment["campaign"])} style={{
                  padding:"4px 8px", borderRadius:4, border:`1px solid ${campaignColor(a.campaign)}`, background:"transparent", color:campaignColor(a.campaign),
                  fontSize:12, fontWeight:600, cursor:"pointer", textTransform:"capitalize",
                }}>
                  <option value="transfer">Transfer</option>
                  <option value="outbound">Outbound</option>
                  <option value="inbound">Inbound</option>
                  <option value="unassigned">Unassigned</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── SOURCE HEALTH BAR ─────────────────────────────────────────────────────────
function SourceHealthBar({ staleness }: { staleness: DashData["staleness"] }) {
  const now = Date.now();
  const sources = [
    { label: "AIM",  ts: staleness?.aim  },
    { label: "3CX",  ts: staleness?.cx   },
    { label: "MOXY", ts: staleness?.moxy },
  ];
  const getColor = (ts: string | null | undefined) => {
    if (!ts) return C.red;
    // staleness contains dates (YYYY-MM-DD)
    const tsDate = ts.length === 10 ? ts + "T23:59:59Z" : ts;
    const hrs = (now - new Date(tsDate).getTime()) / 3600000;
    if (hrs <= 24)  return C.green;
    if (hrs <= 48)  return C.amber;
    return C.red;
  };
  const getAge = (ts: string | null | undefined) => {
    if (!ts) return "never";
    // For date strings, show the date; for timestamps, show relative time
    if (ts.length === 10) return ts.slice(5); // "03-17"
    const hrs = (now - new Date(ts).getTime()) / 3600000;
    if (hrs < 1) return `${Math.round(hrs * 60)}m`;
    return `${Math.round(hrs)}h`;
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
  const [itdData, setItdData]         = useState<DashData>(DEMO);
  const [isLive, setIsLive]           = useState(false);
  const [loading, setLoading]         = useState(true);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaData, setMetaData]       = useState<MetaResponse | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string>("");
  const [campaign, setCampaign]       = useState<CampaignTab>("transfer");
  const [preset, setPreset]           = useState<DatePreset>("today");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd]     = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadData = useCallback(async (start: string | null, end: string | null) => {
    setLoading(true);
    setMetaLoading(true);
    setData(DEMO);
    try {
      // Single fetch for all data — full load every time
      const q = new URLSearchParams();
      if (start) q.set("start", start);
      if (end)   q.set("end", end);
      const qStr = q.toString() ? "?" + q.toString() : "";

      const res = await fetch(`/api/data${qStr}`);
      const json = await res.json();
      if (json?.hasData) { setData(json); setIsLive(true); }
      else               { setData(DEMO); setIsLive(false); }
      setLastRefresh(new Date().toLocaleTimeString());

      // Fetch ITD data once (no date filter) for left panel
      const resItd = await fetch('/api/data');
      const itdJson = await resItd.json();
      if (itdJson?.hasData) { setItdData(itdJson); }

      // Load Meta data
      const qsMeta = new URLSearchParams();
      if (start) qsMeta.set("start", start);
      if (end)   qsMeta.set("end", end);
      const qMeta = qsMeta.toString() ? "?" + qsMeta.toString() : "";
      const resMeta = await fetch(`/api/meta${qMeta}`);
      const metaJson = await resMeta.json();
      setMetaData(metaJson);
    } catch (e) {
      console.error('Data load error:', e);
      setIsLive(false);
    }
    finally { setLoading(false); setMetaLoading(false); }
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
    { id:"meta",         label:"Meta",          active:true  },
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
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ fontSize:16, fontWeight:700, color:C.text, letterSpacing:".06em", textTransform:"uppercase" }}>GPG — AI Voice Agent Dashboard</div>
              <button onClick={handleApply} disabled={loading} style={{ padding:"6px 12px", borderRadius:20, background:C.green, color:C.bg, border:"none", cursor:loading?"not-allowed":"pointer", fontSize:12, fontWeight:700, opacity:loading?0.5:1, display:"flex", alignItems:"center", gap:4 }}>
                ↻ Refresh
              </button>
            </div>
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
      </div>

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
          {campaign === "transfer"     && <TransferView data={data} itdData={itdData} loading={loading} />}
          {campaign === "outbound"     && <ComingSoon label="Outbound" />}
          {campaign === "inbound"      && <ComingSoon label="Inbound" />}
          {campaign === "meta"         && <MetaView metaData={metaData} loading={metaLoading} />}
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
