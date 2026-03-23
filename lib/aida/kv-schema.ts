import { Redis } from "@upstash/redis";
import {
  AidaState,
  AidaConfig,
  AidaLogEntry,
  DEFAULT_CONFIG,
} from "./types";

// ─── Redis client (singleton per invocation) ────────────────────────────────
let _redis: Redis | null = null;
export function redis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    });
  }
  return _redis;
}

// ─── Key constants ──────────────────────────────────────────────────────────
const KEY = {
  state: "aida:state",
  config: "aida:config",
  wbSession: "aida:wb:session",
  logIndex: "aida:log:index",
  logDay: (date: string) => `aida:log:${date}`,
} as const;

// ─── State ──────────────────────────────────────────────────────────────────
export async function getState(): Promise<AidaState | null> {
  return redis().get<AidaState>(KEY.state);
}

export async function setState(state: AidaState): Promise<void> {
  await redis().set(KEY.state, state);
}

// ─── Config ─────────────────────────────────────────────────────────────────
export async function getConfig(): Promise<AidaConfig> {
  const cfg = await redis().get<AidaConfig>(KEY.config);
  return cfg ?? DEFAULT_CONFIG;
}

export async function setConfig(config: AidaConfig): Promise<void> {
  await redis().set(KEY.config, config);
}

// ─── Wallboard session cookie ───────────────────────────────────────────────
export async function getWbSession(): Promise<string | null> {
  return redis().get<string>(KEY.wbSession);
}

export async function setWbSession(cookie: string): Promise<void> {
  // 15-minute TTL to avoid re-authenticating every tick
  await redis().set(KEY.wbSession, cookie, { ex: 900 });
}

// ─── Action log ─────────────────────────────────────────────────────────────
export async function appendLog(date: string, entry: AidaLogEntry): Promise<void> {
  const key = KEY.logDay(date);
  const existing = (await redis().get<AidaLogEntry[]>(key)) ?? [];
  existing.push(entry);
  // Keep logs for 90 days
  await redis().set(key, existing, { ex: 90 * 86400 });

  // Update index
  const index = (await redis().get<string[]>(KEY.logIndex)) ?? [];
  if (!index.includes(date)) {
    index.push(date);
    // Keep only last 90 entries
    if (index.length > 90) index.shift();
    await redis().set(KEY.logIndex, index);
  }
}

export async function getLog(date: string): Promise<AidaLogEntry[]> {
  return (await redis().get<AidaLogEntry[]>(KEY.logDay(date))) ?? [];
}

export async function getLogIndex(): Promise<string[]> {
  return (await redis().get<string[]>(KEY.logIndex)) ?? [];
}
