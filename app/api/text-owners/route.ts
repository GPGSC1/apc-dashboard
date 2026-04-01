import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const maxDuration = 30;

// Split message into SMS-safe chunks (≤150 chars to leave room for carrier overhead)
function splitMessage(msg: string, maxLen = 150): string[] {
  const lines = msg.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    // If adding this line would exceed limit, push current chunk
    if (current && (current + "\n" + line).length > maxLen) {
      chunks.push(current.trim());
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

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

    // AT&T SMS gateway
    const gateway = `${phone}@txt.att.net`;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailPass,
      },
    });

    // Split into SMS-safe chunks and send each
    const chunks = splitMessage(message);
    for (let i = 0; i < chunks.length; i++) {
      await transporter.sendMail({
        from: gmailUser,
        to: gateway,
        subject: "",
        text: chunks[i],
      });
      // Small delay between messages to preserve order
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return NextResponse.json({ success: true, gateway, parts: chunks.length });
  } catch (err) {
    console.error("[text-owners] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
