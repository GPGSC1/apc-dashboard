import { NextResponse } from 'next/server';
import { tomorrowLocal } from '../../../lib/date-utils';

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

// Campaign start — used as default fromDate
const CAMPAIGN_START = '2026-02-25';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : '';
}

// tomorrowISO replaced by tomorrowLocal from lib/date-utils
// The Moxy REST API toDate parameter is EXCLUSIVE — to include today's deals
// the toDate must be set to tomorrow.

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const fromDate = CAMPAIGN_START;
    const toDate   = tomorrowLocal(); // exclusive upper bound — tomorrow captures today

    const url = `${MOXY_BASE}/api/GetDealLog?fromDate=${fromDate}&toDate=${toDate}&dealType=Both`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${MOXY_BEARER}`,
      },
      cache: 'no-store',
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[moxy/route.ts] REST API ${resp.status}: ${errText}`);
      return NextResponse.json(
        { ok: false, error: `Moxy REST API returned ${resp.status}: ${errText}`, sales: [] },
        { status: 502 }
      );
    }

    const deals: Record<string, unknown>[] = await resp.json();

    // Map REST API fields → MoxySale
    // IMPORTANT: The Moxy REST API returns camelCase keys, verified against live data:
    //   homePhone, cellphone (all lowercase!), dealStatus, contractNo,
    //   closer, soldDate, firstName, lastName, promoCode, cancelReason,
    //   make, model, state, admin
    const sales: MoxySale[] = deals.map((d) => {
      const hp = normalizePhone(d.homePhone as string);
      const cp = normalizePhone(d.cellphone as string);  // note: all lowercase "cellphone"
      const bestPhone = hp || cp;

      return {
        contractNo:   String(d.contractNo   ?? ''),
        phone:        bestPhone,
        cellPhone:    cp,
        homePhone:    hp,
        firstName:    String(d.firstName    ?? ''),
        lastName:     String(d.lastName     ?? ''),
        salesRep:     String(d.closer       ?? ''),  // "closer" not "salesRep" in REST API
        soldDate:     String(d.soldDate     ?? ''),
        status:       String(d.dealStatus   ?? ''),
        promoCode:    String(d.promoCode    ?? ''),
        cancelReason: String(d.cancelReason ?? ''),
        make:         String(d.make         ?? ''),
        model:        String(d.model        ?? ''),
        state:        String(d.state        ?? ''),
        admin:        String(d.admin        ?? ''),
        campaign:     String(d.campaign ?? d.campaignName ?? ''),
        source:       String(d.source   ?? ''),
        customerId:   String(d.customerId ?? d.customerID ?? d.customerNo ?? ''),
      };
    });

    return NextResponse.json({
      ok:          true,
      count:       sales.length,
      sales,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[moxy/route.ts]', err);
    return NextResponse.json({ ok: false, error: msg, sales: [] }, { status: 500 });
  }
}
