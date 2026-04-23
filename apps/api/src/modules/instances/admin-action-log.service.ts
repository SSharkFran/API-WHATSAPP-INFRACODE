import { randomUUID } from 'node:crypto';
import type pino from 'pino';

export type AdminActionType =
  | 'document_send'
  | 'session_close'
  | 'status_query'
  | 'metrics_query'
  | 'human_takeover';

export interface AdminActionLogEntry {
  id?: string;
  triggeredByJid: string;
  actionType: AdminActionType;
  targetContactJid?: string | null;
  documentName?: string | null;
  messageText?: string | null;
  deliveryStatus?: 'pending' | 'sent' | 'failed';
}

export interface WriteLogOptions {
  tenantId: string;
  instanceId: string;
  adminJid: string;
  command: string;
  result: string;
}

export interface AdminActionLogDeps {
  logger: pino.Logger;
  tenantPrismaRegistry: {
    getClient: (tenantId: string) => Promise<{
      $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    }>;
  };
}

export class AdminActionLogService {
  private readonly logger: pino.Logger;

  constructor(private readonly deps: AdminActionLogDeps) {
    this.logger = deps.logger.child({ component: 'AdminActionLogService' });
  }

  /**
   * Non-blocking write via setImmediate — never throws.
   * Errors are logged as warnings.
   * Interface matches test scaffold: writeLog({ tenantId, instanceId, adminJid, command, result })
   */
  writeLog(opts: WriteLogOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.insertRow(opts)
          .catch((err) =>
            this.logger.warn({ err, tenantId: opts.tenantId, command: opts.command }, '[AdminActionLogService] write failed')
          )
          .finally(() => resolve());
      });
      // Resolve immediately so caller is not blocked
      resolve();
    });
  }

  private async insertRow(opts: WriteLogOptions): Promise<void> {
    const { tenantId, instanceId, adminJid, command, result } = opts;
    const db = await this.deps.tenantPrismaRegistry.getClient(tenantId);
    const schema = `tenant_${tenantId.replaceAll(/[^a-zA-Z0-9_]/g, '_')}`;
    const id = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "${schema}"."AdminActionLog"
         ("id", "triggeredByJid", "actionType", "targetContactJid", "documentName", "messageText", "deliveryStatus", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      id,
      adminJid,
      command,
      null,
      null,
      `${command} => ${result} [instance: ${instanceId}]`,
      result === 'sent' ? 'sent' : result === 'failed' ? 'failed' : 'pending'
    );
  }

  /**
   * Alternative non-blocking write for use from AdminCommandHandler.
   * write() returns void — caller does NOT await it.
   */
  write(tenantId: string, entry: AdminActionLogEntry): void {
    setImmediate(() => {
      void this.insertEntry(tenantId, entry).catch((err) =>
        this.logger.warn({ err, tenantId, entry }, '[AdminActionLogService] write failed')
      );
    });
  }

  private async insertEntry(tenantId: string, entry: AdminActionLogEntry): Promise<void> {
    const db = await this.deps.tenantPrismaRegistry.getClient(tenantId);
    const schema = `tenant_${tenantId.replaceAll(/[^a-zA-Z0-9_]/g, '_')}`;
    const id = entry.id ?? randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "${schema}"."AdminActionLog"
         ("id", "triggeredByJid", "actionType", "targetContactJid", "documentName", "messageText", "deliveryStatus", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      id,
      entry.triggeredByJid,
      entry.actionType,
      entry.targetContactJid ?? null,
      entry.documentName ?? null,
      entry.messageText ?? null,
      entry.deliveryStatus ?? 'pending'
    );
  }
}
