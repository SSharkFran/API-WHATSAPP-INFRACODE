import type { Job } from "bullmq";
import type pino from "pino";
import type { InstanceOrchestrator } from "../modules/instances/service.js";
import type { TenantPrismaRegistry } from "../lib/database.js";
import type { PlatformPrisma } from "../lib/database.js";

export interface LidReconciliationJobPayload {
  tenantId: string;
  instanceId: string;
}

export interface LidReconciliationWorkerDeps {
  tenantPrismaRegistry: TenantPrismaRegistry;
  platformPrisma: PlatformPrisma;
  instanceOrchestrator: InstanceOrchestrator;
  logger: pino.Logger;
}

/**
 * Factory that creates a BullMQ processor function for lid-reconciliation jobs.
 *
 * Finds all contacts for an instance with phoneNumber=null and rawJid!=null,
 * then calls instanceOrchestrator.reconcileLidContact() for each that has a
 * sharedPhoneJid stored in their fields — defers all merge logic to
 * persistLidPhoneMapping (CRM-01, Plan 2.1).
 *
 * Security: T-02-01-02 — tenantId is verified inside reconcileLidContact before
 * any DB write. T-02-01-05 — only rawJid (opaque LID string) and counts are logged,
 * never resolved phoneNumber in plaintext.
 */
export const createLidReconciliationProcessor = (deps: LidReconciliationWorkerDeps) =>
  async (job: Job<LidReconciliationJobPayload>): Promise<void> => {
    const { tenantId, instanceId } = job.data;
    const logger = deps.logger.child({ component: "LidReconciliationWorker", instanceId });
    const startMs = Date.now();

    await deps.tenantPrismaRegistry.ensureSchema(deps.platformPrisma, tenantId);
    const prisma = await deps.tenantPrismaRegistry.getClient(tenantId);

    // Find all contacts for this instance with null phoneNumber but non-null rawJid
    const unresolved = await prisma.contact.findMany({
      where: { instanceId, phoneNumber: null, rawJid: { not: null } },
      select: { id: true, rawJid: true, fields: true }
    });

    logger.info(
      { instanceId, count: unresolved.length, elapsedMs: Date.now() - startMs },
      "LID reconciliation: found unresolved contacts"
    );

    let resolved = 0;
    for (const contact of unresolved) {
      // sharedPhoneJid may have been stored by a prior phone-number-share event
      const sharedPhoneJid =
        contact.fields && typeof contact.fields === "object"
          ? ((contact.fields as Record<string, unknown>).sharedPhoneJid as string | undefined)
          : undefined;

      if (!sharedPhoneJid) {
        // Cannot resolve without sharedPhoneJid — wait for next connection event
        continue;
      }

      try {
        // Call reconcileLidContact which delegates to persistLidPhoneMapping — DO NOT duplicate merge logic
        await deps.instanceOrchestrator.reconcileLidContact(
          tenantId,
          instanceId,
          contact.rawJid!,
          sharedPhoneJid
        );
        resolved++;
      } catch (err) {
        // T-02-01-05: log only rawJid (opaque), never resolved phone in plaintext
        logger.warn({ instanceId, rawJid: contact.rawJid, err }, "LID reconciliation: failed for one contact");
      }
    }

    logger.info(
      { instanceId, resolved, total: unresolved.length, elapsedMs: Date.now() - startMs },
      "LID reconciliation: complete"
    );
  };
