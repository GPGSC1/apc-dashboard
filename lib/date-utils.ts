/**
 * Robust date parsing utility for APC Dashboard.
 *
 * Handles three formats without UTC timezone shift:
 *   - "M/D/YYYY" or "MM/DD/YYYY" (with optional time after a space)
 *   - "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS..."
 *   - Excel serial numbers (integer days since 1899-12-30)
 *
 * Always returns "YYYY-MM-DD" or null.
 */

export function parseDate(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;

  // Excel serial number (integer or float)
  if (typeof raw === "number") {
    if (raw < 1 || raw > 200000) return null;
    const epoch = new Date(1899, 11, 30); // Dec 30, 1899
    epoch.setDate(epoch.getDate() + Math.floor(raw));
    const y = epoch.getFullYear();
    const m = String(epoch.getMonth() + 1).padStart(2, "0");
    const d = String(epoch.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const s = String(raw).replace(/"/g, "").trim();
  if (!s) return null;

  // Strip time component: take only the date portion before any space
  const datePart = s.split(" ")[0];

  // ISO format: "YYYY-MM-DD" or "YYYY-MM-DDTHH..."
  if (/^\d{4}-\d{2}-\d{2}/.test(datePart)) {
    return datePart.slice(0, 10);
  }

  // US format: "M/D/YYYY" or "MM/DD/YYYY"
  const slashMatch = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, "0");
    const day = slashMatch[2].padStart(2, "0");
    const year = slashMatch[3];
    // Basic validation
    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${year}-${month}-${day}`;
  }

  // ISO with T but no preceding date match (e.g., passed full ISO string)
  const isoTMatch = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoTMatch) return isoTMatch[1];

  return null;
}

/**
 * Returns today's date as YYYY-MM-DD in Central Time.
 * Uses America/Chicago which auto-handles CDT/CST.
 */
export function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Returns tomorrow's date as YYYY-MM-DD in Central Time.
 * Used for Moxy API's exclusive toDate parameter.
 */
export function tomorrowLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
