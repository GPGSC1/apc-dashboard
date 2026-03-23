import { NextRequest, NextResponse } from "next/server";
import { getState, setState, getConfig, setConfig, appendLog } from "../../../../lib/aida/kv-schema";
import { todayCentral } from "../../../../lib/aida/time";
import * as aim from "../../../../lib/aida/aim-control";
import { AidaLogEntry } from "../../../../lib/aida/types";

export const dynamic = "force-dynamic";

/**
 * Manual AIDA control endpoint.
 *
 * POST /api/aida/control
 * Body: { action: "pause" | "resume" | "enable" | "disable" | "refresh_campaigns" | "set_config", ...params }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  const state = await getState();
  const config = await getConfig();

  switch (action) {
    case "pause": {
      // Manual pause all campaigns
      if (!state) return NextResponse.json({ error: "AIDA not initialized" }, { status: 400 });
      const active = Object.values(state.campaigns).filter((c) => c.status === "in_progress");
      if (config.enabled) {
        await aim.pauseAll(active.map((c) => c.id));
      }
      state.prePauseLevels = {};
      for (const c of active) {
        state.prePauseLevels[String(c.id)] = c.currentConcurrentCalls;
        state.campaigns[String(c.id)].status = "paused";
      }
      state.mode = "paused";
      await setState(state);

      const logEntry: AidaLogEntry = {
        ts: new Date().toISOString(),
        totalWaiting: 0,
        byQueue: {},
        action: "EMERGENCY_PAUSE",
        before: Object.fromEntries(active.map((c) => [String(c.id), c.currentConcurrentCalls])),
        after: Object.fromEntries(active.map((c) => [String(c.id), 0])),
        reason: "Manual pause via /api/aida/control",
        dryRun: !config.enabled,
      };
      await appendLog(todayCentral(), logEntry);

      return NextResponse.json({ ok: true, action: "paused", campaigns: active.length });
    }

    case "resume": {
      // Manual resume — restore to pre-pause or specified levels
      if (!state) return NextResponse.json({ error: "AIDA not initialized" }, { status: 400 });
      const paused = Object.values(state.campaigns).filter((c) => c.status === "paused");
      for (const c of paused) {
        const level = state.prePauseLevels?.[String(c.id)] ?? c.maxConcurrentCalls;
        if (config.enabled) {
          await aim.resumeWithCalls(c.id, level);
        }
        state.campaigns[String(c.id)].status = "in_progress";
        state.campaigns[String(c.id)].currentConcurrentCalls = level;
      }
      state.mode = "running";
      state.cooldownUntil = null;
      state.prePauseLevels = null;
      await setState(state);

      return NextResponse.json({ ok: true, action: "resumed", campaigns: paused.length });
    }

    case "enable": {
      // Switch from dry-run to live mode
      config.enabled = true;
      await setConfig(config);
      return NextResponse.json({ ok: true, enabled: true });
    }

    case "disable": {
      // Switch to dry-run mode
      config.enabled = false;
      await setConfig(config);
      return NextResponse.json({ ok: true, enabled: false });
    }

    case "refresh_campaigns": {
      // Re-discover campaigns from AIM API
      if (!state) return NextResponse.json({ error: "AIDA not initialized" }, { status: 400 });
      const campaigns = await aim.listActiveCampaigns();
      for (const c of campaigns) {
        const existing = state.campaigns[String(c.id)];
        state.campaigns[String(c.id)] = {
          id: c.id,
          name: c.name,
          listKey: detectListKey(c.name),
          currentConcurrentCalls: c.concurrentCalls,
          maxConcurrentCalls: existing?.maxConcurrentCalls ?? Math.max(c.concurrentCalls, 30),
          minConcurrentCalls: existing?.minConcurrentCalls ?? 1,
          status: c.status as any,
          agentId: c.agentId,
        };
      }
      await setState(state);
      return NextResponse.json({ ok: true, campaigns: campaigns.length });
    }

    case "set_config": {
      // Update specific config fields
      const { thresholds, cooldownMinutes, stepPercent, businessHours, enabled } = body;
      if (thresholds) config.thresholds = { ...config.thresholds, ...thresholds };
      if (cooldownMinutes !== undefined) config.cooldownMinutes = cooldownMinutes;
      if (stepPercent !== undefined) config.stepPercent = stepPercent;
      if (businessHours) config.businessHours = { ...config.businessHours, ...businessHours };
      if (enabled !== undefined) config.enabled = enabled;
      await setConfig(config);
      return NextResponse.json({ ok: true, config });
    }

    default:
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 }
      );
  }
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
