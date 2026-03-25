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

export const AUTO_QUEUES = ["A1", "A2", "A3", "A4", "A5", "A6"];
export const HOME_QUEUES = ["H1", "H2", "H3", "H4", "H5"];
export const ALL_QUEUES = [...AUTO_QUEUES, ...HOME_QUEUES];

export function mapQueue(rawQueue: string): string | null {
  if (!rawQueue) return null;
  const lower = rawQueue.toLowerCase().trim();
  for (const [pattern, label] of Object.entries(QUEUE_MAP)) {
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
