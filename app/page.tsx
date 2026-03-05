"use client";
import { useState, useEffect } from "react";

// ── TYPES ────────────────────────────────────────────────────
interface ListStats { t: number; o: number; s: number; min: number; cost: number; }
interface AgentStats { calls: number; min: number; cost: number; t: number; deals: number; }
interface MatrixCell { t: number; o: number; d: number; }
interface DashData {
  byList: Record<string, ListStats>;
  byAgent: Record<string, AgentStats>;
  matrix: Record<string, Record<string, MatrixCell>>;
  nonListSales: NonListSale[];
  totalSales: number;
  listCost: Record<string, number>;
  loadedFiles: string[];
  lastUpdated: string;
  hasData: boolean;
  error?: string;
}
interface NonListSale {
  firstName: string; lastName: string; soldDate: string;
  promoCode: string; salesperson: string;
  homePhone: string; mobilePhone: string; onOpened: boolean;
}

// ── CONSTANTS ────────────────────────────────────────────────
const LISTS = ["RT", "JL(LP)", "BL", "JH", "JL(CR)", "DG", "JL(RS)"];
const AGENTS = ["Moxy OG", "Activation", "Female v3", "Moxy v2", "Male v3"];
const LIST_COST_DEFAULT: Record<string, number> = {
  RT: 0, "JL(LP)": 8000, BL: 8000, JH: 8000, "JL(CR)": 8000, DG: 5000, "JL(RS)": 6000,
};

// ── DEMO DATA ────────────────────────────────────────────────
const DEMO: DashData = {
  byList: {
    RT:       { t: 987, o: 597, s: 37, min: 8200,  cost: 1640 },
    "JL(LP)": { t: 208, o: 124, s: 6,  min: 1750,  cost: 350  },
    BL:       { t: 145, o: 93,  s: 4,  min: 1200,  cost: 240  },
    JH:       { t: 67,  o: 38,  s: 0,  min: 580,   cost: 116  },
    "JL(CR)": { t: 36,  o: 15,  s: 0,  min: 310,   cost: 62   },
    DG:       { t: 55,  o: 24,  s: 1,  min: 460,   cost: 92   },
    "JL(RS)": { t: 30,  o: 12,  s: 0,  min: 260,   cost: 52   },
  },
  byAgent: {
    "Moxy OG":   { calls: 12400, min: 9800, cost: 1960, t: 907, deals: 15 },
    Activation:  { calls: 2100,  min: 1680, cost: 336,  t: 170, deals: 9  },
    "Female v3": { calls: 1400,  min: 1120, cost: 224,  t: 112, deals: 6  },
    "Moxy v2":   { calls: 1050,  min: 840,  cost: 168,  t: 84,  deals: 4  },
    "Male v3":   { calls: 930,   min: 740,  cost: 148,  t: 74,  deals: 3  },
  },
  matrix: {
    "Moxy OG":   { RT:{t:550,o:340,d:10},"JL(LP)":{t:130,o:80,d:3},BL:{t:90,o:55,d:2},JH:{t:67,o:38,d:0},"JL(CR)":{t:36,o:15,d:0},DG:{t:30,o:14,d:0},"JL(RS)":{t:4,o:2,d:0} },
    Activation:  { RT:{t:100,o:60,d:4},"JL(LP)":{t:45,o:25,d:2},BL:{t:0,o:0,d:0},JH:{t:0,o:0,d:0},"JL(CR)":{t:0,o:0,d:0},DG:{t:25,o:10,d:1},"JL(RS)":{t:0,o:0,d:0} },
    "Female v3": { RT:{t:85,o:52,d:3},"JL(LP)":{t:27,o:16,d:2},BL:{t:0,o:0,d:0},JH:{t:0,o:0,d:0},"JL(CR)":{t:0,o:0,d:0},DG:{t:0,o:0,d:1},"JL(RS)":{t:0,o:0,d:0} },
    "Moxy v2":   { RT:{t:84,o:51,d:4},"JL(LP)":{t:0,o:0,d:0},BL:{t:0,o:0,d:0},JH:{t:0,o:0,d:0},"JL(CR)":{t:0,o:0,d:0},DG:{t:0,o:0,d:0},"JL(RS)":{t:0,o:0,d:0} },
    "Male v3":   { RT:{t:68,o:42,d:2},"JL(LP)":{t:6,o:3,d:1},BL:{t:0,o:0,d:0},JH:{t:0,o:0,d:0},"JL(CR)":{t:0,o:0,d:0},DG:{t:0,o:0,d:0},"JL(RS)":{t:0,o:0,d:0} },
  },
  nonListSales: [],
  totalSales: 48,
  listCost: LIST_COST_DEFAULT,
  loadedFiles: [],
  lastUpdated: new Date().toISOString(),
  hasData: false,
};

// ── UTILS ────────────────────────────────────────────────────
const f = (n: number) => (n || 0).toLocaleString();
const fc = (n: number) => "$" + (n || 0).toFixed(2);
const pct = (n: number, d: number) => d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—";

function ClosePct({ n, d }: { n: number; d: number }) {
  const v = d > 0 ? (n / d) * 100 : 0;
  const color = v >= 5 ? "#22C55E" : v >= 3 ? "#F59E0B" : "#3D5275";
  return <span style={{ fontFamily: "monospace", fontSize: 12, color }}>{pct(n, d)}</span>;
}

// ── COMPONENTS ───────────────────────────────────────────────
function ITDView({ data }: { data: DashData }) {
  const lc = data.listCost || LIST_COST_DEFAULT;
  const totals = LISTS.reduce(
    (a, li) => {
      const r = data.byList[li] || { t: 0, o: 0, s: 0, min: 0, cost: 0 };
      return { t: a.t + r.t, o: a.o + r.o, s: a.s + r.s, min: a.min + r.min, cost: a.cost + r.cost };
    },
    { t: 0, o: 0, s: 0, min: 0, cost: 0 }
  );
  const totalListCost = Object.values(lc).reduce((a, b) => a + b, 0);

  const kpis = [
    { label: "Transfers", val: f(totals.t), color: "#00D4B8" },
    { label: "Opened", val: f(totals.o), color: "#C8D6E8" },
    { label: "Sales", val: f(totals.s), color: "#22C55E" },
    { label: "Close Rate", val: pct(totals.s, totals.o), color: "#F59E0B" },
    { label: "Minutes", val: f(Math.round(totals.min)), color: "#3D5275" },
    { label: "Dial Cost", val: fc(totals.cost), color: "#3D5275" },
  ];

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 10, marginBottom: 20 }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ background: "#101525", border: "1px solid #1B2440", borderRadius: 7, padding: "13px 15px" }}>
            <div style={{ fontSize: 10, color: "#3D5275", fontFamily: "sans-serif", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontFamily: "monospace", fontSize: 22, color: k.color, fontWeight: "bold" }}>{k.val}</div>
          </div>
        ))}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["List", "List Cost", "Transfers", "Opened", "Sales", "Close %", "Minutes", "Dial Cost", "Cost/Sale"].map((h, i) => (
                <th key={h} style={{ background: "#0C0F1A", color: "#3D5275", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", padding: "9px 12px", textAlign: i === 0 ? "left" : "right", borderBottom: "1px solid #1B2440", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LISTS.map((li) => {
              const r = data.byList[li] || { t: 0, o: 0, s: 0, min: 0, cost: 0 };
              const listCost = lc[li] || 0;
              const cps = r.s > 0 ? (listCost + r.cost) / r.s : null;
              return (
                <tr key={li} style={{ borderBottom: "1px solid #1E2D45" }}>
                  <td style={{ padding: "8px 12px", textAlign: "left" }}>
                    <span style={{ color: "#00D4B8", fontWeight: 600, fontSize: 14 }}>{li}</span>
                    {(li === "JH" || li === "JL(CR)") && <span style={{ fontSize: 10, color: "#F59E0B", marginLeft: 6, opacity: .7 }}>direct-close</span>}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>{listCost > 0 ? fc(listCost) : <span style={{ color: "#3D5275" }}>free</span>}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#00D4B8" }}>{f(r.t)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>{f(r.o)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: r.s > 0 ? "#22C55E" : "#3D5275", fontWeight: r.s > 0 ? 600 : 400 }}>{r.s}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}><ClosePct n={r.s} d={r.o} /></td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#3D5275" }}>{f(Math.round(r.min))}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#3D5275" }}>{fc(r.cost)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>
                    {cps ? <span style={{ color: cps > 1000 ? "#EF4444" : cps > 500 ? "#F59E0B" : "#22C55E" }}>{fc(cps)}</span> : "—"}
                  </td>
                </tr>
              );
            })}
            <tr style={{ background: "#0C0F1A", fontWeight: 600, borderTop: "1px solid #1B2440" }}>
              <td style={{ padding: "8px 12px", textAlign: "left", color: "#C8D6E8", fontWeight: 700 }}>ITD TOTAL</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>{fc(totalListCost)}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#00D4B8" }}>{f(totals.t)}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>{f(totals.o)}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#22C55E", fontWeight: 700 }}>{totals.s}</td>
              <td style={{ padding: "8px 12px", textAlign: "right" }}><ClosePct n={totals.s} d={totals.o} /></td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#3D5275" }}>{f(Math.round(totals.min))}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#3D5275" }}>{fc(totals.cost)}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>
                {totals.s > 0 ? <span style={{ color: "#F59E0B" }}>{fc((totalListCost + totals.cost) / totals.s)}</span> : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatrixView({ data }: { data: DashData }) {
  return (
    <div>
      <div style={{ marginBottom: 10, fontSize: 11, color: "#3D5275" }}>
        Each cell: <span style={{ color: "#00D4B8" }}>Transfers</span> / <span style={{ color: "#C8D6E8" }}>Opened</span> / <span style={{ color: "#22C55E" }}>Deals</span> / Close%
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["Agent", ...LISTS, "Tot. T", "Tot. D", "Close %"].map((h, i) => (
                <th key={h} style={{ background: "#0C0F1A", color: "#3D5275", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", padding: "9px 12px", textAlign: i === 0 ? "left" : "right", borderBottom: "1px solid #1B2440", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AGENTS.map((agent) => {
              const m = data.matrix[agent] || {};
              let tT = 0, tD = 0, tO = 0;
              for (const li of LISTS) { const c = m[li] || { t: 0, o: 0, d: 0 }; tT += c.t; tD += c.d; tO += c.o; }
              return (
                <tr key={agent} style={{ borderBottom: "1px solid #1E2D45" }}>
                  <td style={{ padding: "8px 12px", textAlign: "left", color: "#C8D6E8", fontWeight: 600, fontSize: 13 }}>{agent}</td>
                  {LISTS.map((li) => {
                    const c = m[li] || { t: 0, o: 0, d: 0 };
                    if (!c.t && !c.o && !c.d) return <td key={li} style={{ padding: "8px 10px", textAlign: "right", color: "#1E2D45" }}>—</td>;
                    return (
                      <td key={li} style={{ padding: "5px 10px", textAlign: "right" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-end" }}>
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: "#00D4B8" }}>{f(c.t)}</span>
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: "#3D5275" }}>{f(c.o)}</span>
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: c.d > 0 ? "#22C55E" : "#1E2D45" }}>{c.d}</span>
                          <span style={{ fontFamily: "monospace", fontSize: 10, color: c.d > 0 ? "#F59E0B" : "#1E2D45" }}>{pct(c.d, c.o)}</span>
                        </div>
                      </td>
                    );
                  })}
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", color: "#00D4B8" }}>{f(tT)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", color: tD > 0 ? "#22C55E" : "#3D5275", fontWeight: 600 }}>{tD}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}><ClosePct n={tD} d={tO} /></td>
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
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {["Agent", "Calls", "Minutes", "Dial Cost", "Transfers", "Deals", "Close %", "Cost/Deal"].map((h, i) => (
              <th key={h} style={{ background: "#0C0F1A", color: "#3D5275", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", padding: "9px 12px", textAlign: i === 0 ? "left" : "right", borderBottom: "1px solid #1B2440", whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {AGENTS.map((agent) => {
            const a = data.byAgent[agent] || { calls: 0, min: 0, cost: 0, t: 0, deals: 0 };
            const cpd = a.deals > 0 ? a.cost / a.deals : null;
            return (
              <tr key={agent} style={{ borderBottom: "1px solid #1E2D45" }}>
                <td style={{ padding: "8px 12px", textAlign: "left", color: "#00D4B8", fontWeight: 600, fontSize: 14 }}>{agent}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>{f(a.calls)}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>{f(Math.round(a.min))}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#3D5275" }}>{fc(a.cost)}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: "#00D4B8" }}>{f(a.t)}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13, color: a.deals > 0 ? "#22C55E" : "#3D5275", fontWeight: 600 }}>{a.deals}</td>
                <td style={{ padding: "8px 12px", textAlign: "right" }}><ClosePct n={a.deals} d={a.t} /></td>
                <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>
                  {cpd ? <span style={{ color: cpd > 200 ? "#EF4444" : cpd > 100 ? "#F59E0B" : "#22C55E" }}>{fc(cpd)}</span> : "—"}
                </td>
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
    <div style={{ padding: "40px 24px", textAlign: "center", color: "#3D5275" }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>∅</div>
      <div style={{ fontSize: 14 }}>No non-list API sales detected</div>
    </div>
  );
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {["Name", "Date", "Promo", "Salesperson", "Home #", "Mobile #", "On Opened"].map((h, i) => (
              <th key={h} style={{ background: "#0C0F1A", color: "#3D5275", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", padding: "9px 12px", textAlign: i === 0 ? "left" : "right", borderBottom: "1px solid #1B2440" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sales.map((s, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #1E2D45" }}>
              <td style={{ padding: "8px 12px", color: "#C8D6E8" }}>{s.firstName} {s.lastName}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 12, color: "#3D5275" }}>{s.soldDate || "—"}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontSize: 11, color: "#F59E0B" }}>{s.promoCode}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", color: "#3D5275", fontSize: 12 }}>{s.salesperson}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 12, color: "#3D5275" }}>{s.homePhone || "—"}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 12, color: "#3D5275" }}>{s.mobilePhone || "—"}</td>
              <td style={{ padding: "8px 12px", textAlign: "center" }}>{s.onOpened ? <span style={{ color: "#22C55E" }}>✓</span> : <span style={{ color: "#1E2D45" }}>✗</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── MAIN APP ─────────────────────────────────────────────────
export default function Home() {
  const [data, setData] = useState<DashData>(DEMO);
  const [isDemo, setIsDemo] = useState(true);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("itd");

  useEffect(() => {
    fetch("/api/data")
      .then((r) => r.json())
      .then((d: DashData) => {
        if (d.error) { setIsDemo(true); }
        else if (d.hasData) { setData(d); setIsDemo(false); }
        else { setIsDemo(true); }
      })
      .catch(() => setIsDemo(true))
      .finally(() => setLoading(false));
  }, []);

  const tabs = [
    { id: "itd", label: "ITD by List" },
    { id: "matrix", label: "Agent × List" },
    { id: "agents", label: "Agent Summary" },
    { id: "nonlist", label: "Non-List Sales" },
  ];

  const sideTotal = LISTS.reduce((a, li) => a + (data.byList[li]?.s || 0), 0);

  return (
    <div style={{ background: "#06080F", minHeight: "100vh", color: "#C8D6E8", fontFamily: "system-ui, sans-serif" }}>
      {/* HEADER */}
      <div style={{ background: "#0C0F1A", borderBottom: "1px solid #1B2440", padding: "13px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00D4B8", boxShadow: "0 0 10px #00D4B8", animation: "pulse 2s infinite" }} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#C8D6E8", letterSpacing: ".06em", textTransform: "uppercase" }}>
              APC — AI Voice Agent Dashboard
            </div>
            <div style={{ fontSize: 10, color: "#3D5275", marginTop: 1 }}>
              Auto Protection Center · AIM Now / Moxy · AI-Attributed Sales Only
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {loading && <span style={{ fontSize: 11, color: "#3D5275" }}>Loading...</span>}
          <span style={{
            display: "inline-block", padding: "2px 8px", borderRadius: 3, fontSize: 10,
            fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase",
            background: isDemo ? "rgba(245,158,11,.12)" : "rgba(34,197,94,.12)",
            color: isDemo ? "#F59E0B" : "#22C55E",
            border: `1px solid ${isDemo ? "rgba(245,158,11,.3)" : "rgba(34,197,94,.3)"}`,
          }}>
            {isDemo ? "Demo Mode" : "Live Data"}
          </span>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: "#3D5275" }}>
            {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 56px)" }}>
        {/* SIDEBAR */}
        <div style={{ width: 200, flexShrink: 0, background: "#0C0F1A", borderRight: "1px solid #1B2440", padding: "16px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          
          {/* Files loaded indicator */}
          <div style={{ fontSize: 10, color: "#3D5275", letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 4 }}>
            Data Files
          </div>
          {["opened.csv", "transfer.csv", "sales.xls", "minutes.xlsx"].map((f) => {
            const loaded = data.loadedFiles?.some((lf) => lf.toLowerCase().startsWith(f.split(".")[0]));
            return (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "#101525", borderRadius: 4, border: `1px solid ${loaded ? "rgba(34,197,94,.3)" : "#1B2440"}` }}>
                <span style={{ color: loaded ? "#22C55E" : "#1E2D45", fontSize: 12 }}>{loaded ? "✓" : "○"}</span>
                <span style={{ fontSize: 11, color: loaded ? "#C8D6E8" : "#3D5275" }}>{f}</span>
              </div>
            );
          })}

          <div style={{ fontSize: 10, color: "#3D5275", letterSpacing: ".12em", textTransform: "uppercase", marginTop: 8 }}>
            List Files
          </div>
          {LISTS.map((li) => {
            const fname = `list_${li.replace(/[()]/g, "").toLowerCase()}.csv`;
            const loaded = data.loadedFiles?.some((lf) => lf.toLowerCase().includes(li.replace(/[()]/g, "").toLowerCase()) && lf.toLowerCase().startsWith("list_"));
            return (
              <div key={li} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "#101525", borderRadius: 4, border: `1px solid ${loaded ? "rgba(0,212,184,.2)" : "#1B2440"}` }}>
                <span style={{ color: loaded ? "#00D4B8" : "#1E2D45", fontSize: 12 }}>{loaded ? "✓" : "○"}</span>
                <span style={{ fontSize: 11, color: loaded ? "#00D4B8" : "#3D5275", fontWeight: loaded ? 600 : 400 }}>{li}</span>
                <span style={{ fontSize: 9, color: "#3D5275", marginLeft: "auto" }}>{fname}</span>
              </div>
            );
          })}

          <button
            onClick={() => { setLoading(true); fetch("/api/data").then(r => r.json()).then(d => { if (d.hasData) { setData(d); setIsDemo(false); } }).finally(() => setLoading(false)); }}
            style={{ marginTop: 8, padding: "9px 0", background: "#00D4B8", color: "#06080F", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 700, fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase" }}>
            ↻ Refresh
          </button>

          {/* Mini snapshot */}
          <div style={{ marginTop: "auto", paddingTop: 14, borderTop: "1px solid #1E2D45" }}>
            <div style={{ fontSize: 10, color: "#3D5275", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 8 }}>ITD Snapshot</div>
            {LISTS.map((li) => {
              const r = data.byList[li] || { t: 0, s: 0 };
              return (
                <div key={li} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", borderBottom: "1px solid #1E2D45" }}>
                  <span style={{ fontSize: 12, color: "#00D4B8" }}>{li}</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: "#3D5275" }}>{r.t}T</span>
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: r.s > 0 ? "#22C55E" : "#1E2D45" }}>{r.s}S</span>
                  </span>
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6 }}>
              <span style={{ fontSize: 12, color: "#C8D6E8", fontWeight: 600 }}>Total</span>
              <span style={{ fontFamily: "monospace", fontSize: 12, color: "#22C55E", fontWeight: 600 }}>{sideTotal} sales</span>
            </div>
          </div>
        </div>

        {/* MAIN CONTENT */}
        <div style={{ flex: 1, padding: "18px 22px", minWidth: 0 }}>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid #1B2440", marginBottom: 18 }}>
            {tabs.map((t) => (
              <div key={t.id} onClick={() => setTab(t.id)}
                style={{ padding: "8px 16px", cursor: "pointer", fontSize: 13, letterSpacing: ".08em", textTransform: "uppercase", borderBottom: `2px solid ${tab === t.id ? "#00D4B8" : "transparent"}`, color: tab === t.id ? "#00D4B8" : "#3D5275", transition: "all .2s" }}>
                {t.label}
              </div>
            ))}
          </div>

          {/* Content */}
          <div style={{ background: "#101525", border: "1px solid #1B2440", borderRadius: 8, padding: 18 }}>
            {tab === "itd" && <ITDView data={data} />}
            {tab === "matrix" && <MatrixView data={data} />}
            {tab === "agents" && <AgentView data={data} />}
            {tab === "nonlist" && <NonListView data={data} />}
          </div>

          {/* How to update */}
          {isDemo && (
            <div style={{ marginTop: 16, padding: "14px 16px", background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: "#F59E0B", fontWeight: 600, marginBottom: 8 }}>📁 How to load your data</div>
              <div style={{ fontSize: 11, color: "#3D5275", lineHeight: "1.8" }}>
                Add files to the <code style={{ color: "#00D4B8", background: "#0C0F1A", padding: "1px 4px", borderRadius: 3 }}>/data</code> folder in your repo with these exact names:<br />
                <code style={{ color: "#C8D6E8" }}>opened.csv</code> · <code style={{ color: "#C8D6E8" }}>transfer.csv</code> · <code style={{ color: "#C8D6E8" }}>sales.xls</code> · <code style={{ color: "#C8D6E8" }}>minutes.xlsx</code><br />
                List files: <code style={{ color: "#00D4B8" }}>list_RT.csv</code> · <code style={{ color: "#00D4B8" }}>list_BL.csv</code> · <code style={{ color: "#00D4B8" }}>list_JH.csv</code> · <code style={{ color: "#00D4B8" }}>list_DG.csv</code> · <code style={{ color: "#00D4B8" }}>list_JLLP.csv</code> · <code style={{ color: "#00D4B8" }}>list_JLCR.csv</code> · <code style={{ color: "#00D4B8" }}>list_JLRS.csv</code>
              </div>
            </div>
          )}

          {!isDemo && data.lastUpdated && (
            <div style={{ marginTop: 10, fontSize: 10, color: "#3D5275", textAlign: "right" }}>
              Last updated: {new Date(data.lastUpdated).toLocaleString()}
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
    </div>
  );
}
