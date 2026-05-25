type InFlightEntry = {
  requestId: string;
  startedAt: number;
};

const inFlightByKey = new Map<string, InFlightEntry>();

export function acquireInFlight(
  key: string,
  requestId: string,
): { ok: true } | { ok: false; active: InFlightEntry } {
  const existing = inFlightByKey.get(key);
  if (existing) {
    return { ok: false, active: existing };
  }
  inFlightByKey.set(key, { requestId, startedAt: Date.now() });
  return { ok: true };
}

export function releaseInFlight(key: string, requestId: string) {
  const active = inFlightByKey.get(key);
  if (active?.requestId === requestId) {
    inFlightByKey.delete(key);
  }
}

