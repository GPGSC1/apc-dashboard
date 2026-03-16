import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const CAMPAIGN_START = '2026-02-25';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface MoxySale {
  customerID:  string;   // VchCampaignId — primary dedup key
  contractNo:  string;
  homePhone:   string;   // normalised 10-digit
  cellPhone:   string;   // normalised 10-digit
  phone:       string;   // best available (home → cell)
  firstName:   string;
  lastName:    string;
  salesRep:    string;
  soldDate:    string;   // YYYY-MM-DD when parseable, raw otherwise
  dealStatus:  string;
  promoCode:   string;
  make:        string;
  model:       string;
  state:       string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(raw: string | undefined | null): string {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : '';
}

function toISODate(raw: string | undefined | null): string {
  if (!raw) return '';
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return raw; // return raw if unparseable — data route will filter it out
}

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET() {
  const bearer = process.env.MOXY_BEARER_AUTO;
  if (!bearer) {
    return NextResponse.json(
      { ok: false, error: 'MOXY_BEARER_AUTO env var not set' },
      { status: 500 }
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const apiUrl =
      `https://MoxyAPI.moxyws.com/api/GetDealLog` +
      `?fromDate=${CAMPAIGN_START}&toDate=${today}&dealType=Both`;

    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept:        'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[moxy] API error', res.status, body);
      return NextResponse.json(
        { ok: false, error: `Moxy API returned ${res.status}`, detail: body },
        { status: 502 }
      );
    }

    const json = await res.json();

    // API may return a plain array or wrap it — handle both gracefully
    const records: Record<string, any>[] = Array.isArray(json)
      ? json
      : (json.data ?? json.deals ?? json.records ?? []);

    if (!Array.isArray(records)) {
      console.error('[moxy] Unexpected response shape:', JSON.stringify(json).slice(0, 200));
      return NextResponse.json(
        { ok: false, error: 'Unexpected Moxy API response shape' },
        { status: 502 }
      );
    }

    // Build sales map keyed by VchCampaignId (last-write wins for duplicates)
    const salesMap: Record<string, MoxySale> = {};

    for (const r of records) {
      const hp    = normalizePhone(r.HomePhone);
      const cp    = normalizePhone(r.Cellphone ?? r.CellPhone);
      const phone = hp || cp;

      const sale: MoxySale = {
        customerID: String(r.VchCampaignId ?? r.CustomerID ?? ''),
        contractNo: String(r.ContractNo   ?? r.contractNo  ?? ''),
        homePhone:  hp,
        cellPhone:  cp,
        phone,
        firstName:  String(r.FirstName  ?? r.First ?? ''),
        lastName:   String(r.LastName   ?? r.Last  ?? ''),
        salesRep:   String(r.SalesRep   ?? r.Salesperson ?? ''),
        soldDate:   toISODate(r.DateSold ?? r.SoldDate ?? r.soldDate ?? ''),
        dealStatus: String(r.DealStatus ?? r.Status ?? ''),
        promoCode:  String(r.PromoCode  ?? ''),
        make:       String(r.Make  ?? ''),
        model:      String(r.Model ?? ''),
        state:      String(r.State ?? ''),
      };

      // Use VchCampaignId as primary key; fall back to contractNo or phone
      const key = sale.customerID || sale.contractNo || sale.phone;
      if (key) salesMap[key] = sale;
    }

    // Persist to KV
    const redis = getRedis();
    if (redis) {
      await redis.set('moxy:sales',      salesMap);
      await redis.set('moxy:lastSeeded', new Date().toISOString());
    }

    const soldCount = Object.values(salesMap).filter(s => s.dealStatus === 'Sold').length;

    return NextResponse.json({
      ok:          true,
      total:       Object.keys(salesMap).length,
      soldCount,
      lastUpdated: new Date().toISOString(),
    });

  } catch (err: any) {
    console.error('[moxy/route.ts]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
