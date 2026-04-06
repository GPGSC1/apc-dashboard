// CS Collections — Twilio SMS helper

export async function sendSMS(to: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    console.warn("[cs/twilio] Twilio credentials not configured");
    return { ok: false, error: "Twilio credentials not configured" };
  }

  // Normalize phone to E.164
  const digits = to.replace(/\D/g, "");
  const e164 = digits.length === 10 ? `+1${digits}` : digits.startsWith("1") ? `+${digits}` : `+${digits}`;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({ To: e164, From: from, Body: message });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error("[cs/twilio] SMS failed:", err);
      return { ok: false, error: err.message || "Twilio error" };
    }

    return { ok: true };
  } catch (e) {
    console.error("[cs/twilio] SMS error:", e);
    return { ok: false, error: String(e) };
  }
}
