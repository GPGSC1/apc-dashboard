import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const type = url.searchParams.get("type") ?? "auto"; // auto or home
  const search = url.searchParams.get("search") ?? ""; // search by phone or last name

  const key = type === "home"
    ? (process.env.MOXY_HOME_KEY ?? "3f7c2b0a-9e4d-4f6e-b1a8-8c9a6e2d7b54")
    : (process.env.MOXY_API_KEY ?? "a242ccb0-738e-4e4f-a418-facf89297904");

  const apiUrl = `https://MoxyAPI.moxyws.com/api/GetDealLog?fromDate=${date}&toDate=${date}&dealType=Both`;

  const resp = await fetch(apiUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });

  if (!resp.ok) {
    return NextResponse.json({ error: `Moxy API ${resp.status}`, body: await resp.text() }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deals: any[] = await resp.json();

  // If search param, filter results
  let filtered = deals;
  if (search) {
    const s = search.toLowerCase().replace(/\D/g, "");
    const sText = search.toLowerCase();
    filtered = deals.filter((d) => {
      const hp = String(d.HomePhone ?? d.homePhone ?? "").replace(/\D/g, "");
      const cp = String(d.CellPhone ?? d.cellPhone ?? d.Cellphone ?? "").replace(/\D/g, "");
      const ln = String(d.LastName ?? d.lastName ?? "").toLowerCase();
      const fn = String(d.FirstName ?? d.firstName ?? "").toLowerCase();
      const cid = String(d.CustomerID ?? d.customerId ?? d.vchCampaignId ?? "").toLowerCase();
      return hp.includes(s) || cp.includes(s) || ln.includes(sText) || fn.includes(sText) || cid.includes(sText);
    });
  }

  return NextResponse.json({
    apiUrl,
    type,
    date,
    totalReturned: deals.length,
    filtered: filtered.length,
    search: search || "(none)",
    deals: filtered,
  });
}
