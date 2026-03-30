// Queue mapping: 3CX queue names → dashboard display labels

export const QUEUE_MAP: Record<string, string> = {
  "mail 1": "A1",
  "mail 2": "A2",
  "mail 3": "A3",
  "mail 4": "A4",
  "mail 5": "A5",
  "mail 6": "A6",
  "home 1": "H1",
  "home 2": "H2",
  "home 3": "H3",
  "home 4": "H4",
  "home 5": "H5",
};

// Internal transfer / non-sales queues tracked for attribution
export const SPECIAL_QUEUE_MAP: Record<string, string> = {
  "spanish": "SP_Q",
  "to": "TO",
};

// All queues we track in queue_calls (sales + special)
export const ALL_TRACKED_MAP: Record<string, string> = {
  ...QUEUE_MAP,
  ...SPECIAL_QUEUE_MAP,
};

export const AUTO_QUEUES = ["A1", "A2", "A3", "A4", "A5", "A6"];
export const HOME_QUEUES = ["H1", "H2", "H3", "H4", "H5"];
export const ALL_QUEUES = [...AUTO_QUEUES, ...HOME_QUEUES];

// Queues excluded from main sales counts (calls exist but don't roll into queue totals)
export const EXCLUDED_CALL_QUEUES = ["SP_Q"];
// Queues that are never deduped (every call counts)
export const NEVER_DEDUP_QUEUES = ["TO"];

export function mapQueue(rawQueue: string): string | null {
  if (!rawQueue) return null;
  const lower = rawQueue.toLowerCase().trim();
  for (const [pattern, label] of Object.entries(QUEUE_MAP)) {
    if (lower.includes(pattern)) return label;
  }
  return null;
}

// Maps any tracked queue (sales + special) to its label
export function mapAnyQueue(rawQueue: string): string | null {
  if (!rawQueue) return null;
  const lower = rawQueue.toLowerCase().trim();
  for (const [pattern, label] of Object.entries(ALL_TRACKED_MAP)) {
    if (lower.includes(pattern)) return label;
  }
  return null;
}

export function isAutoQueue(label: string): boolean {
  return label.startsWith("A");
}

export function isHomeQueue(label: string): boolean {
  return label.startsWith("H");
}
