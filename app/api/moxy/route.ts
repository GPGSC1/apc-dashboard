import { NextResponse } from 'next/server';

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
}

// ─── Moxy REST API credentials ──────────────────────────────────────────────
const MOXY_BASE    = 'https://MoxyAPI.moxyws.com';
const MOXY_BEARER  = 'a242ccb0-738e-4e4f-a418-facf89297904';

// Campaign start — used as default fromDate
const CAMPAIGN_START = '2026-02-25';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : '';
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const fromDate = CAMPAIGN_START;
    const toDate   = todayISO();

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

    const deals: Record<string, any>[] = await resp.json();

    // Map REST API fields → MoxySale interface (same shape data/route.ts expects)
    const sales: MoxySale[] = deals.map((d) => {
      const hp = normalizePhone(d.HomePhone);
      const cp = normalizePhone(d.Cellphone);
      const bestPhone = hp || cp;

      return {
        contractNo:   d.ContractNo   ?? '',
        phone:        bestPhone,
        cellPhone:    cp,
        homePhone:    hp,
        firstName:    d.FirstName    ?? '',
        lastName:     d.LastName     ?? '',
        salesRep:     d.Closer       ?? '',
        soldDate:     d.SoldDate     ?? '',
        status:       d.DealStatus   ?? '',
        promoCode:    d.PromoCode    ?? '',
        cancelReason: d.CancelReason ?? '',
        make:         d.Make         ?? '',
        model:        d.Model        ?? '',
        state:        d.State        ?? '',
        admin:        d.Admin        ?? '',
      };
    });

    return NextResponse.json({
      ok:          true,
      count:       sales.length,
      sales,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err: any) {
    console.error('[moxy/route.ts]', err);
    return NextResponse.json({ ok: false, error: err.message, sales: [] }, { status: 500 });
  }
}
