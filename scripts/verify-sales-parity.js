// Sales Dashboard parity verification — Phase 1 view refactor.
// Hits BASELINE_URL (current prod) and CANDIDATE_URL (PR preview / localhost),
// diffs every metric across known test ranges, exits non-zero on mismatch.
//
// Usage:
//   BASELINE_URL=https://gpg-dashboard-...vercel.app \
//   CANDIDATE_URL=http://localhost:3000 \
//   node scripts/verify-sales-parity.js
//
// Exit 0 = all ranges parity. Exit 1 = mismatch (full diff printed).

const BASELINE = process.env.BASELINE_URL;
const CANDIDATE = process.env.CANDIDATE_URL;

if (!BASELINE || !CANDIDATE) {
  console.error("set BASELINE_URL and CANDIDATE_URL env vars");
  process.exit(2);
}

// Test ranges. Sara's known-good Apr 1-5 numbers per CLAUDE.md.
const RANGES = [
  { label: "Apr 1-5 2026 (Sara baseline)", start: "2026-04-01", end: "2026-04-05" },
  { label: "MTD 2026-04",                 start: "2026-04-01", end: "2026-04-16" },
  { label: "Last 7 days",                  start: "2026-04-10", end: "2026-04-16" },
  { label: "Mar 2026",                     start: "2026-03-01", end: "2026-03-31" },
  { label: "Feb 2026",                     start: "2026-02-01", end: "2026-02-28" },
];
const SOLD_ONLY_VARIANTS = [false, true];

const EPSILON = 0.0001;

async function fetchData(base, start, end, soldOnly) {
  const url = `${base}/api/sales-data?start=${start}&end=${end}${soldOnly ? "&soldOnly=true" : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${base}`);
  const json = await res.json();
  if (json.error) throw new Error(`API error from ${base}: ${json.error}`);
  return json;
}

// Compare two values; record differences. Path is a string for reporting.
function diff(path, a, b, diffs) {
  if (a === b) return;
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) <= EPSILON) return;
    diffs.push({ path, a, b, kind: "number" });
    return;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    diffs.push({ path, a, b, kind: "null" });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push({ path: `${path}.length`, a: a.length, b: b.length, kind: "array-length" });
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) diff(`${path}[${i}]`, a[i], b[i], diffs);
    return;
  }
  if (typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff(`${path}.${k}`, a[k], b[k], diffs);
    return;
  }
  diffs.push({ path, a, b, kind: "scalar" });
}

// Normalize bySalesperson — keys are salesperson names; sort to make order-independent.
function normalize(json) {
  const out = { ...json };
  if (out.bySalesperson) {
    out.bySalesperson = Object.fromEntries(
      Object.entries(out.bySalesperson).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  // Drop _debug field if present (only on debug=true requests)
  delete out._debug;
  // Drop staleness — depends on seed-refresh timing, not deterministic
  delete out.staleness;
  // Drop teams — pure passthrough, not part of the math
  delete out.teams;
  // Drop toDeals (T.O. override candidates) — list ordering may vary, not a math metric
  delete out.toDeals;
  return out;
}

(async () => {
  let totalRanges = 0;
  let failedRanges = 0;
  const failures = [];

  for (const { label, start, end } of RANGES) {
    for (const soldOnly of SOLD_ONLY_VARIANTS) {
      totalRanges++;
      const tag = `${label} ${soldOnly ? "(soldOnly)" : "(all)"}`;
      try {
        const t0 = Date.now();
        const [baseline, candidate] = await Promise.all([
          fetchData(BASELINE, start, end, soldOnly),
          fetchData(CANDIDATE, start, end, soldOnly),
        ]);
        const elapsed = Date.now() - t0;
        const diffs = [];
        diff("", normalize(baseline), normalize(candidate), diffs);
        if (diffs.length === 0) {
          console.log(`  \x1b[32m✓\x1b[0m ${tag} (${elapsed}ms)`);
        } else {
          failedRanges++;
          failures.push({ tag, diffs });
          console.log(`  \x1b[31m✗\x1b[0m ${tag} (${elapsed}ms) — ${diffs.length} diff${diffs.length > 1 ? "s" : ""}`);
        }
      } catch (e) {
        failedRanges++;
        failures.push({ tag, error: String(e) });
        console.log(`  \x1b[31m!\x1b[0m ${tag} — ${e.message}`);
      }
    }
  }

  console.log(`\n${totalRanges - failedRanges}/${totalRanges} parity tests passed`);

  if (failures.length > 0) {
    console.log("\n\x1b[31mFAILURES:\x1b[0m\n");
    for (const f of failures) {
      console.log(`\x1b[33m${f.tag}\x1b[0m`);
      if (f.error) {
        console.log(`  ERROR: ${f.error}`);
      } else {
        for (const d of f.diffs.slice(0, 20)) {
          console.log(`  ${d.path}: baseline=${JSON.stringify(d.a)}  candidate=${JSON.stringify(d.b)}`);
        }
        if (f.diffs.length > 20) console.log(`  ...and ${f.diffs.length - 20} more`);
      }
      console.log();
    }
    process.exit(1);
  }

  process.exit(0);
})();
