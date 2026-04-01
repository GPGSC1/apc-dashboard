import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const { to, message } = await req.json();

    if (!to || !message) {
      return NextResponse.json({ error: "Missing 'to' or 'message'" }, { status: 400 });
    }

    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailPass) {
      return NextResponse.json(
        { error: "Email credentials not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in Vercel env vars." },
        { status: 500 }
      );
    }

    // Normalize phone to digits only
    const digits = to.replace(/\D/g, "");
    const phone = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;

    // AT&T MMS gateway (supports long messages)
    const gateway = `${phone}@mms.att.net`;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailPass,
      },
    });

    await transporter.sendMail({
      from: gmailUser,
      to: gateway,
      subject: "",
      text: message,
    });

    return NextResponse.json({ success: true, gateway });
  } catch (err) {
    console.error("[text-owners] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
