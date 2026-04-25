import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { TenantPrismaRegistry } from '../../lib/database.js';
import type pino from 'pino';
import type { FollowUpJobData } from '../../queues/follow-up-queue.js';

export interface ScheduleFollowUpParams {
  tenantId: string;
  instanceId: string;
  contactJid: string;
  message: string;
  scheduledAt: Date;       // when to send
  lastContactAt: Date;     // ClientMemory.lastContactAt for 24h window check
  forceOverride?: boolean; // admin explicit override
}

export type ScheduleFollowUpResult =
  | { status: 'scheduled'; jobId: string; followUpId: string }
  | { status: 'blocked'; reason: 'outside_24h_window' | 'outside_business_hours'; followUpId: string };

const BUSINESS_HOURS_START = 8;  // 08:00 São Paulo
const BUSINESS_HOURS_END = 21;   // 21:00 São Paulo
const SAOPAULO_TZ = 'America/Sao_Paulo';

/**
 * Derives the tenant schema name from a tenantId — must match resolveTenantSchemaName()
 * in apps/api/src/lib/tenant-schema.ts.
 */
function resolveTenantSchema(tenantId: string): string {
  return `tenant_${tenantId.replaceAll(/[^a-zA-Z0-9_]/g, '_')}`;
}

export class FollowUpService {
  private readonly logger: pino.Logger;

  constructor(
    private readonly deps: {
      followUpQueue: Queue<FollowUpJobData>;
      tenantPrismaRegistry: TenantPrismaRegistry;
      logger: pino.Logger;
    }
  ) {
    this.logger = deps.logger.child({ component: 'FollowUpService' });
  }

  private isWithin24hWindow(lastContactAt: Date): boolean {
    return Date.now() - lastContactAt.getTime() < 24 * 60 * 60 * 1000;
  }

  private isWithinBusinessHours(targetDate: Date): boolean {
    // Convert to São Paulo local time before reading hours
    const localStr = targetDate.toLocaleString('en-US', { timeZone: SAOPAULO_TZ });
    const local = new Date(localStr);
    const h = local.getHours();
    return h >= BUSINESS_HOURS_START && h < BUSINESS_HOURS_END;
  }

  async scheduleFollowUp(params: ScheduleFollowUpParams): Promise<ScheduleFollowUpResult> {
    const followUpId = randomUUID();
    const schema = resolveTenantSchema(params.tenantId);
    const prisma = await this.deps.tenantPrismaRegistry.getClient(params.tenantId);

    // T-8-04-02: validate contactJid exists in ClientMemory before scheduling
    const existing = await prisma.$queryRawUnsafe<{ jid: string }[]>(
      `SELECT "jid" FROM "${schema}"."ClientMemory" WHERE "jid" = $1 LIMIT 1`,
      params.contactJid
    );
    if (!existing || existing.length === 0) {
      this.logger.warn(
        { tenantId: params.tenantId, contactJid: params.contactJid },
        '[follow-up] contactJid not found in ClientMemory — aborting scheduleFollowUp'
      );
      throw new Error(`contactJid not found: ${params.contactJid}`);
    }

    // Check 24h window (skip if force override)
    if (!params.forceOverride && !this.isWithin24hWindow(params.lastContactAt)) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}"."ScheduledFollowUp"
           ("id", "instanceId", "contactJid", "message", "scheduledAt", "status", "blockedReason")
         VALUES ($1, $2, $3, $4, $5, 'blocked', $6)`,
        followUpId,
        params.instanceId,
        params.contactJid,
        params.message,
        params.scheduledAt,
        'outside_24h_window'
      );
      this.logger.info(
        { followUpId, contactJid: params.contactJid },
        '[follow-up] blocked: outside 24h window'
      );
      return { status: 'blocked', reason: 'outside_24h_window', followUpId };
    }

    // Check business hours (skip if force override)
    if (!params.forceOverride && !this.isWithinBusinessHours(params.scheduledAt)) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}"."ScheduledFollowUp"
           ("id", "instanceId", "contactJid", "message", "scheduledAt", "status", "blockedReason")
         VALUES ($1, $2, $3, $4, $5, 'blocked', $6)`,
        followUpId,
        params.instanceId,
        params.contactJid,
        params.message,
        params.scheduledAt,
        'outside_business_hours'
      );
      this.logger.info(
        { followUpId, contactJid: params.contactJid },
        '[follow-up] blocked: outside business hours'
      );
      return { status: 'blocked', reason: 'outside_business_hours', followUpId };
    }

    // All checks passed (or overridden) — create BullMQ job
    const delayMs = Math.max(0, params.scheduledAt.getTime() - Date.now());
    const job = await this.deps.followUpQueue.add(
      'send-follow-up',
      {
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        contactJid: params.contactJid,
        message: params.message,
        followUpId,
      },
      { delay: delayMs }
    );

    // admin_override is recorded in blockedReason so the audit trail reflects the override
    const blockedReason = params.forceOverride ? 'admin_override' : null;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."ScheduledFollowUp"
         ("id", "instanceId", "contactJid", "message", "scheduledAt", "status", "blockedReason", "bullmqJobId")
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      followUpId,
      params.instanceId,
      params.contactJid,
      params.message,
      params.scheduledAt,
      blockedReason,
      job.id ?? null
    );

    this.logger.info(
      { followUpId, jobId: job.id, contactJid: params.contactJid, forceOverride: params.forceOverride ?? false },
      '[follow-up] scheduled'
    );

    return { status: 'scheduled', jobId: job.id ?? followUpId, followUpId };
  }

  /**
   * Admin force-override: schedules regardless of 24h window or business hours.
   * Records blockedReason='admin_override' in the ScheduledFollowUp row for audit trail (T-8-04-01).
   */
  async forceScheduleFollowUp(
    params: Omit<ScheduleFollowUpParams, 'forceOverride'>
  ): Promise<ScheduleFollowUpResult> {
    return this.scheduleFollowUp({ ...params, forceOverride: true });
  }
}
