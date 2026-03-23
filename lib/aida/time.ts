import { AidaConfig, DEFAULT_CONFIG } from "./types";

/** Get current Date in Central Time */
export function nowCentral(): Date {
  const utc = new Date();
  // Intl gives us the correct offset including DST
  const ct = new Date(
    utc.toLocaleString("en-US", { timeZone: "America/Chicago" })
  );
  return ct;
}

/** Get today's date string (YYYY-MM-DD) in Central Time */
export function todayCentral(): string {
  const d = nowCentral();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Check if current time is within business hours */
export function isBusinessHours(
  config: Pick<AidaConfig, "businessHours"> = DEFAULT_CONFIG
): boolean {
  const now = nowCentral();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  const hour = now.getHours();

  if (!config.businessHours.days.includes(day)) return false;
  if (hour < config.businessHours.start) return false;
  if (hour >= config.businessHours.end) return false;
  return true;
}
