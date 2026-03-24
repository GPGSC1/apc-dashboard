import { NextRequest, NextResponse } from "next/server";
import { getState, setState, getConfig, appendLog } from "../../../../lib/aida/kv-schema";
import { isBusinessHours, todayCentral } from "../../../../lib/aida/time";
import { pollAllQueues } from "../../../../lib/aida/wallboard";
import { evaluateThrottle } from "../../../../lib/aida/throttle";
import * as aim from "../../../../lib/aida/aim-control";
import { AidaState, AidaLogEntry } from "../../../../lib/aida/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  // ─── 1. Auth check ─────────────────────────────────────────────────────────
  // Vercel cron sets CRON_SECRET in Authorization header on Pro plan.
  // Also accept requests without auth for Hobby plan cron (no secret injected).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const config = await getConfig();
  let state = await getState();

  // ─── 2. Initialize state if first run ─────────────────────────────────────
  if (!state) {
    // Discover active campaigns from AIM
    const campaigns = await aim.listActiveCampaigns();
    const campaignMap: AidaState["campaigns"] = {};
    for (const c of campaigns) {
      campaignMap[String(c.id)] = {
        id: c.id,
        name: c.name,
        listKey: detectListKey(c.name),
        currentConcurrentCalls: c.concurrentCalls,
        maxConcurrentCalls: Math.max(c.concurrentCalls, 30), // default ceiling
        minConcurrentCalls: 1,
        status: c.status as any,
        agentId: c.agentId,
        callsTotal: c.callsTotal,
        callsCompleted: c.callsCompleted,
      };
    }
    state = {
      mode: "off",
      cooldownUntil: null,
      lastTick: new Date().toISOString(),
      lastAction: null,
      prePauseLevels: null,
      campaigns: campaignMap,
    };
    await setState(state);
    return NextResponse.json({ action: "INITIALIZED", campaigns: campaigns.length });
  }

  // ─── 3. Business hours gate ───────────────────────────────────────────────
  if (!isBusinessHours(config)) {
    if (state.mode !== "after_hours" && state.mode !== "off") {
      // Transition to after-hours — pause all campaigns
      const activeCampaigns = Object.values(state.campaigns).filter(
        (c) => c.status === "in_progress"
      );
      if (config.enabled && activeCampaigns.length > 0) {
        await aim.pauseAll(activeCampaigns.map((c) => c.id));
        for (const c of activeCampaigns) {
          state.campaigns[String(c.id)].status = "paused";
        }
      }
      state.mode = "after_hours";
      state.lastTick = new Date().toISOString();
      await setState(state);

      const logEntry: AidaLogEntry = {
        ts: new Date().toISOString(),
        totalWaiting: 0,
        byQueue: {},
        action: "AFTER_HOURS_PAUSE",
        before: buildLevelsMap(state),
        after: buildLevelsMap(state),
        reason: "Outside business hours — pausing all campaigns",
        dryRun: !config.enabled,
      };
      await appendLog(todayCentral(), logEntry);

      return NextResponse.json({ action: "AFTER_HOURS_PAUSE" });
    }
    return NextResponse.json({ action: "NOOP", reason: "After hours" });
  }

  // If coming back from after-hours, set mode to running
  if (state.mode === "after_hours" || state.mode === "off") {
    state.mode = "running";
  }

  // ─── 4. Poll wallboard ────────────────────────────────────────────────────
  let snapshot;
  try {
    snapshot = await pollAllQueues();
  } catch (e) {
    console.error("[AIDA tick] Wallboard poll failed:", e);
    return NextResponse.json({ action: "ERROR", error: String(e) }, { status: 500 });
  }

  // ─── 5. Evaluate throttle ────────────────────────────────────────────────
  const action = evaluateThrottle(state, config, snapshot);
  const beforeLevels = buildLevelsMap(state);

  // ─── 6. Execute action ────────────────────────────────────────────────────
  if (action.type === "EMERGENCY_PAUSE") {
    // Save pre-pause levels for later resume
    state.prePauseLevels = { ...beforeLevels };
    if (config.enabled) {
      const active = Object.values(state.campaigns).filter((c) => c.status === "in_progress");
      await aim.pauseAll(active.map((c) => c.id));
      for (const c of active) {
        state.campaigns[String(c.id)].status = "paused";
      }
    }
    state.mode = "cooldown";
    state.cooldownUntil = Date.now() + config.cooldownMinutes * 60 * 1000;
  } else if (action.type === "RESUME_FROM_COOLDOWN" && action.newLevels) {
    if (config.enabled) {
      for (const [id, calls] of Object.entries(action.newLevels)) {
        await aim.resumeWithCalls(Number(id), calls);
        state.campaigns[id].status = "in_progress";
        state.campaigns[id].currentConcurrentCalls = calls;
      }
    }
    state.mode = "running";
    state.cooldownUntil = null;
    state.prePauseLevels = null;
  } else if (
    (action.type === "RAMP_UP" || action.type === "THROTTLE_DOWN") &&
    action.newLevels
  ) {
    if (config.enabled) {
      for (const [id, calls] of Object.entries(action.newLevels)) {
        if (calls !== state.campaigns[id]?.currentConcurrentCalls) {
          await aim.setConcurrentCalls(Number(id), calls);
          state.campaigns[id].currentConcurrentCalls = calls;
        }
      }
    } else {
      // Dry-run: update state tracking without calling AIM
      for (const [id, calls] of Object.entries(action.newLevels)) {
        if (state.campaigns[id]) {
          state.campaigns[id].currentConcurrentCalls = calls;
        }
      }
    }
  }

  // ─── 7. Update state ─────────────────────────────────────────────────────
  state.lastTick = new Date().toISOString();
  if (action.type !== "HOLD" && action.type !== "NOOP") {
    state.lastAction = new Date().toISOString();
  }
  await setState(state);

  // ─── 8. Log action ───────────────────────────────────────────────────────
  const afterLevels = buildLevelsMap(state);
  const logEntry: AidaLogEntry = {
    ts: new Date().toISOString(),
    totalWaiting: snapshot.totalWaiting,
    byQueue: snapshot.byQueue,
    action: action.type,
    before: beforeLevels,
    after: afterLevels,
    reason: action.reason,
    dryRun: !config.enabled,
  };
  await appendLog(todayCentral(), logEntry);

  return NextResponse.json({
    action: action.type,
    reason: action.reason,
    totalWaiting: snapshot.totalWaiting,
    dryRun: !config.enabled,
    mode: state.mode,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildLevelsMap(state: AidaState): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const [id, c] of Object.entries(state.campaigns)) {
    levels[id] = c.currentConcurrentCalls;
  }
  return levels;
}

function detectListKey(name: string): string {
  if (!name) return "UNKNOWN";
  if (name.toLowerCase().includes("respond")) return "RT";
  const m = name.match(/([A-Za-z]{2})(\d{6})([A-Za-z]{2})/);
  if (m) return (m[1] + m[2] + m[3]).toUpperCase();
  const m2 = name.match(/([A-Za-z]{2})(\d{6})/);
  if (m2) return (m2[1] + m2[2]).toUpperCase();
  return "UNKNOWN";
}
