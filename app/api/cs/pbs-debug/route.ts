// Debug endpoint — dumps PBS login page response so we can see form field
// names, status codes, cookies, etc. Remove before going live.

import { NextResponse } from "next/server";

export async function GET() {
  const base = process.env.PBS_BASE_URL || "https://www.pbsnetaccess.com";
  const path = process.env.PBS_LOGIN_PATH || "/EntityLogin.aspx?portfolio=1144";
  const url = `${base}${path}`;

  try {
    const res = await fetch(url, { redirect: "manual" });
    const html = await res.text();
    const setCookies = res.headers.getSetCookie?.() || [];

    // Find all form input field names + ids (first 40)
    const inputs: string[] = [];
    const re = /<input[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) && inputs.length < 40) inputs.push(m[0]);

    return NextResponse.json({
      ok: true,
      url,
      status: res.status,
      statusText: res.statusText,
      location: res.headers.get("location"),
      setCookies,
      htmlLength: html.length,
      htmlSnippet: html.slice(0, 600),
      inputs,
      hasViewState: /__VIEWSTATE/.test(html),
      hasEventValidation: /__EVENTVALIDATION/.test(html),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, url, error: String(e) }, { status: 500 });
  }
}
