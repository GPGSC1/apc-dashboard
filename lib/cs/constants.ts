// CS Collections Dashboard — Constants

// Master rep list (first names only, matching Apps Script)
export const COLLECTION_REPS = [
  "Adrian",
  "Ash",
  "Danielle",
  "David",
  "Steven",
  "Rachel",
  "Katelyn",
  "Mark",
  "Josh",
  "Mallory",
];

// Dispositions that carry over to the next day's scrub
export const CARRYOVER_DISPOSITIONS = [
  "Follow Up",
  "Scheduled PDP",
  "Mailed Check",
  "Mailed C.",
];

// Walco agent entities
export const AGENT_ENTITIES = [
  { name: "Guardian Protection Group", code: "A00135" },
  { name: "Guardian Protection Group - Home", code: "A00217" },
  { name: "Secure Auto Center2", code: "A00170" },
  { name: "Guardian Protection Group", code: "A00254" },
];

// PBS Pending Cancellation Report column mapping
// Maps PBS Excel header names -> clean database column names
// PBS column index is 0-based from the raw Excel row
export const PBS_COLUMN_MAP: Record<string, { dbCol: string; index: number }> = {
  "Account Number": { dbCol: "account_number", index: 0 },
  "Insured Name": { dbCol: "insured_name", index: 1 },
  // index 2 is null spacer in PBS export
  "Agent": { dbCol: "agent_entity", index: 3 },
  "Policy Number": { dbCol: "policy_number", index: 4 },
  "Installments Made": { dbCol: "installments_made", index: 5 },
  "Next Due Date": { dbCol: "next_due_date", index: 6 },
  "Scheduled Cancellation Date": { dbCol: "sched_cxl_date", index: 7 },
  "Bill Hold": { dbCol: "bill_hold", index: 8 },
  "Billing Method": { dbCol: "billing_method", index: 9 },
  // index 10 is Cancellation Hold Date (not used in scrub)
  "Amount Due": { dbCol: "amount_due", index: 11 },
  "Main Phone": { dbCol: "main_phone", index: 12 },
  // indices 13-18: Home Phone, null, null, Text Msg Addr, Mobile Phone, Other Phone
  "Work Phone": { dbCol: "work_phone", index: 19 },
  // index 20 is null spacer
  "Customer Email": { dbCol: "customer_email", index: 21 },
  // index 22 is null spacer
  // indices 23-27: Insured Address, Address 2, City, State, Postal
  "State": { dbCol: "state", index: 26 },
};

// PBS header marker to find the header row in the Excel file
export const PBS_HEADER_MARKER = "Account Number";
export const PBS_FOOTER_MARKER = "Report Totals";

// Account number validation pattern (e.g., "1144-10883577")
export const ACCOUNT_NUM_PATTERN = /^\d{4}-/;
