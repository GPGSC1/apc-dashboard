import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const domain = process.env.TCX_DOMAIN ?? "gpgsc.innicom.com";
  const username = process.env.TCX_USERNAME ?? "1911";
  const password = process.env.TCX_PASSWORD ?? "";
  const wbApp = "/app0422";

  const steps: Record<string, unknown>[] = [];

  try {
    // Step 1: GET login page
    const loginPageUrl = `https://${domain}${wbApp}/Wallboard.aspx`;
    steps.push({ step: 1, action: "GET login page", url: loginPageUrl });

    const r1 = await fetch(loginPageUrl, { redirect: "manual" });
    const r1Body = await r1.text();
    const r1Cookies = r1.headers.get("set-cookie") || "";
    steps.push({
      step: 1, status: r1.status, location: r1.headers.get("location"),
      bodyLen: r1Body.length, hasLoginForm: r1Body.includes("txtUsername"),
      cookies: r1Cookies.slice(0, 200),
    });

    // Follow redirect
    const loginUrl = r1.headers.get("location")?.startsWith("http")
      ? r1.headers.get("location")!
      : `https://${domain}${r1.headers.get("location")}`;

    const cookieJar: string[] = r1Cookies.split(/,\s*(?=[A-Za-z_.]+=)/).filter(Boolean).map(c => c.split(";")[0]);

    const r2 = await fetch(loginUrl, { headers: { Cookie: cookieJar.join("; ") } });
    const r2Body = await r2.text();
    const r2Cookies = r2.headers.get("set-cookie") || "";
    r2Cookies.split(/,\s*(?=[A-Za-z_.]+=)/).filter(Boolean).forEach(c => cookieJar.push(c.split(";")[0]));

    // Extract form fields
    const extractField = (html: string, field: string) => {
      const m = html.match(new RegExp(`id="${field}"[^>]*value="([^"]*)"`, "i")) ??
                html.match(new RegExp(`name="${field}"[^>]*value="([^"]*)"`, "i"));
      return m ? m[1] : "";
    };

    const viewState = extractField(r2Body, "__VIEWSTATE");
    const viewStateGen = extractField(r2Body, "__VIEWSTATEGENERATOR");
    const eventVal = extractField(r2Body, "__EVENTVALIDATION");

    steps.push({
      step: 2, status: r2.status, loginUrl,
      hasViewState: !!viewState, hasEventVal: !!eventVal,
      bodyHasForm: r2Body.includes("txtUsername"),
    });

    // Step 3: POST login
    const formData = new URLSearchParams({
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventVal,
      txtUsername: username,
      txtPassword: password,
      x: "28", y: "8",
    });

    const r3 = await fetch(loginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieJar.join("; "),
      },
      body: formData.toString(),
      redirect: "manual",
    });
    const r3Body = await r3.text();
    const r3Cookies = r3.headers.get("set-cookie") || "";
    r3Cookies.split(/,\s*(?=[A-Za-z_.]+=)/).filter(Boolean).forEach(c => cookieJar.push(c.split(";")[0]));

    const hasAuth = cookieJar.some(c => c.includes(".ASPXAUTH"));

    steps.push({
      step: 3, status: r3.status, location: r3.headers.get("location"),
      hasAuth, cookieCount: cookieJar.length,
      cookieNames: cookieJar.map(c => c.split("=")[0]),
      r3BodySnippet: r3Body.slice(0, 200),
    });

    if (!hasAuth) {
      return NextResponse.json({ ok: false, error: "No auth cookie after login", steps, passwordSet: !!password, passwordLen: password.length });
    }

    // Follow redirect
    if (r3.headers.get("location")) {
      const wbUrl = r3.headers.get("location")!.startsWith("http")
        ? r3.headers.get("location")!
        : `https://${domain}${r3.headers.get("location")}`;
      await fetch(wbUrl, { headers: { Cookie: cookieJar.join("; ") } });
    }

    // Step 4: Poll centerwide
    const ts = Date.now();
    const dataUrl = `https://${domain}${wbApp}/WallboardService.svc/GetWallboardData?ts=${ts}&Filter=&SortField=&SortAorD=`;
    const r4 = await fetch(dataUrl, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Cookie: cookieJar.join("; "),
      },
    });
    const r4Body = await r4.text();

    steps.push({
      step: 4, action: "poll centerwide", status: r4.status,
      isJson: r4Body.startsWith("{"),
      bodySnippet: r4Body.slice(0, 500),
    });

    let parsed: any = null;
    try { parsed = JSON.parse(r4Body); } catch {}

    return NextResponse.json({
      ok: true,
      totalWaiting: parsed?.d?.Waiting ?? "N/A",
      callsWaiting: parsed?.d?.CallsWaiting ?? [],
      agentCount: parsed?.d?.AgentData?.length ?? 0,
      agentSample: (parsed?.d?.AgentData ?? []).slice(0, 3),
      steps,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err), steps }, { status: 500 });
  }
}
