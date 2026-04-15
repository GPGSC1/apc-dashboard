// CS Collections — TextMagic SMS campaign helpers
// Handles scrub rules, phone normalization, message templating, and API send.

export const SCRUB_DISPOS = [
  "Scheduled PDP",
  "Follow Up",
  "Collected",
  "Mailed Check",
  "Cancelled Policy",
  "CS-Save Attempt",
  "Do Not Call",
] as const;

// Default template (from Jeremy's TextMagic "Collections Message" template)
// Placeholders: {FirstName}, {AmountDue}, {MissedPaymentDate}
export const DEFAULT_MESSAGE_TEMPLATE =
  "From Guardian Protection Group, {FirstName} according to our records, your payment for {AmountDue} is past due as of {MissedPaymentDate} for your coverage. Please call 844-770-8448 to make arrangements to avoid cancellation. Reply STOP to unsubscribe.";

export interface PastDueRow {
  id: number;
  account_number: string;
  insured_name: string;
  main_phone: string | null;
  mobile_phone: string | null;
  amount_due: number | string;
  next_due_date: string | null;
  installments_made: number | null;
  dispo_1: string | null;
  dispo_2: string | null;
}

export interface TextRecipient {
  id: number;
  accountNumber: string;
  name: string;
  firstName: string;
  phone: string; // 10-digit normalized
  phoneE164: string; // +1XXXXXXXXXX
  amountDue: string; // formatted "$X.XX"
  nextDueDate: string; // formatted "M/D/YYYY"
  installmentsMade: number;
  message: string;
}

export interface ExclusionBreakdown {
  scheduledPDP: number;
  followUp: number;
  collected: number;
  mailedCheck: number;
  cancelledPolicy: number;
  csSaveAttempt: number;
  doNotCall: number;
  noPhone: number;
  total: number;
}

// ── Helpers ──

export function extractFirstName(fullName: string): string {
  if (!fullName) return "";
  const trimmed = fullName.trim();
  if (!trimmed) return "";
  // Split on whitespace, take first token
  return trimmed.split(/\s+/)[0];
}

export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return "";
}

export function toE164(tenDigit: string): string {
  if (!tenDigit || tenDigit.length !== 10) return "";
  return "+1" + tenDigit;
}

export function formatAmount(raw: number | string | null | undefined): string {
  if (raw === null || raw === undefined) return "$0.00";
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (isNaN(n)) return "$0.00";
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function formatDueDate(raw: string | null | undefined): string {
  if (!raw) return "";
  // raw is either "YYYY-MM-DD" or a Date object (already stringified by pg)
  const s = String(raw).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const year = m[1];
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  return `${month}/${day}/${year}`;
}

export function fillTemplate(
  template: string,
  recipient: Pick<TextRecipient, "firstName" | "amountDue" | "nextDueDate">
): string {
  return template
    .replace(/\{FirstName\}/g, recipient.firstName)
    .replace(/\{First name\}/g, recipient.firstName) // TextMagic template uses this
    .replace(/\{first name\}/gi, recipient.firstName)
    .replace(/\{AmountDue\}/g, recipient.amountDue)
    .replace(/\{Amount Due\}/g, recipient.amountDue)
    .replace(/\{amount due\}/gi, recipient.amountDue)
    .replace(/\{MissedPaymentDate\}/g, recipient.nextDueDate)
    .replace(/\{Missed Payment Date\}/g, recipient.nextDueDate)
    .replace(/\{missed payment date\}/gi, recipient.nextDueDate)
    .replace(/\{NextDueDate\}/g, recipient.nextDueDate);
}

// Check if a row's dispo matches any scrub rule (case-insensitive substring)
// Returns the matching dispo reason or null if no match
export function matchScrubDispo(dispo1: string | null, dispo2: string | null): string | null {
  const d1 = (dispo1 || "").toLowerCase().trim();
  const d2 = (dispo2 || "").toLowerCase().trim();
  for (const scrub of SCRUB_DISPOS) {
    const s = scrub.toLowerCase();
    if (d1.includes(s) || d2.includes(s)) return scrub;
  }
  return null;
}

export interface ScrubResult {
  recipients: TextRecipient[];
  exclusions: ExclusionBreakdown;
  scrubbedRows: Array<{ accountNumber: string; name: string; reason: string }>;
}

export function applyScrubRules(
  rows: PastDueRow[],
  template: string = DEFAULT_MESSAGE_TEMPLATE
): ScrubResult {
  const recipients: TextRecipient[] = [];
  const exclusions: ExclusionBreakdown = {
    scheduledPDP: 0,
    followUp: 0,
    collected: 0,
    mailedCheck: 0,
    cancelledPolicy: 0,
    csSaveAttempt: 0,
    doNotCall: 0,
    noPhone: 0,
    total: 0,
  };
  const scrubbedRows: Array<{ accountNumber: string; name: string; reason: string }> = [];

  for (const row of rows) {
    // First: check dispo scrub rules
    const scrubMatch = matchScrubDispo(row.dispo_1, row.dispo_2);
    if (scrubMatch) {
      switch (scrubMatch) {
        case "Scheduled PDP": exclusions.scheduledPDP++; break;
        case "Follow Up": exclusions.followUp++; break;
        case "Collected": exclusions.collected++; break;
        case "Mailed Check": exclusions.mailedCheck++; break;
        case "Cancelled Policy": exclusions.cancelledPolicy++; break;
        case "CS-Save Attempt": exclusions.csSaveAttempt++; break;
        case "Do Not Call": exclusions.doNotCall++; break;
      }
      exclusions.total++;
      scrubbedRows.push({
        accountNumber: row.account_number,
        name: row.insured_name,
        reason: scrubMatch,
      });
      continue;
    }

    // Second: require a valid phone (prefer main, fallback to mobile)
    const mainPhone = normalizePhone(row.main_phone);
    const mobilePhone = normalizePhone(row.mobile_phone);
    const phone = mainPhone || mobilePhone;
    if (!phone) {
      exclusions.noPhone++;
      exclusions.total++;
      scrubbedRows.push({
        accountNumber: row.account_number,
        name: row.insured_name,
        reason: "No Phone",
      });
      continue;
    }

    // Build recipient
    const firstName = extractFirstName(row.insured_name);
    const amountDue = formatAmount(row.amount_due);
    const nextDueDate = formatDueDate(row.next_due_date);
    const recipient: TextRecipient = {
      id: row.id,
      accountNumber: row.account_number,
      name: row.insured_name,
      firstName,
      phone,
      phoneE164: toE164(phone),
      amountDue,
      nextDueDate,
      installmentsMade: row.installments_made ?? 0,
      message: "",
    };
    recipient.message = fillTemplate(template, recipient);
    recipients.push(recipient);
  }

  return { recipients, exclusions, scrubbedRows };
}

// ── TextMagic API send ──

export interface SendResult {
  ok: boolean;
  recipientId: number;
  phone: string;
  messageId?: string;
  error?: string;
  cost?: number;
}

export async function sendOneText(
  recipient: TextRecipient
): Promise<SendResult> {
  const username = process.env.TEXTMAGIC_USERNAME;
  const apiKey = process.env.TEXTMAGIC_API_KEY;
  if (!username || !apiKey) {
    return {
      ok: false,
      recipientId: recipient.id,
      phone: recipient.phone,
      error: "TEXTMAGIC_USERNAME or TEXTMAGIC_API_KEY not configured",
    };
  }

  try {
    const body = new URLSearchParams({
      text: recipient.message,
      phones: recipient.phoneE164,
    });
    const res = await fetch("https://rest.textmagic.com/api/v2/messages", {
      method: "POST",
      headers: {
        "X-TM-Username": username,
        "X-TM-Key": apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        recipientId: recipient.id,
        phone: recipient.phone,
        error: (json && (json.message || json.error)) || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      recipientId: recipient.id,
      phone: recipient.phone,
      messageId: String(json.id || json.messageId || ""),
      cost: typeof json.price === "number" ? json.price : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      recipientId: recipient.id,
      phone: recipient.phone,
      error: String(e),
    };
  }
}
