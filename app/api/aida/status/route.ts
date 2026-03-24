import { NextResponse } from "next/server";
import { getState, getConfig, getLog } from "../../../../lib/aida/kv-schema";
import { todayCentral, isBusinessHours, nowCentralDisplay } from "../../../../lib/aida/time";

export const dynamic = "force-dynamic";

export async function GET() {
  const [state, config, todayLog] = await Promise.all([
    getState(),
    getConfig(),
    getLog(todayCentral()),
  ]);

  const recentActions = todayLog.slice(-20); // last 20 entries

  return NextResponse.json({
    ok: true,
    state: state
      ? {
          mode: state.mode,
          cooldownUntil: state.cooldownUntil,
          lastTick: state.lastTick,
          lastAction: state.lastAction,
          campaigns: Object.values(state.campaigns).map((c) => ({
            id: c.id,
            name: c.name,
            listKey: c.listKey,
            concurrentCalls: c.currentConcurrentCalls,
            max: c.maxConcurrentCalls,
            status: c.status,
            agentName: (c as any).agentName ?? "Unknown",
            callsTotal: c.callsTotal ?? 0,
            callsCompleted: c.callsCompleted ?? 0,
          })),
        }
      : null,
    config: {
      enabled: config.enabled,
      thresholds: config.thresholds,
      cooldownMinutes: config.cooldownMinutes,
      stepPercent: config.stepPercent,
      businessHours: config.businessHours,
    },
    isBusinessHours: isBusinessHours(config),
    currentTimeCT: nowCentralDisplay(),
    recentActions,
  });
}
