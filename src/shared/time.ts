/** Timezone helpers built on Intl only (no dependencies). All instants are UTC Dates. */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function parts(instant: Date, tz: string) {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(instant)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Local calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function localDate(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Day of week (0=Sunday..6=Saturday) of a YYYY-MM-DD calendar date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Converts a local wall-clock time ("2026-09-29", "09:15" or "09:15:30") in `tz` to a UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = wall;
  // Two passes converge across DST transitions.
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wall - shown;
  }
  return new Date(guess);
}

export function isValidTimezone(tz: string): boolean {
  try { fmt(tz); return true; } catch { return false; }
}
