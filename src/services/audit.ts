import type { Db } from '../db/pool.ts';

export interface AuditContext { userId: string | null; ip?: string | null; userAgent?: string | null }

export async function audit(db: Db, ctx: AuditContext, action: string, entityType: string, entityId: string | null,
  oldValue: unknown = null, newValue: unknown = null, reason: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value, reason, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.userId, action, entityType, entityId, oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue), reason, ctx.ip ?? null, ctx.userAgent ?? null]);
}
