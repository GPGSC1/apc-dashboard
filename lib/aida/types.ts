// ─── AIDA Types ─────────────────────────────────────────────────────────────

/** Campaign as tracked by AIDA */
export interface AidaCampaign {
  id: number;
  name: string;
  listKey: string;
  currentConcurrentCalls: number;
  maxConcurrentCalls: number;
  minConcurrentCalls: number;
  status: "in_progress" | "paused" | "completed" | "not_launched";
  agentId: string;
  callsTotal: number;      // total leads in campaign
  callsCompleted: number;  // leads already called
}

/** AIDA operational mode */
export type AidaMode = "running" | "paused" | "cooldown" | "off" | "after_hours";

/** Persistent state stored in Vercel KV */
export interface AidaState {
  mode: AidaMode;
  cooldownUntil: number | null; // epoch ms
  lastTick: string; // ISO timestamp
  lastAction: string | null; // ISO timestamp of last non-HOLD action
  prePauseLevels: Record<string, number> | null; // campaignId -> concurrentCalls before pause
  campaigns: Record<string, AidaCampaign>;
}

/** AIDA configuration (thresholds, toggles) */
export interface AidaConfig {
  enabled: boolean; // false = dry-run mode
  thresholds: {
    rampUp: number; // waiting <= this → ramp up (default 1)
    holdMax: number; // waiting <= this → hold (default 4)
    throttleDown: number; // waiting >= this → throttle down (default 5)
    emergencyPause: number; // waiting >= this → pause all (default 10)
  };
  cooldownMinutes: number; // default 5
  stepPercent: number; // default 25
  resumePercent: number; // resume at this % of pre-pause levels (default 50)
  businessHours: {
    start: number; // hour in CT (default 8)
    end: number; // hour in CT (default 18)
    days: number[]; // 0=Sun, 1=Mon, ... (default [1,2,3,4,5])
  };
}

/** Wallboard poll result */
export interface WallboardSnapshot {
  totalWaiting: number;
  byQueue: Record<string, number>;
  timestamp: string; // ISO
}

/** Throttle decision output */
export type ThrottleActionType =
  | "RAMP_UP"
  | "HOLD"
  | "THROTTLE_DOWN"
  | "EMERGENCY_PAUSE"
  | "RESUME_FROM_COOLDOWN"
  | "AFTER_HOURS_PAUSE"
  | "NOOP";

export interface ThrottleAction {
  type: ThrottleActionType;
  newLevels?: Record<string, number>; // campaignId -> new concurrentCalls
  reason: string;
}

/** Action log entry (for self-learning) */
export interface AidaLogEntry {
  ts: string; // ISO timestamp
  totalWaiting: number;
  byQueue: Record<string, number>;
  action: ThrottleActionType;
  before: Record<string, number>; // campaignId -> concurrentCalls before
  after: Record<string, number>; // campaignId -> concurrentCalls after
  reason: string;
  dryRun: boolean;
}

/** Default configuration */
export const DEFAULT_CONFIG: AidaConfig = {
  enabled: false, // start in dry-run
  thresholds: {
    rampUp: 1,
    holdMax: 4,
    throttleDown: 5,
    emergencyPause: 10,
  },
  cooldownMinutes: 5,
  stepPercent: 25,
  resumePercent: 50,
  businessHours: {
    start: 8,
    end: 18,
    days: [1, 2, 3, 4, 5],
  },
};
