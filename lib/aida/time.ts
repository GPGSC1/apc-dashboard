import { AidaConfig, DEFAULT_CONFIG } from "./types";

const CT_TZ = "America/Chicago";

/** Get individual date/time parts in Central Time */
function centralParts(): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value])
  );
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(parts.year),
    month: parseInt(parts.month),
    day: parseInt(parts.day),
    hour: parseInt(parts.hour === "24" ? "0" : parts.hour),
    minute: parseInt(parts.minute),
    dow: dowMap[parts.weekday] ?? 0,
  };
}

/** Get current time as a display string in Central Time */
export function nowCentralDisplay(): string {
  return new Date().toLocaleString("en-US", { timeZone: CT_TZ });
}

/** Alias for compatibility — returns a Date-like object but use centralParts() for reliable hours */
export function nowCentral(): Date {
  // Return a Date whose getHours()/getDay() match Central Time
  const p = centralParts();
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** Get today's date string (YYYY-MM-DD) in Central Time */
export function todayCentral(): string {
  const p = centralParts();
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Check if current time is within business hours */
export function isBusinessHours(
  config: Pick<AidaConfig, "businessHours"> = DEFAULT_CONFIG
): boolean {
  const p = centralParts();
  if (!config.businessHours.days.includes(p.dow)) return false;
  if (p.hour < config.businessHours.start) return false;
  if (p.hour >= config.businessHours.end) return false;
  return true;
}
