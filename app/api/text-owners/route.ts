import { NextResponse } from "next/server";

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const { to, message } = await req.json();

    if (!to || !message) {
      return NextResponse.json({ error: "Missing 'to' or 'message'" }, { status: 400 });
    }

    // Normalize phone to digits only
    const digits = to.replace(/\D/g, "");
    const phone = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

    // Use TextBelt free API (1 text/day free, no signup needed)
    // Set TEXTBELT_KEY env var for paid tier, otherwise uses free "textbelt" key
    const key = process.env.TEXTBELT_KEY || "textbelt";

    const res = await fetch("https://textbelt.com/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, message, key }),
    });

    const result = await res.json();

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "TextBelt send failed", quotaRemaining: result.quotaRemaining },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      textId: result.textId,
      quotaRemaining: result.quotaRemaining,
    });
  } catch (err) {
    console.error("[text-owners] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
