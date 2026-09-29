import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export const bad = (msg: string) => new HttpError(400, 'VALIDATION_ERROR', msg);

export function sendJson(res: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

export async function readJson(req: IncomingMessage, max = 100 * 1024): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'BODY_TOO_LARGE', 'Body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Invalid JSON body'); }
}

export function parseCookies(header = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// --- tiny validators -------------------------------------------------------
export const text = (v: unknown, name: string, o: { max?: number; required?: boolean } = {}): string => {
  const s = v == null ? '' : v;
  if (typeof s !== 'string') throw bad(`${name} must be text`);
  const t = s.trim();
  if (o.required && !t) throw bad(`${name} is required`);
  if (t.length > (o.max ?? 200)) throw bad(`${name} is too long`);
  return t;
};
export const oneOf = <T extends string>(v: unknown, name: string, list: readonly T[]): T => {
  if (!list.includes(v as T)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v as T;
};
export const optUuid = (v: unknown, name: string): string | null => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw bad(`${name} is invalid`);
  return v;
};
export const int = (v: unknown, name: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number between ${min} and ${max}`);
  return n;
};
export const timeOfDay = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v)) throw bad(`${name} must be HH:MM`);
  return v;
};
export const dateStr = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${name} must be YYYY-MM-DD`);
  return v;
};
export const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

/** Neutralise spreadsheet formula injection in CSV exports. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
