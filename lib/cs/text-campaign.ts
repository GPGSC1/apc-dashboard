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

export interface BulkSendResult {
  ok: boolean;
  sessionId?: number;
  bulkId?: number;
  contactsSynced: number;
  contactsFailed: number;
  totalAttempted: number;
  error?: string;
  perRecipient: Array<{
    recipientId: number;
    phone: string;
    contactId?: number;
    status: "synced" | "failed";
    error?: string;
  }>;
}

const TM_BASE = "https://rest.textmagic.com/api/v2";
// TextMagic merge syntax in the template body:
// [First name]  — standard contact field
// [AmountDue]   — custom contact field (created below)
// [MissedPaymentDate] — custom contact field
const BULK_MERGE_TEXT =
  "From Guardian Protection Group, [First name] according to our records, " +
  "your payment for [AmountDue] is past due as of [MissedPaymentDate] for your coverage. " +
  "Please call 844-770-8448 to make arrangements to avoid cancellation. Reply STOP to unsubscribe.";

function tmHeaders(username: string, apiKey: string) {
  return {
    "X-TM-Username": username,
    "X-TM-Key": apiKey,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

// Ensure the two custom fields we reference exist. Returns their IDs.
async function ensureCustomFields(
  username: string,
  apiKey: string
): Promise<{ amountDueId: number; missedDateId: number }> {
  const headers = { "X-TM-Username": username, "X-TM-Key": apiKey };

  // TextMagic returns custom fields at /api/v2/customfields
  const listRes = await fetch(`${TM_BASE}/customfields?limit=100`, { headers });
  const listData = await listRes.json().catch(() => ({}));
  const existing = new Map<string, number>();
  const resources = Array.isArray(listData?.resources) ? listData.resources : [];
  for (const cf of resources) {
    if (cf?.name) existing.set(String(cf.name), Number(cf.id));
  }

  async function ensureOne(name: string): Promise<number> {
    if (existing.has(name)) return existing.get(name)!;
    const res = await fetch(`${TM_BASE}/customfields`, {
      method: "POST",
      headers: tmHeaders(username, apiKey),
      body: new URLSearchParams({ name }).toString(),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Failed to create custom field "${name}": ${d.message || res.status}`);
    }
    return Number(d.id);
  }

  return {
    amountDueId: await ensureOne("AmountDue"),
    missedDateId: await ensureOne("MissedPaymentDate"),
  };
}

// Find a contact by phone (exact match). Returns contactId or null.
async function findContactByPhone(
  phoneE164: string,
  username: string,
  apiKey: string
): Promise<number | null> {
  const headers = { "X-TM-Username": username, "X-TM-Key": apiKey };
  const q = encodeURIComponent(phoneE164);
  const res = await fetch(`${TM_BASE}/contacts/search?query=${q}&limit=5`, { headers });
  if (!res.ok) return null;
  const d = await res.json().catch(() => ({}));
  const resources = Array.isArray(d?.resources) ? d.resources : [];
  for (const c of resources) {
    const cPhone = String(c?.phone || "").replace(/\D/g, "");
    const target = phoneE164.replace(/\D/g, "");
    if (cPhone === target || cPhone === target.replace(/^1/, "")) {
      return Number(c.id);
    }
  }
  return null;
}

// Create a new contact with first name + our two custom fields.
async function createContact(
  recipient: TextRecipient,
  fieldIds: { amountDueId: number; missedDateId: number },
  username: string,
  apiKey: string
): Promise<number> {
  const body = new URLSearchParams({
    phone: recipient.phoneE164,
    firstName: recipient.firstName || "Customer",
    [`customFields[${fieldIds.amountDueId}]`]: recipient.amountDue,
    [`customFields[${fieldIds.missedDateId}]`]: recipient.nextDueDate,
  });
  const res = await fetch(`${TM_BASE}/contacts`, {
    method: "POST",
    headers: tmHeaders(username, apiKey),
    body: body.toString(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Contact create failed: ${d.message || `HTTP ${res.status}`}`);
  }
  return Number(d.id);
}

// Update existing contact's custom fields so merge pulls fresh data.
async function updateContactCustomFields(
  contactId: number,
  recipient: TextRecipient,
  fieldIds: { amountDueId: number; missedDateId: number },
  username: string,
  apiKey: string
): Promise<void> {
  const body = new URLSearchParams({
    phone: recipient.phoneE164,
    firstName: recipient.firstName || "Customer",
    [`customFields[${fieldIds.amountDueId}]`]: recipient.amountDue,
    [`customFields[${fieldIds.missedDateId}]`]: recipient.nextDueDate,
  });
  await fetch(`${TM_BASE}/contacts/${contactId}`, {
    method: "PUT",
    headers: tmHeaders(username, apiKey),
    body: body.toString(),
  });
}

// Upsert: find-or-create + always update custom fields with fresh amount/date.
async function upsertContact(
  recipient: TextRecipient,
  fieldIds: { amountDueId: number; missedDateId: number },
  username: string,
  apiKey: string
): Promise<number> {
  const existingId = await findContactByPhone(recipient.phoneE164, username, apiKey);
  if (existingId) {
    await updateContactCustomFields(existingId, recipient, fieldIds, username, apiKey);
    return existingId;
  }
  return await createContact(recipient, fieldIds, username, apiKey);
}

// Run contact upserts in parallel with a concurrency cap.
async function parallelUpsert(
  recipients: TextRecipient[],
  fieldIds: { amountDueId: number; missedDateId: number },
  username: string,
  apiKey: string,
  concurrency = 10
): Promise<BulkSendResult["perRecipient"]> {
  const results: BulkSendResult["perRecipient"] = new Array(recipients.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= recipients.length) return;
      const r = recipients[i];
      try {
        const contactId = await upsertContact(r, fieldIds, username, apiKey);
        results[i] = { recipientId: r.id, phone: r.phone, contactId, status: "synced" };
      } catch (e) {
        results[i] = { recipientId: r.id, phone: r.phone, status: "failed", error: String(e) };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * sendCampaignBulk — the proper TextMagic bulk flow:
 *   1) Ensure custom fields (AmountDue, MissedPaymentDate) exist
 *   2) Upsert each recipient as a TextMagic contact (in parallel)
 *   3) ONE POST /api/v2/messages (or /bulks if >1000) with inline template +
 *      all contact IDs — TextMagic does per-contact merge substitution server-side.
 *
 * Per-recipient message cost is the same as individual sends, but:
 *   - 1 send-API call instead of N
 *   - TextMagic may apply bulk/template pricing tiers on their side
 *   - Dramatically faster end-to-end (few seconds vs minutes)
 */
export async function sendCampaignBulk(
  recipients: TextRecipient[]
): Promise<BulkSendResult> {
  const username = process.env.TEXTMAGIC_USERNAME;
  const apiKey = process.env.TEXTMAGIC_API_KEY;
  if (!username || !apiKey) {
    return {
      ok: false,
      contactsSynced: 0,
      contactsFailed: 0,
      totalAttempted: recipients.length,
      error: "TEXTMAGIC_USERNAME or TEXTMAGIC_API_KEY not configured",
      perRecipient: [],
    };
  }

  try {
    // Step 1: custom fields
    const fieldIds = await ensureCustomFields(username, apiKey);

    // Step 2: contact upserts
    const perRecipient = await parallelUpsert(recipients, fieldIds, username, apiKey, 10);
    const contactIds = perRecipient
      .filter((r) => r.status === "synced" && r.contactId)
      .map((r) => r.contactId!);
    const synced = contactIds.length;
    const failed = perRecipient.length - synced;

    if (synced === 0) {
      return {
        ok: false,
        contactsSynced: 0,
        contactsFailed: failed,
        totalAttempted: recipients.length,
        error: "All contact upserts failed — cannot send",
        perRecipient,
      };
    }

    // Step 3: single bulk send.
    // /api/v2/messages handles up to 1000 recipients synchronously.
    // /api/v2/bulks handles larger via queue; identical params.
    const endpoint = synced > 1000 ? `${TM_BASE}/bulks` : `${TM_BASE}/messages`;
    const body = new URLSearchParams({
      text: BULK_MERGE_TEXT,
      contacts: contactIds.join(","),
    });
    const sendRes = await fetch(endpoint, {
      method: "POST",
      headers: tmHeaders(username, apiKey),
      body: body.toString(),
    });
    const sendJson = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      return {
        ok: false,
        contactsSynced: synced,
        contactsFailed: failed,
        totalAttempted: recipients.length,
        error: sendJson.message || `HTTP ${sendRes.status}`,
        perRecipient,
      };
    }

    return {
      ok: true,
      sessionId: sendJson.sessionId || sendJson.id,
      bulkId: sendJson.bulkId,
      contactsSynced: synced,
      contactsFailed: failed,
      totalAttempted: recipients.length,
      perRecipient,
    };
  } catch (e) {
    return {
      ok: false,
      contactsSynced: 0,
      contactsFailed: recipients.length,
      totalAttempted: recipients.length,
      error: String(e),
      perRecipient: [],
    };
  }
}

// Retained for backward compat / single-send debug, but no longer used by the route.
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
    const res = await fetch(`${TM_BASE}/messages`, {
      method: "POST",
      headers: tmHeaders(username, apiKey),
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
