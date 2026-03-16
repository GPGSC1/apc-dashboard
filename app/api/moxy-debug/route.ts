import { NextResponse } from 'next/server';

const CAMPAIGN_START = '2026-02-25';

export async function GET() {
  const bearer = process.env.MOXY_BEARER_AUTO;
  if (!bearer) return NextResponse.json({ error: 'No bearer token' });

  const today = new Date().toISOString().slice(0, 10);
  const url = `https://MoxyAPI.moxyws.com/api/GetDealLog?fromDate=${CAMPAIGN_START}&toDate=${today}&dealType=Both`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
  });

  const json = await res.json();
  const records = Array.isArray(json) ? json : (json.data ?? json.deals ?? json.records ?? json);

  // Return first 2 records raw so we can see exact field names
  return NextResponse.json({ sample: Array.isArray(records) ? records.slice(0, 2) : records });
}
