"use client";
import { useState, useEffect, useCallback, useRef } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────
interface StatusCampaign {
  id: number;
  name: string;
  listKey: string;
  concurrentCalls: number;
  max: number;
  status: "in_progress" | "paused" | "completed" | "not_launched";
  callsTotal: number;
  callsCompleted: number;
}

interface LogEntry {
  ts: string;
  totalWaiting: number;
  byQueue: Record<string, number>;
  action: string;
  before: Record<string, number>;
  after: Record<string, number>;
  reason: string;
  dryRun: boolean;
}

interface AidaStatus {
  ok: boolean;
  state: {
    mode: string;
    cooldownUntil: number | null;
    lastTick: string;
    lastAction: string | null;
    campaigns: StatusCampaign[];
  } | null;
  config: {
    enabled: boolean;
    thresholds: { rampUp: number; holdMax: number; throttleDown: number; emergencyPause: number };
    cooldownMinutes: number;
    stepPercent: number;
    businessHours: { start: number; end: number; days: number[] };
  };
  isBusinessHours: boolean;
  currentTimeCT: string;
  recentActions: LogEntry[];
}

// ─── Colors & Constants ─────────────────────────────────────────────────────
const C = {
  bg: "#06080F", surface: "#0C0F1A", card: "#101525", border: "#1B2440",
  accent: "#00D4B8", amber: "#F59E0B", red: "#EF4444", green: "#22C55E",
  text: "#C8D6E8", muted: "#3D5275", dim: "#1E2D45",
};

const POLL_MS = 30_000;

const MODE_COLOR: Record<string, string> = {
  running: C.green, paused: C.red, cooldown: C.amber, off: C.red, after_hours: C.muted,
};

const ACTION_COLOR: Record<string, string> = {
  RAMP_UP: C.green, HOLD: C.muted, THROTTLE_DOWN: C.amber,
  EMERGENCY_PAUSE: C.red, RESUME_FROM_COOLDOWN: C.accent,
  AFTER_HOURS_PAUSE: C.dim, NOOP: C.dim,
};

function queueColor(n: number): string {
  if (n >= 10) return C.red;
  if (n >= 5) return C.red;
  if (n >= 2) return C.amber;
  return C.green;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
    });
  } catch { return iso; }
}

function fmtTimeShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: true,
    });
  } catch { return iso; }
}

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Main Page ──────────────────────────────────────────────────────────────
export default function AidaPage() {
  const [data, setData] = useState<AidaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(POLL_MS / 1000);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [campaignTab, setCampaignTab] = useState<"in_progress" | "paused" | "completed">("in_progress");
  const countdownRef = useRef(POLL_MS / 1000);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/aida/status");
      const json = await res.json();
      setData(json);
      setError(null);
      countdownRef.current = POLL_MS / 1000;
      setCountdown(POLL_MS / 1000);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    const poll = setInterval(fetchStatus, POLL_MS);
    const tick = setInterval(() => {
      countdownRef.current = Math.max(0, countdownRef.current - 1);
      setCountdown(countdownRef.current);
    }, 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [fetchStatus]);

  const handleControl = useCallback(async (action: string) => {
    setActionLoading(action);
    try {
      await fetch("/api/aida/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(null);
    }
  }, [fetchStatus]);

  const state = data?.state;
  const config = data?.config;
  const actions = data?.recentActions ?? [];
  const latestAction = actions.length > 0 ? actions[actions.length - 1] : null;
  const campaigns = state?.campaigns ?? [];
  const campaignMap = new Map(campaigns.map(c => [String(c.id), c]));

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* ── STATUS HEADER ─────────────────────────────────────── */}
      <div style={{
        position: "sticky", top: 0, zIndex: 50, background: C.surface,
        borderBottom: `1px solid ${C.border}`, padding: "12px 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        {/* Left */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 10, height: 10, borderRadius: "50%",
            background: state ? MODE_COLOR[state.mode] ?? C.muted : C.dim,
            animation: state?.mode === "running" ? "pulse 2s ease-in-out infinite" : "none",
          }} />
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: ".08em", color: C.accent }}>AIDA</span>
          {state && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 12,
              background: `${MODE_COLOR[state.mode] ?? C.muted}22`,
              color: MODE_COLOR[state.mode] ?? C.muted, textTransform: "uppercase",
            }}>
              {state.mode}
            </span>
          )}
          {config && !config.enabled && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 12,
              background: `${C.amber}22`, color: C.amber, textTransform: "uppercase",
            }}>
              DRY RUN
            </span>
          )}
        </div>

        {/* Center */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 12 }}>
          {state?.lastTick && (
            <span style={{ color: C.muted }}>
              Last tick: <span style={{ color: C.text, fontFamily: "monospace" }}>{fmtTime(state.lastTick)}</span>
            </span>
          )}
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: data?.isBusinessHours ? C.green : C.dim,
            }} />
            <span style={{ color: data?.isBusinessHours ? C.green : C.muted, fontSize: 11 }}>
              {data?.isBusinessHours ? "Business Hours" : "After Hours"}
            </span>
          </span>
        </div>

        {/* Right */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: C.muted }}>
            {data?.currentTimeCT ?? "—"}
          </span>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: C.dim }}>
            {countdown}s
          </span>
          <button
            onClick={fetchStatus}
            style={{
              background: C.accent, color: C.bg, border: "none", borderRadius: 20,
              padding: "5px 16px", fontWeight: 700, fontSize: 12, cursor: "pointer",
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── ERROR BANNER ──────────────────────────────────────── */}
      {error && (
        <div style={{ background: `${C.red}22`, border: `1px solid ${C.red}`, borderRadius: 6, padding: "8px 16px", margin: "12px 20px", color: C.red, fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* ── NOT INITIALIZED ───────────────────────────────────── */}
      {!loading && !state && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "60vh" }}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 32, textAlign: "center" }}>
            <div style={{ fontSize: 14, color: C.muted, marginBottom: 16 }}>AIDA has not been initialized yet.</div>
            <button
              onClick={() => handleControl("refresh_campaigns")}
              disabled={actionLoading !== null}
              style={{
                background: C.accent, color: C.bg, border: "none", borderRadius: 6,
                padding: "8px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer",
              }}
            >
              {actionLoading === "refresh_campaigns" ? "Initializing..." : "Initialize AIDA"}
            </button>
          </div>
        </div>
      )}

      {state && config && (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ── TOP ROW: Queue Monitor + Campaign Table ────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 16 }}>

            {/* QUEUE MONITOR */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20 }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 12 }}>
                Calls Waiting
              </div>
              {latestAction ? (
                <>
                  <div style={{
                    fontFamily: "monospace", fontSize: 56, fontWeight: 800, lineHeight: 1,
                    color: queueColor(latestAction.totalWaiting),
                    animation: latestAction.totalWaiting >= 10 ? "flash 1s ease-in-out infinite" : "none",
                    marginBottom: 8,
                  }}>
                    {latestAction.totalWaiting}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 16 }}>
                    as of {fmtTime(latestAction.ts)}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                    {Object.entries(latestAction.byQueue).map(([name, count]) => (
                      <div key={name} style={{
                        background: C.surface, borderRadius: 6, padding: "8px 6px", textAlign: "center",
                        border: `1px solid ${C.dim}`,
                      }}>
                        <div style={{ fontSize: 9, color: C.muted, marginBottom: 4, textTransform: "uppercase" }}>{name}</div>
                        <div style={{
                          fontFamily: "monospace", fontSize: 18, fontWeight: 700,
                          color: queueColor(count as number),
                          animation: (count as number) >= 10 ? "flash 1s ease-in-out infinite" : "none",
                        }}>
                          {count as number}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: C.muted }}>No data yet — waiting for first tick</div>
              )}
            </div>

            {/* CAMPAIGN TABLE */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
              {/* Campaign Status Tabs */}
              <div style={{ display: "flex", alignItems: "center", gap: 0, borderBottom: `1px solid ${C.border}` }}>
                {([
                  { key: "in_progress" as const, label: "In Progress", count: campaigns.filter(c => c.status === "in_progress").length },
                  { key: "paused" as const, label: "Paused", count: campaigns.filter(c => c.status === "paused").length },
                  { key: "completed" as const, label: "Completed", count: campaigns.filter(c => c.status === "completed").length },
                ]).map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setCampaignTab(tab.key)}
                    style={{
                      background: campaignTab === tab.key ? C.surface : "transparent",
                      color: campaignTab === tab.key ? C.accent : C.muted,
                      border: "none", borderBottom: campaignTab === tab.key ? `2px solid ${C.accent}` : "2px solid transparent",
                      padding: "10px 16px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                      textTransform: "uppercase", letterSpacing: ".08em",
                    }}
                  >
                    {tab.label} <span style={{ fontFamily: "monospace", marginLeft: 4, opacity: 0.7 }}>({tab.count})</span>
                  </button>
                ))}
              </div>
              <div style={{ overflowY: "auto", maxHeight: 400 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: C.surface }}>
                      {["List", "Campaign", campaignTab === "completed" ? "" : "Calls", campaignTab === "completed" ? "" : "Max", "List Progress"].filter(Boolean).map(h => (
                        <th key={h} style={{
                          padding: "8px 12px", fontSize: 10, color: C.muted, textTransform: "uppercase",
                          letterSpacing: ".12em", textAlign: h === "Campaign" ? "left" : "center",
                          borderBottom: `1px solid ${C.border}`,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...campaigns]
                      .filter(c => c.status === campaignTab)
                      .sort((a, b) => a.listKey.localeCompare(b.listKey) || a.name.localeCompare(b.name))
                      .map(c => {
                        return (
                          <tr key={c.id} style={{ borderBottom: `1px solid ${C.dim}` }}>
                            <td style={{ padding: "7px 12px", fontSize: 11, color: C.accent, fontWeight: 600, textAlign: "center" }}>
                              {c.listKey === "UNKNOWN" ? <span style={{ color: C.dim }}>—</span> : c.listKey}
                            </td>
                            <td style={{ padding: "7px 12px", fontSize: 11, color: C.text, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {c.name}
                            </td>
                            {campaignTab !== "completed" && (
                              <td style={{ padding: "7px 12px", fontFamily: "monospace", fontSize: 13, textAlign: "center", fontWeight: 600, color: C.text }}>
                                {c.concurrentCalls}
                              </td>
                            )}
                            {campaignTab !== "completed" && (
                              <td style={{ padding: "7px 12px", fontFamily: "monospace", fontSize: 12, textAlign: "center", color: C.muted }}>
                                {c.max}
                              </td>
                            )}
                            <td style={{ padding: "7px 12px", textAlign: "center" }}>
                              {c.callsTotal > 0 ? (
                                <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <div style={{ width: 60, height: 6, background: C.dim, borderRadius: 3, position: "relative" }}>
                                    <div style={{
                                      height: "100%", borderRadius: 3,
                                      width: `${Math.min((c.callsCompleted / c.callsTotal) * 100, 100)}%`,
                                      background: (c.callsCompleted / c.callsTotal) >= 0.9 ? C.red
                                        : (c.callsCompleted / c.callsTotal) >= 0.7 ? C.amber : C.accent,
                                    }} />
                                  </div>
                                  <span style={{ fontFamily: "monospace", fontSize: 10, color: C.muted }}>
                                    {Math.round((c.callsCompleted / c.callsTotal) * 100)}%
                                  </span>
                                </div>
                              ) : (
                                <span style={{ color: C.dim, fontSize: 10 }}>—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── BOTTOM ROW: Action Log + Controls ─────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16 }}>

            {/* ACTION LOG */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 12 }}>
                Action Log ({actions.length} entries today)
              </div>
              <div style={{ maxHeight: 400, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                {actions.length === 0 && (
                  <div style={{ fontSize: 12, color: C.muted, padding: 16, textAlign: "center" }}>No actions logged today</div>
                )}
                {[...actions].reverse().map((entry, i) => {
                  const isMinor = entry.action === "HOLD" || entry.action === "NOOP";
                  const changes = Object.keys(entry.after).filter(id => entry.before[id] !== entry.after[id]);

                  return (
                    <div key={i} style={{
                      padding: isMinor ? "4px 8px" : "8px 10px",
                      background: isMinor ? "transparent" : C.surface,
                      borderRadius: 6, borderLeft: `3px solid ${ACTION_COLOR[entry.action] ?? C.dim}`,
                      opacity: isMinor ? 0.6 : 1,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "monospace", fontSize: 10, color: C.dim }}>{fmtTimeShort(entry.ts)}</span>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: "1px 7px", borderRadius: 8,
                          background: `${ACTION_COLOR[entry.action] ?? C.dim}22`,
                          color: ACTION_COLOR[entry.action] ?? C.dim,
                        }}>
                          {entry.action}
                        </span>
                        <span style={{ fontFamily: "monospace", fontSize: 11, color: queueColor(entry.totalWaiting) }}>
                          {entry.totalWaiting} waiting
                        </span>
                        {entry.dryRun && (
                          <span style={{ fontSize: 9, color: C.amber, fontWeight: 600 }}>(dry)</span>
                        )}
                      </div>
                      {!isMinor && (
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{entry.reason}</div>
                      )}
                      {changes.length > 0 && !isMinor && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                          {changes.slice(0, 8).map(id => {
                            const camp = campaignMap.get(id);
                            const label = camp ? (camp.listKey !== "UNKNOWN" ? camp.listKey : `#${id}`) : `#${id}`;
                            return (
                              <span key={id} style={{
                                fontSize: 10, fontFamily: "monospace", color: C.text,
                                background: C.dim, padding: "1px 6px", borderRadius: 4,
                              }}>
                                {label}: {entry.before[id]}→{entry.after[id]}
                              </span>
                            );
                          })}
                          {changes.length > 8 && (
                            <span style={{ fontSize: 10, color: C.muted }}>+{changes.length - 8} more</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* CONTROLS PANEL */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

              {/* Action Buttons */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 12 }}>
                  Controls
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    onClick={() => handleControl(config.enabled ? "disable" : "enable")}
                    disabled={actionLoading !== null}
                    style={{
                      background: config.enabled ? `${C.red}22` : `${C.green}22`,
                      color: config.enabled ? C.red : C.green,
                      border: `1px solid ${config.enabled ? C.red : C.green}`,
                      borderRadius: 6, padding: "8px 16px", fontWeight: 700, fontSize: 12,
                      cursor: "pointer", width: "100%",
                    }}
                  >
                    {actionLoading === "enable" || actionLoading === "disable"
                      ? "Updating..."
                      : config.enabled ? "⏸ Disable (Switch to Dry Run)" : "▶ Enable (Go Live)"}
                  </button>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <button
                      onClick={() => handleControl("pause")}
                      disabled={actionLoading !== null || state.mode === "paused" || state.mode === "off"}
                      style={{
                        background: C.surface, color: C.red, border: `1px solid ${C.dim}`,
                        borderRadius: 6, padding: "7px 12px", fontWeight: 600, fontSize: 11,
                        cursor: "pointer", opacity: state.mode === "paused" ? 0.4 : 1,
                      }}
                    >
                      {actionLoading === "pause" ? "..." : "⏹ Pause All"}
                    </button>
                    <button
                      onClick={() => handleControl("resume")}
                      disabled={actionLoading !== null || state.mode !== "paused"}
                      style={{
                        background: C.surface, color: C.green, border: `1px solid ${C.dim}`,
                        borderRadius: 6, padding: "7px 12px", fontWeight: 600, fontSize: 11,
                        cursor: "pointer", opacity: state.mode !== "paused" ? 0.4 : 1,
                      }}
                    >
                      {actionLoading === "resume" ? "..." : "▶ Resume All"}
                    </button>
                  </div>
                  <button
                    onClick={() => handleControl("refresh_campaigns")}
                    disabled={actionLoading !== null}
                    style={{
                      background: C.surface, color: C.accent, border: `1px solid ${C.dim}`,
                      borderRadius: 6, padding: "7px 12px", fontWeight: 600, fontSize: 11,
                      cursor: "pointer", width: "100%",
                    }}
                  >
                    {actionLoading === "refresh_campaigns" ? "Refreshing..." : "↻ Refresh Campaigns"}
                  </button>
                </div>
              </div>

              {/* Config Display */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 12 }}>
                  Configuration
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 9, color: C.muted, marginBottom: 4 }}>THRESHOLDS</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      {[
                        { label: "Ramp Up ≤", val: config.thresholds.rampUp, color: C.green },
                        { label: "Hold ≤", val: config.thresholds.holdMax, color: C.text },
                        { label: "Throttle ≥", val: config.thresholds.throttleDown, color: C.amber },
                        { label: "Emergency ≥", val: config.thresholds.emergencyPause, color: C.red },
                      ].map(t => (
                        <div key={t.label} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                          <span style={{ fontSize: 11, color: C.muted }}>{t.label}</span>
                          <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: t.color }}>{t.val}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <div>
                      <div style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>STEP %</div>
                      <div style={{ fontFamily: "monospace", fontSize: 13, color: C.text }}>{config.stepPercent}%</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>COOLDOWN</div>
                      <div style={{ fontFamily: "monospace", fontSize: 13, color: C.text }}>{config.cooldownMinutes} min</div>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>BUSINESS HOURS</div>
                    <div style={{ fontFamily: "monospace", fontSize: 12, color: C.text }}>
                      {config.businessHours.start}:00 – {config.businessHours.end}:00 CT
                    </div>
                    <div style={{ fontSize: 11, color: C.muted }}>
                      {config.businessHours.days.map(d => dayNames[d]).join(", ")}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CSS Animations ────────────────────────────────────── */}
      <style>{`
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.3 } }
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes flash { 0%,100% { opacity:1 } 50% { opacity:.2 } }
        button:hover { filter: brightness(1.1); }
        button:disabled { cursor: not-allowed !important; filter: brightness(0.7); }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${C.surface}; }
        ::-webkit-scrollbar-thumb { background: ${C.dim}; border-radius: 3px; }
      `}</style>
    </div>
  );
}
