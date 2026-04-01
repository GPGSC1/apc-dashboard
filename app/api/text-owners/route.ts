import { NextResponse } from "next/server";

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const { to, message } = await req.json();

    if (!to || !message) {
      return NextResponse.json({ error: "Missing 'to' or 'message'" }, { status: 400 });
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;

    if (!sid || !token || !from) {
      return NextResponse.json(
        { error: "Twilio credentials not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in Vercel env vars." },
        { status: 500 }
      );
    }

    // Normalize phone to E.164
    const digits = to.replace(/\D/g, "");
    const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : `+${digits}`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const body = new URLSearchParams({ To: e164, From: from, Body: message });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const result = await res.json();

    if (!res.ok) {
      return NextResponse.json({ error: result.message || "Twilio error", detail: result }, { status: res.status });
    }

    return NextResponse.json({ success: true, sid: result.sid, status: result.status });
  } catch (err) {
    console.error("[text-owners] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
