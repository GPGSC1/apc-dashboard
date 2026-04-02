// CS Collections — Pure scrub pipeline functions
// No DB calls — testable in isolation

import { parseDate } from "../date-utils";
import {
  PBS_HEADER_MARKER,
  PBS_FOOTER_MARKER,
  ACCOUNT_NUM_PATTERN,
} from "./constants";

// --- Interfaces ---

export interface CleanAccount {
  account_number: string;
  insured_name: string;
  policy_number: string;
  agent_entity: string;
  installments_made: number;
  next_due_date: string | null; // YYYY-MM-DD
  sched_cxl_date: string | null;
  bill_hold: string;
  billing_method: string;
  amount_due: number;
  main_phone: string;
  work_phone: string;
  customer_email: string;
  state: string;
  assigned_rep: string;
  dispo_1: string;
  dispo_2: string;
  dispo_date: string | null;
  email_sent: boolean;
  is_carryover: boolean;
}

export interface ScrubSummary {
  rawRowCount: number;
  notYetDueCount: number;
  pastDueCount: number;
  carryOverKept: number;
  carryOverStale: number;
  carryOverResolved: number;
  dupeCount: number;
  finalCount: number;
  repBreakdown: Record<string, number>;
}

// --- PBS column indices (0-based from raw Excel row) ---
const PBS = {
  ACCOUNT_NUM: 0,
  INSURED_NAME: 1,
  AGENT_ENTITY: 3,
  POLICY_NUM: 4,
  INSTALLMENTS: 5,
  NEXT_DUE_DATE: 6,
  SCHED_CXL_DATE: 7,
  BILL_HOLD: 8,
  BILLING_METHOD: 9,
  AMOUNT_DUE: 11,
  MAIN_PHONE: 12,
  WORK_PHONE: 19,
  CUSTOMER_EMAIL: 21,
  STATE: 26,
};

// --- Functions ---

/**
 * Find the header row index in raw PBS Excel data.
 * Returns -1 if not found.
 */
export function findHeaderRow(rawData: unknown[][]): number {
  for (let i = 0; i < Math.min(rawData.length, 25); i++) {
    if (String(rawData[i]?.[0] ?? "").trim() === PBS_HEADER_MARKER) {
      return i;
    }
  }
  return -1;
}

/**
 * Clean a string value: trim, replace NaN/null/undefined/"--" with "".
 */
function cleanStr(val: unknown): string {
  if (val == null) return "";
  const s = String(val).trim();
  const lower = s.toLowerCase();
  if (lower === "nan" || lower === "null" || lower === "undefined" || lower === "--") {
    return "";
  }
  return s;
}

/**
 * Map one raw PBS row to a CleanAccount.
 * Returns null for invalid rows (missing account number, footer row, etc.)
 */
export function mapPBSRow(raw: unknown[]): CleanAccount | null {
  const acctNum = cleanStr(raw[PBS.ACCOUNT_NUM]);

  // Skip footer, empty rows, invalid account numbers
  if (!acctNum || acctNum === PBS_FOOTER_MARKER || !ACCOUNT_NUM_PATTERN.test(acctNum)) {
    return null;
  }

  const amountRaw = raw[PBS.AMOUNT_DUE];
  const amount = typeof amountRaw === "number" ? amountRaw : parseFloat(cleanStr(amountRaw)) || 0;

  const installRaw = raw[PBS.INSTALLMENTS];
  const installments = typeof installRaw === "number" ? Math.floor(installRaw) : parseInt(cleanStr(installRaw), 10) || 0;

  return {
    account_number: acctNum,
    insured_name: cleanStr(raw[PBS.INSURED_NAME]),
    policy_number: cleanStr(raw[PBS.POLICY_NUM]),
    agent_entity: cleanStr(raw[PBS.AGENT_ENTITY]),
    installments_made: installments,
    next_due_date: parseDate(raw[PBS.NEXT_DUE_DATE] as string | number),
    sched_cxl_date: parseDate(raw[PBS.SCHED_CXL_DATE] as string | number),
    bill_hold: cleanStr(raw[PBS.BILL_HOLD]),
    billing_method: cleanStr(raw[PBS.BILLING_METHOD]),
    amount_due: Math.round(amount * 100) / 100,
    main_phone: cleanStr(raw[PBS.MAIN_PHONE]),
    work_phone: cleanStr(raw[PBS.WORK_PHONE]),
    customer_email: cleanStr(raw[PBS.CUSTOMER_EMAIL]),
    state: cleanStr(raw[PBS.STATE]),
    assigned_rep: "",
    dispo_1: "",
    dispo_2: "",
    dispo_date: null,
    email_sent: false,
    is_carryover: false,
  };
}

/**
 * Transform all raw PBS rows into clean accounts.
 * Skips header row and everything before it.
 */
export function transformPBSData(rawData: unknown[][]): CleanAccount[] {
  const headerIdx = findHeaderRow(rawData);
  if (headerIdx === -1) return [];

  const accounts: CleanAccount[] = [];
  for (let i = headerIdx + 1; i < rawData.length; i++) {
    const account = mapPBSRow(rawData[i]);
    if (account) accounts.push(account);
  }
  return accounts;
}

/**
 * Filter: remove accounts where next_due_date >= today (not yet past due).
 * Returns { pastDue, notYetDueCount }.
 */
export function filterPastDue(
  accounts: CleanAccount[],
  todayStr: string
): { pastDue: CleanAccount[]; notYetDueCount: number } {
  const pastDue: CleanAccount[] = [];
  let notYetDueCount = 0;

  for (const acct of accounts) {
    if (acct.next_due_date && acct.next_due_date >= todayStr) {
      notYetDueCount++;
    } else {
      pastDue.push(acct);
    }
  }

  return { pastDue, notYetDueCount };
}

/**
 * Sort by installments_made ascending (0-pay accounts first = highest priority).
 */
export function sortByPriority(accounts: CleanAccount[]): CleanAccount[] {
  return [...accounts].sort((a, b) => a.installments_made - b.installments_made);
}

/**
 * Round-robin assign working reps to accounts.
 * Mutates accounts in place (sets assigned_rep).
 */
export function roundRobinAssign(accounts: CleanAccount[], reps: string[]): void {
  if (reps.length === 0) return;
  for (let i = 0; i < accounts.length; i++) {
    accounts[i].assigned_rep = reps[i % reps.length];
  }
}

/**
 * Remove fresh accounts whose account_number is in the carry-over set.
 * Returns { fresh, dupeCount }.
 */
export function dedup(
  freshAccounts: CleanAccount[],
  carryoverAccountNumbers: Set<string>
): { fresh: CleanAccount[]; dupeCount: number } {
  const fresh: CleanAccount[] = [];
  let dupeCount = 0;

  for (const acct of freshAccounts) {
    if (carryoverAccountNumbers.has(acct.account_number)) {
      dupeCount++;
    } else {
      fresh.push(acct);
    }
  }

  return { fresh, dupeCount };
}

/**
 * Merge carry-overs + fresh accounts, sort by assigned_rep then account_number.
 */
export function mergeAndSort(carryOvers: CleanAccount[], fresh: CleanAccount[]): CleanAccount[] {
  const merged = [...carryOvers, ...fresh];
  merged.sort((a, b) => {
    const repCmp = a.assigned_rep.toLowerCase().localeCompare(b.assigned_rep.toLowerCase());
    if (repCmp !== 0) return repCmp;
    return a.account_number.localeCompare(b.account_number);
  });
  return merged;
}

/**
 * Build rep breakdown from merged list.
 */
export function buildRepBreakdown(accounts: CleanAccount[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const acct of accounts) {
    if (acct.assigned_rep) {
      breakdown[acct.assigned_rep] = (breakdown[acct.assigned_rep] || 0) + 1;
    }
  }
  return breakdown;
}
