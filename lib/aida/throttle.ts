import { AidaConfig, AidaState, AidaCampaign, ThrottleAction, WallboardSnapshot } from "./types";

/**
 * Pure-function throttle decision engine.
 * Takes current state + wallboard snapshot → returns what action to take.
 * No side effects — caller is responsible for executing the action.
 */
export function evaluateThrottle(
  state: AidaState,
  config: AidaConfig,
  snapshot: WallboardSnapshot,
  nowMs: number = Date.now()
): ThrottleAction {
  const { totalWaiting } = snapshot;
  const { thresholds, cooldownMinutes, stepPercent, resumePercent } = config;
  const campaigns = Object.values(state.campaigns).filter(
    (c) => c.status === "in_progress" || c.status === "paused"
  );

  if (campaigns.length === 0) {
    return { type: "NOOP", reason: "No active campaigns to manage" };
  }

  // ─── Cooldown check ───────────────────────────────────────────────────────
  if (state.mode === "cooldown" && state.cooldownUntil) {
    if (nowMs < state.cooldownUntil) {
      const remainingSec = Math.round((state.cooldownUntil - nowMs) / 1000);
      return {
        type: "NOOP",
        reason: `In cooldown — ${remainingSec}s remaining`,
      };
    }
    // Cooldown expired — resume at reduced levels
    const newLevels: Record<string, number> = {};
    for (const c of campaigns) {
      const prePause = state.prePauseLevels?.[String(c.id)] ?? c.maxConcurrentCalls;
      const resumed = Math.max(
        c.minConcurrentCalls,
        Math.round(prePause * (resumePercent / 100))
      );
      newLevels[String(c.id)] = resumed;
    }
    return {
      type: "RESUME_FROM_COOLDOWN",
      newLevels,
      reason: `Cooldown expired — resuming at ${resumePercent}% of pre-pause levels`,
    };
  }

  // ─── Emergency pause ──────────────────────────────────────────────────────
  if (totalWaiting >= thresholds.emergencyPause) {
    return {
      type: "EMERGENCY_PAUSE",
      reason: `${totalWaiting} calls waiting (>= ${thresholds.emergencyPause}) — pausing all campaigns, ${cooldownMinutes}min cooldown`,
    };
  }

  // ─── Throttle down ────────────────────────────────────────────────────────
  if (totalWaiting >= thresholds.throttleDown) {
    const newLevels: Record<string, number> = {};
    const multiplier = 1 - stepPercent / 100;
    for (const c of campaigns) {
      if (c.status !== "in_progress") continue;
      const reduced = Math.max(
        c.minConcurrentCalls,
        Math.round(c.currentConcurrentCalls * multiplier)
      );
      newLevels[String(c.id)] = reduced;
    }
    return {
      type: "THROTTLE_DOWN",
      newLevels,
      reason: `${totalWaiting} calls waiting (>= ${thresholds.throttleDown}) — reducing by ${stepPercent}%`,
    };
  }

  // ─── Hold (dead band) ─────────────────────────────────────────────────────
  if (totalWaiting > thresholds.rampUp && totalWaiting <= thresholds.holdMax) {
    return {
      type: "HOLD",
      reason: `${totalWaiting} calls waiting (${thresholds.rampUp + 1}-${thresholds.holdMax} band) — holding steady`,
    };
  }

  // ─── Ramp up ──────────────────────────────────────────────────────────────
  if (totalWaiting <= thresholds.rampUp) {
    const newLevels: Record<string, number> = {};
    const multiplier = 1 + stepPercent / 100;
    let anyChange = false;
    for (const c of campaigns) {
      if (c.status !== "in_progress") continue;
      const increased = Math.min(
        c.maxConcurrentCalls,
        Math.round(c.currentConcurrentCalls * multiplier)
      );
      // Only ramp if we're below max
      if (increased > c.currentConcurrentCalls) {
        newLevels[String(c.id)] = increased;
        anyChange = true;
      } else {
        newLevels[String(c.id)] = c.currentConcurrentCalls;
      }
    }
    if (!anyChange) {
      return {
        type: "HOLD",
        reason: `${totalWaiting} calls waiting — all campaigns already at max`,
      };
    }
    return {
      type: "RAMP_UP",
      newLevels,
      reason: `${totalWaiting} calls waiting (<= ${thresholds.rampUp}) — increasing by ${stepPercent}%`,
    };
  }

  return { type: "NOOP", reason: "No action needed" };
}
