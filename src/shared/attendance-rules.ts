/**
 * Pure attendance policy. No I/O, no router knowledge: this is the brand-independent core.
 * STRICT (default): first seen <= cutoff -> PRESENT, else ABSENT.
 * LATE:  <= start -> PRESENT, <= cutoff -> LATE, else ABSENT.
 * GRACE: <= start + grace -> PRESENT, else ABSENT.
 */
export type PolicyMode = 'STRICT' | 'LATE' | 'GRACE';
export type AutoStatus = 'PENDING' | 'PRESENT' | 'LATE' | 'ABSENT';

export interface PolicyInput {
  mode: PolicyMode;
  startAt: Date;
  cutoffAt: Date;
  graceMinutes: number;
}

/** Status implied by the evidence alone. `null` firstSeen means "no valid registered-device sighting". */
export function calculateAttendance(firstSeenAt: Date | null, p: PolicyInput): 'PRESENT' | 'LATE' | 'ABSENT' {
  if (!firstSeenAt) return 'ABSENT';
  const t = firstSeenAt.getTime();
  switch (p.mode) {
    case 'LATE':
      if (t <= p.startAt.getTime()) return 'PRESENT';
      return t <= p.cutoffAt.getTime() ? 'LATE' : 'ABSENT';
    case 'GRACE':
      return t <= p.startAt.getTime() + p.graceMinutes * 60_000 ? 'PRESENT' : 'ABSENT';
    default:
      return t <= p.cutoffAt.getTime() ? 'PRESENT' : 'ABSENT';
  }
}

/** The earliest sighting wins; a later one never replaces it. */
export function earliest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}
