import { NextResponse } from 'next/server';

const MOXY_BASE    = 'https://MoxyAPI.moxyws.com';
const MOXY_BEARER  = 'a242ccb0-738e-4e4f-a418-facf89297904';
const CAMPAIGN_START = '2026-02-25';

function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : '';
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface MoxySale {
  contractNo: string; phone: string; cellPhone: string; homePhone: string;
  firstName: string; lastName: string; salesRep: string; soldDate: string;
  status: string; promoCode: string; cancelReason: string;
  make: string; model: string; state: string; admin: string;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const debug = searchParams.get('debug') === '1';

    const fromDate = CAMPAIGN_START;
    const toDate   = todayISO();
    const url = `${MOXY_BASE}/api/GetDealLog?fromDate=${fromDate}&toDate=${toDate}&dealType=Both`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${MOXY_BEARER}` },
      cache: 'no-store',
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return NextResponse.json({ ok: false, error: `Moxy REST ${resp.status}: ${errText}`, sales: [] }, { status: 502 });
    }

    const deals: Record<string, any>[] = await resp.json();

    if (debug) {
      // Return raw field names and a sample record
      const sampleWithData = deals.find((d: Record<string, any>) => {
        return Object.values(d).some((v: any) => v !== null && v !== '' && v !== 0);
      });
      return NextResponse.json({
        totalRecords: deals.length,
        sampleKeys: deals[0] ? Object.keys(deals[0]) : [],
        sampleRecord: sampleWithData || deals[0],
        first3: deals.slice(0, 3),
      });
    }

    // Map REST API fields to MoxySale
    const sales: MoxySale[] = deals.map((d: Record<string, any>) => {
      const hp = normalizePhone(d.HomePhone ?? d.homePhone ?? d.homephone);
      const cp = normalizePhone(d.Cellphone ?? d.cellPhone ?? d.cellphone ?? d.CellPhone);
      const bestPhone = hp || cp;

      return {
        contractNo:   d.ContractNo   ?? d.contractNo   ?? '',
        phone:        bestPhone,
        cellPhone:    cp,
        homePhone:    hp,
        firstName:    d.FirstName    ?? d.firstName     ?? d.First     ?? '',
        lastName:     d.LastName     ?? d.lastName      ?? d.Last      ?? '',
        salesRep:     d.Closer       ?? d.SalesRep      ?? d.salesRep  ?? '',
        soldDate:     d.SoldDate     ?? d.soldDate      ?? '',
        status:       d.DealStatus   ?? d.dealStatus    ?? d.Status    ?? '',
        promoCode:    d.PromoCode    ?? d.promoCode     ?? '',
        cancelReason: d.CancelReason ?? d.cancelReason  ?? '',
        make:         d.Make         ?? d.make          ?? '',
        model:        d.Model        ?? d.model         ?? '',
        state:        d.State        ?? d.state         ?? '',
        admin:        d.Admin        ?? d.admin         ?? '',
      };
    });

    return NextResponse.json({
      ok: true,
      count: sales.length,
      sales,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err: any) {
    console.error('[moxy/route.ts]', err);
    return NextResponse.json({ ok: false, error: err.message, sales: [] }, { status: 500 });
  }
}
