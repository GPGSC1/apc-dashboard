// CS Overview v2 — the 4-row layout per Jeremy's spec
//
//   Row 1 "Records"     — workable counts (excluding future follow-ups)
//   Row 2 "Calls"       — outbound dial volume + inbound answered/abandoned
//   Row 3 "Percentages" — list completion % and available-to-collect %
//   Row 4 "Amounts"     — dollar totals collected
//
// Sources:
//   cs_account_daily   — morning PBS snapshot (workable universe)
//   cs_dispo_history   — follow-up dates (col Q) and final dispositions
//   cs_raw_calls       — every inbound + outbound 3CX call
//
// Query params:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   (default: today..today)

import { NextResponse } from "next/server";
import { query } from "../../../../lib/db/connection";
import { parseFollowupDate } from "../../../../lib/cs/parse-followup";

const CT_TZ = "America/Chicago";

function todayCT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function norm10(p: string | null | undefined): string {
  if (!p) return "";
  const d = String(p).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const s = new Date(Date.UTC(sy, sm - 1, sd));
  const e = new Date(Date.UTC(ey, em - 1, ed));
  for (let t = s.getTime(); t <= e.getTime(); t += 86400000) {
    const d = new Date(t);
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    );
  }
  return out;
}

interface DayMetrics {
  records: { total: number; zero: number; non_zero: number; followups: number; followups_zero: number; followups_non_zero: number };
  calls: { zero_pay_calls: number; non_zero_calls: number; inbound_answered: number; abandoned: number; unanswered_phones: number };
  percentages: { list_complete: number; zero_pay_pct: number; non_zero_pct: number; available_to_collect: number; unanswered_pct: number };
  amounts: { total_collected: number; zero_pay_collected: number; non_zero_collected: number; amt_due_workable: number; scheduled_amt: number };
  _sums: {
    amt_due_workable: number;
    unique_phones_touched_any: number;
    unique_phones_touched_zero: number;
    unique_phones_touched_non_zero: number;
  };
}

async function computeDay(date: string): Promise<DayMetrics> {
  // ── 1. Pull today's accounts + dispos ─────────────────────────────────────
  // Only count accounts that are on the working sheet (have a rep assigned).
  // Lenovo captures ALL PBS accounts; not-yet-due ones have assigned_rep=NULL.
  // Fall back to cs_account_daily if cs_past_due_accounts has no assigned reps yet.
  // Read dispos from cs_past_due_accounts (populated by sheets-sync from Google Sheet).
  // cs_dispo_history is unused in Phase 1 — dispos flow: Google Sheet → sheets-sync → cs_past_due_accounts.
  const acctRes = await query(
    `SELECT pa.account_number,
            pa.installments_made,
            pa.amount_due,
            pa.main_phone, pa.home_phone, pa.work_phone,
            pa.dispo_1, pa.dispo_2, pa.dispo_date AS followup_raw
     FROM cs_past_due_accounts pa
     WHERE pa.scrub_date = $1
       AND pa.assigned_rep IS NOT NULL AND pa.assigned_rep != ''`,
    [date]
  );

  // Classify workable vs follow-up
  interface AcctRow {
    account_number: string;
    is_zero: boolean;
    amount_due: number;
    phones: string[];
    dispo_1: string;
    dispo_2: string;
    is_followup: boolean;
    is_collected: boolean;
  }
  const accts: AcctRow[] = [];
  for (const r of acctRes.rows) {
    const installments = Number(r.installments_made) || 0;
    const followupParsed = parseFollowupDate(r.followup_raw);
    const isFollowup = !!(followupParsed && followupParsed > date);
    const d1 = (r.dispo_1 || "").toString().trim();
    const d2 = (r.dispo_2 || "").toString().trim();
    const isCollected = /^collected$/i.test(d1) || /^collected$/i.test(d2);
    const phones = [norm10(r.main_phone), norm10(r.home_phone), norm10(r.work_phone)].filter((p) => p);
    accts.push({
      account_number: r.account_number,
      is_zero: installments <= 0,
      amount_due: parseFloat(r.amount_due) || 0,
      phones,
      dispo_1: d1,
      dispo_2: d2,
      is_followup: isFollowup,
      is_collected: isCollected,
    });
  }

  const workable = accts.filter((a) => !a.is_followup);
  const followups = accts.filter((a) => a.is_followup);

  // ── 2. Pull today's calls ─────────────────────────────────────────────────
  // Phase 1 data sources:
  //   - Outbound calls: cs_outbound_calls (populated by seed-refresh every 15 min)
  //   - Inbound calls: queue_calls (populated by seed-refresh every 15 min)
  //   - cs_raw_calls is empty until Lenovo's realtime poller is online
  // When cs_raw_calls has data, we use it as primary (has direction, queue, status).
  // Until then, fall back to the tables that seed-refresh populates.

  const rawCallsRes = await query(
    `SELECT COUNT(*) AS cnt FROM cs_raw_calls WHERE call_date = $1`,
    [date]
  );
  const hasRawCalls = parseInt(rawCallsRes.rows[0]?.cnt || "0", 10) > 0;

  // Build phone → account(s) lookup, only for workable
  const phoneToZero = new Map<string, boolean>(); // phone -> is_zero (if phone belongs to workable)
  for (const a of workable) {
    for (const p of a.phones) {
      const existing = phoneToZero.get(p);
      if (existing === undefined) phoneToZero.set(p, a.is_zero);
      else if (a.is_zero) phoneToZero.set(p, true);
    }
  }

  // Count outbound calls (total, not unique) against workable phones
  let zeroPayCalls = 0;
  let nonZeroCalls = 0;
  const outboundPhonesHit = new Set<string>(); // for % List Complete
  const outboundPhonesHitZero = new Set<string>();
  const outboundPhonesHitNon = new Set<string>();

  // Inbound answered / abandoned counts
  let inboundAnswered = 0;
  let abandoned = 0;
  const inboundPhonesHit = new Set<string>();
  const inboundPhonesHitZero = new Set<string>();
  const inboundPhonesHitNon = new Set<string>();
  const unansweredPhones = new Set<string>();
  const answeredPhones = new Set<string>();

  if (hasRawCalls) {
    // ── Primary path: cs_raw_calls has data (Lenovo poller online) ──────
    const callsRes = await query(
      `SELECT phone, direction, queue_name, status, started_at
       FROM cs_raw_calls WHERE call_date = $1`,
      [date]
    );
    for (const c of callsRes.rows) {
      const phone = (c.phone || "").trim();
      const dir = (c.direction || "").trim();
      const queue = (c.queue_name || "").trim();
      const status = (c.status || "").trim().toLowerCase();
      const startedAt: Date | null = c.started_at ? new Date(c.started_at) : null;

      let inBH = false;
      if (startedAt) {
        const hourStr = new Intl.DateTimeFormat("en-US", {
          timeZone: CT_TZ, hour: "numeric", hour12: false,
        }).format(startedAt);
        const hour = parseInt(hourStr, 10);
        inBH = hour >= 8 && hour < 19;
      }

      if (dir === "Outbound") {
        if (phone && phoneToZero.has(phone)) {
          const isZero = phoneToZero.get(phone)!;
          if (isZero) { zeroPayCalls += 1; outboundPhonesHitZero.add(phone); }
          else { nonZeroCalls += 1; outboundPhonesHitNon.add(phone); }
          outboundPhonesHit.add(phone);
        }
      } else if (dir === "Inbound") {
        const isCollections = /collections/i.test(queue);
        if (!isCollections || !inBH) continue;
        if (status === "answered") { inboundAnswered += 1; if (phone) answeredPhones.add(phone); }
        else if (status === "unanswered") { abandoned += 1; if (phone) unansweredPhones.add(phone); }
        if (phone && phoneToZero.has(phone)) {
          const isZero = phoneToZero.get(phone)!;
          if (isZero) inboundPhonesHitZero.add(phone); else inboundPhonesHitNon.add(phone);
          inboundPhonesHit.add(phone);
        }
      }
    }
  } else {
    // ── Fallback path: use cs_outbound_calls + queue_calls from seed-refresh ──
    // Outbound calls from cs_outbound_calls (phone, call_time, agent_name)
    const outRes = await query(
      `SELECT phone, call_time FROM cs_outbound_calls
       WHERE call_time::date = $1::date`,
      [date]
    );
    for (const c of outRes.rows) {
      const phone = (c.phone || "").trim();
      if (phone && phoneToZero.has(phone)) {
        const isZero = phoneToZero.get(phone)!;
        if (isZero) { zeroPayCalls += 1; outboundPhonesHitZero.add(phone); }
        else { nonZeroCalls += 1; outboundPhonesHitNon.add(phone); }
        outboundPhonesHit.add(phone);
      }
    }

    // Inbound collections calls: queue_calls only tracks sales queues (mail/home),
    // NOT collections. Inbound data will come from cs_raw_calls once Lenovo's
    // poller is online. Until then, inbound metrics stay at 0.
    // No-op for now — inboundAnswered, abandoned stay 0.
  }

  // ── 3. Aggregates ────────────────────────────────────────────────────────
  const totalWorkable = workable.length;
  const zeroWorkable = workable.filter((a) => a.is_zero).length;
  const nonZeroWorkable = totalWorkable - zeroWorkable;
  const followupCount = followups.length;
  const followupZero = followups.filter((a) => a.is_zero).length;
  const followupNon = followupCount - followupZero;

  const amtDueWorkable = workable.reduce((s, a) => s + a.amount_due, 0);
  const totalCollected = workable.filter((a) => a.is_collected).reduce((s, a) => s + a.amount_due, 0);
  const zeroCollected = workable.filter((a) => a.is_collected && a.is_zero).reduce((s, a) => s + a.amount_due, 0);
  const nonZeroCollected = totalCollected - zeroCollected;
  const scheduledAmt = accts.filter((a) => /^scheduled\s+pdp$/i.test(a.dispo_1)).reduce((s, a) => s + a.amount_due, 0);

  // Unique phones across inbound + outbound (per spec: "unique outbound and inbound phones")
  const uniqueAny = new Set<string>([...outboundPhonesHit, ...inboundPhonesHit]);
  const uniqueZero = new Set<string>([...outboundPhonesHitZero, ...inboundPhonesHitZero]);
  const uniqueNon = new Set<string>([...outboundPhonesHitNon, ...inboundPhonesHitNon]);

  const listComplete = totalWorkable > 0 ? (uniqueAny.size / totalWorkable) * 100 : 0;
  const zeroPct = zeroWorkable > 0 ? (uniqueZero.size / zeroWorkable) * 100 : 0;
  const nonZeroPct = nonZeroWorkable > 0 ? (uniqueNon.size / nonZeroWorkable) * 100 : 0;
  const availableToCollect = amtDueWorkable > 0 ? (totalCollected / amtDueWorkable) * 100 : 0;

  // Unanswered = phones that got unanswered calls but were NEVER answered (phone-level dedup)
  const trulyUnansweredPhones = new Set([...unansweredPhones].filter(p => !answeredPhones.has(p)));
  const allInboundPhones = new Set([...answeredPhones, ...unansweredPhones]);
  const unansweredPct = allInboundPhones.size > 0 ? (trulyUnansweredPhones.size / allInboundPhones.size) * 100 : 0;

  return {
    records: {
      total: totalWorkable,
      zero: zeroWorkable,
      non_zero: nonZeroWorkable,
      followups: followupCount,
      followups_zero: followupZero,
      followups_non_zero: followupNon,
    },
    calls: {
      zero_pay_calls: zeroPayCalls,
      non_zero_calls: nonZeroCalls,
      inbound_answered: inboundAnswered,
      abandoned,
      unanswered_phones: trulyUnansweredPhones.size,
    },
    percentages: {
      list_complete: listComplete,
      zero_pay_pct: zeroPct,
      non_zero_pct: nonZeroPct,
      available_to_collect: availableToCollect,
      unanswered_pct: unansweredPct,
    },
    amounts: {
      total_collected: totalCollected,
      zero_pay_collected: zeroCollected,
      non_zero_collected: nonZeroCollected,
      amt_due_workable: amtDueWorkable,
      scheduled_amt: scheduledAmt,
    },
    _sums: {
      amt_due_workable: amtDueWorkable,
      unique_phones_touched_any: uniqueAny.size,
      unique_phones_touched_zero: uniqueZero.size,
      unique_phones_touched_non_zero: uniqueNon.size,
    },
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const today = todayCT();
    const start = url.searchParams.get("start") || today;
    const end = url.searchParams.get("end") || today;

    const dates = eachDate(start, end);
    // For now, compute each date and sum. With indexes this is fine for ranges
    // up to a few months; we can add a pre-aggregated rollup later if needed.
    const daily = await Promise.all(dates.map((d) => computeDay(d)));

    // ── Roll up across days ────────────────────────────────────────────────
    const agg: DayMetrics = {
      records: { total: 0, zero: 0, non_zero: 0, followups: 0, followups_zero: 0, followups_non_zero: 0 },
      calls: { zero_pay_calls: 0, non_zero_calls: 0, inbound_answered: 0, abandoned: 0, unanswered_phones: 0 },
      percentages: { list_complete: 0, zero_pay_pct: 0, non_zero_pct: 0, available_to_collect: 0, unanswered_pct: 0 },
      amounts: { total_collected: 0, zero_pay_collected: 0, non_zero_collected: 0, amt_due_workable: 0, scheduled_amt: 0 },
      _sums: { amt_due_workable: 0, unique_phones_touched_any: 0, unique_phones_touched_zero: 0, unique_phones_touched_non_zero: 0 },
    };

    for (const d of daily) {
      // For ranges, "Records" counts show the MOST RECENT day's universe (not summed).
      // For single-day queries this is identical. For multi-day ranges, summing
      // daily snapshots would double-count accounts that carry over day-to-day.
      agg.records = d.records;

      agg.calls.zero_pay_calls += d.calls.zero_pay_calls;
      agg.calls.non_zero_calls += d.calls.non_zero_calls;
      agg.calls.inbound_answered += d.calls.inbound_answered;
      agg.calls.abandoned += d.calls.abandoned;
      agg.calls.unanswered_phones += d.calls.unanswered_phones;

      agg.amounts.total_collected += d.amounts.total_collected;
      agg.amounts.zero_pay_collected += d.amounts.zero_pay_collected;
      agg.amounts.non_zero_collected += d.amounts.non_zero_collected;
      agg.amounts.amt_due_workable += d.amounts.amt_due_workable;
      agg.amounts.scheduled_amt += d.amounts.scheduled_amt;

      agg._sums.amt_due_workable += d._sums.amt_due_workable;
      agg._sums.unique_phones_touched_any += d._sums.unique_phones_touched_any;
      agg._sums.unique_phones_touched_zero += d._sums.unique_phones_touched_zero;
      agg._sums.unique_phones_touched_non_zero += d._sums.unique_phones_touched_non_zero;
    }

    // Recompute percentages across the rolled-up range
    // Denominator = sum of workable counts over each day (records/day summed)
    let sumTotal = 0, sumZero = 0, sumNon = 0;
    for (const d of daily) {
      sumTotal += d.records.total;
      sumZero += d.records.zero;
      sumNon += d.records.non_zero;
    }
    agg.percentages.list_complete = sumTotal > 0 ? (agg._sums.unique_phones_touched_any / sumTotal) * 100 : 0;
    agg.percentages.zero_pay_pct = sumZero > 0 ? (agg._sums.unique_phones_touched_zero / sumZero) * 100 : 0;
    agg.percentages.non_zero_pct = sumNon > 0 ? (agg._sums.unique_phones_touched_non_zero / sumNon) * 100 : 0;
    agg.percentages.available_to_collect =
      agg._sums.amt_due_workable > 0 ? (agg.amounts.total_collected / agg._sums.amt_due_workable) * 100 : 0;
    // Unanswered pct across rolled-up range: sum of daily unanswered phones / sum of daily inbound calls
    const totalInbound = agg.calls.inbound_answered + agg.calls.abandoned;
    agg.percentages.unanswered_pct = totalInbound > 0 ? (agg.calls.unanswered_phones / totalInbound) * 100 : 0;

    return NextResponse.json({ ok: true, start, end, days: dates.length, metrics: agg });
  } catch (e) {
    console.error("[cs/overview-v2] Error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
