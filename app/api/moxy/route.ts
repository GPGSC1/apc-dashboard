import { NextResponse } from 'next/server';
import { tomorrowLocal, todayLocal, parseDate } from '../../../lib/date-utils';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────
export interface MoxySale {
  contractNo:   string;
  phone:        string;   // best available 10-digit normalised
  cellPhone:    string;
  homePhone:    string;
  firstName:    string;
  lastName:     string;
  salesRep:     string;
  soldDate:     string;   // raw string from Moxy (MM/DD/YYYY)
  status:       string;   // e.g. "Sold", "Cancelled"
  promoCode:    string;
  cancelReason: string;
  make:         string;
  model:        string;
  state:        string;
  admin:        string;
  campaign:     string;   // Moxy "campaign" field — used by queue rules for attribution
  source:       string;   // Moxy "source" field
  customerId:   string;   // Moxy customer ID — MET prefix indicates Meta internet lead
}

// ─── Moxy REST API credentials ───────────────────────────────────────────────
const MOXY_BASE   = 'https://MoxyAPI.moxyws.com';
const MOXY_BEARER = 'a242ccb0-738e-4e4f-a418-facf89297904';

const DATA_DIR = path.join(process.cwd(), 'data');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : '';
}

function mapDeal(d: Record<string, unknown>): MoxySale {
  const hp = normalizePhone(d.homePhone as string);
  const cp = normalizePhone((d.cellphone ?? d.cellPhone ?? d.mobilePhone) as string);
  return {
    contractNo:   String(d.contractNo   ?? ''),
    phone:        hp || cp,
    cellPhone:    cp,
    homePhone:    hp,
    firstName:    String(d.firstName    ?? ''),
    lastName:     String(d.lastName     ?? ''),
    salesRep:     String(d.closer ?? d.salesperson ?? d.salesRep ?? ''),
    soldDate:     String(d.soldDate     ?? ''),
    status:       String(d.dealStatus ?? d.status ?? ''),
    promoCode:    String(d.promoCode    ?? ''),
    cancelReason: String(d.cancelReason ?? ''),
    make:         String(d.make         ?? ''),
    model:        String(d.model        ?? ''),
    state:        String(d.state        ?? ''),
    admin:        String(d.admin        ?? ''),
    campaign:     String(d.campaign ?? d.campaignName ?? ''),
    source:       String(d.source       ?? ''),
    customerId:   String(d.customerId ?? d.customerID ?? d.customerNo ?? ''),
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const sales: MoxySale[] = [];
    const seenIds = new Set<string>();
    let seedCount = 0;
    let liveCount = 0;
    let liveError: string | null = null;
    let seedMaxDate = '';

    // Helper: dedup by customerId
    const addIfNew = (sale: MoxySale, source: 'seed' | 'live') => {
      const cid = sale.customerId.trim();
      if (cid && seenIds.has(cid)) return;
      if (cid) seenIds.add(cid);
      sales.push(sale);
      if (source === 'seed') seedCount++;
      else liveCount++;
    };

    // ── 1. Load seed (historical deals) ──────────────────────────────────────
    try {
      const seedPath = path.join(DATA_DIR, 'moxy_seed.json');
      if (fs.existsSync(seedPath)) {
        const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        for (const d of (seed.deals ?? [])) {
          const sale = mapDeal(d);
          // Track seed max date
          const isoDate = parseDate(sale.soldDate);
          if (isoDate && isoDate > seedMaxDate) seedMaxDate = isoDate;
          addIfNew(sale, 'seed');
        }
      }
    } catch (e) {
      console.error('[moxy/route.ts] seed read failed:', e);
    }

    // ── 2. Live API for dates after seed (always includes today) ─────────────
    // Treat seed as authoritative only through yesterday so today is always live
    const today = todayLocal();
    const seedCutoff = seedMaxDate >= today
      ? (() => { const d = new Date(seedMaxDate + 'T00:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })()
      : seedMaxDate;

    // Live API fetches from day after seed cutoff through tomorrow (exclusive upper bound)
    const liveFrom = seedCutoff
      ? (() => { const d = new Date(seedCutoff + 'T00:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })()
      : '2026-02-25';
    const liveTo = tomorrowLocal();

    if (liveFrom <= today) {
      try {
        const url = `${MOXY_BASE}/api/GetDealLog?fromDate=${liveFrom}&toDate=${liveTo}&dealType=Both`;
        const resp = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${MOXY_BEARER}` },
          cache: 'no-store',
        });

        if (!resp.ok) {
          const errText = await resp.text();
          liveError = `Moxy REST API returned ${resp.status}: ${errText}`;
          console.error(`[moxy/route.ts] ${liveError}`);
        } else {
          const deals: Record<string, unknown>[] = await resp.json();
          for (const d of deals) {
            addIfNew(mapDeal(d), 'live');
          }
        }
      } catch (err) {
        liveError = String(err);
        console.error('[moxy/route.ts] live API error:', err);
      }
    }

    return NextResponse.json({
      ok:          true,
      count:       sales.length,
      seedCount,
      liveCount,
      seedMaxDate,
      ...(liveError ? { liveError } : {}),
      sales,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[moxy/route.ts]', err);
    return NextResponse.json({ ok: false, error: msg, sales: [] }, { status: 500 });
  }
}
