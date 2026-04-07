// Tolerant follow-up date parser — Jeremy's reps type dates freehand in the
// Google Sheet. A proper date picker is coming, but until then this accepts
// whatever shape the reps have used in the past.
//
// Returns "YYYY-MM-DD" (Central-Time-agnostic string) or null if no parse.
//
// Accepted shapes:
//   4/15          4/15/26        4/15/2026
//   4-15          4-15-26        4-15-2026
//   4.15          4.15.26        4.15.2026    04.08.   (trailing dot OK)
//   April 15      April 15 2026  Apr 15, 2026
//   2026-04-15    (ISO passthrough)
//
// Rules:
//   - If no year is present, assume "current CT year" at parse time
//   - Month/day order is US (M/D), never D/M
//   - 2-digit year: 00-79 → 2000s, 80-99 → 1900s (legacy safety)

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function currentCtYear(): number {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric",
  }).format(new Date());
  return parseInt(s, 10);
}

function expandYear(y: number): number {
  if (y >= 100) return y;
  return y < 80 ? 2000 + y : 1900 + y;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function valid(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function build(y: number, m: number, d: number): string | null {
  if (!valid(y, m, d)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parseFollowupDate(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\.+$/, "").trim();
  if (!s) return null;

  // ISO pass-through: YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return build(parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10));

  // Numeric M[sep]D[sep]Y? — separators: / - .
  const num = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (num) {
    const m = parseInt(num[1], 10);
    const d = parseInt(num[2], 10);
    const y = num[3] ? expandYear(parseInt(num[3], 10)) : currentCtYear();
    return build(y, m, d);
  }

  // Month-name variants: "April 15", "Apr 15, 2026", "15 April" (best effort)
  const words = s.toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    // Try "<month> <day> [<year>]"
    const m1 = MONTH_NAMES[words[0]];
    if (m1) {
      const d = parseInt(words[1], 10);
      if (!isNaN(d)) {
        const y = words[2] ? expandYear(parseInt(words[2], 10)) : currentCtYear();
        const out = build(y, m1, d);
        if (out) return out;
      }
    }
    // Try "<day> <month> [<year>]"
    const m2 = MONTH_NAMES[words[1]];
    if (m2) {
      const d = parseInt(words[0], 10);
      if (!isNaN(d)) {
        const y = words[2] ? expandYear(parseInt(words[2], 10)) : currentCtYear();
        const out = build(y, m2, d);
        if (out) return out;
      }
    }
  }

  return null;
}
