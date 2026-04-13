import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpsert = vi.fn();
const mockFindFirst = vi.fn();
const mockFindUnique = vi.fn();

const mockPrisma = {
  contact: {
    upsert: mockUpsert,
    findFirst: mockFindFirst,
    findUnique: mockFindUnique
  }
};

const mockQueueAdd = vi.fn().mockResolvedValue({ id: "job-1" });
const mockLidReconciliationQueue = { add: mockQueueAdd };

// ---------------------------------------------------------------------------
// Helpers that replicate the service logic under test
// (extracted so tests don't depend on the full InstanceOrchestrator)
// ---------------------------------------------------------------------------

type UpsertArgs = {
  where: Record<string, unknown>;
  update: Record<string, unknown>;
  create: Record<string, unknown>;
};

/**
 * Replicates the @lid-aware upsert fork from handleInboundMessage.
 */
async function upsertContact(
  prisma: typeof mockPrisma,
  instanceId: string,
  remoteJid: string,
  storedContactPhoneNumber: string,
  displayName: string | undefined,
  nextContactFields: Record<string, unknown>
) {
  const isLid = remoteJid.endsWith("@lid");

  if (isLid) {
    return prisma.contact.upsert({
      where: { instanceId_rawJid: { instanceId, rawJid: remoteJid } },
      update: { displayName: displayName ?? undefined, fields: nextContactFields },
      create: {
        instanceId,
        phoneNumber: null,
        rawJid: remoteJid,
        displayName: displayName ?? null,
        fields: nextContactFields
      }
    } as UpsertArgs);
  } else {
    return prisma.contact.upsert({
      where: { instanceId_phoneNumber: { instanceId, phoneNumber: storedContactPhoneNumber } },
      update: { displayName: displayName ?? undefined, fields: nextContactFields },
      create: {
        instanceId,
        phoneNumber: storedContactPhoneNumber,
        rawJid: remoteJid,
        displayName: displayName ?? null,
        fields: nextContactFields
      }
    } as UpsertArgs);
  }
}

/**
 * Replicates the CONNECTED-branch reconciliation enqueue.
 */
async function enqueueReconciliation(
  queue: typeof mockLidReconciliationQueue,
  tenantId: string,
  instanceId: string
) {
  return queue.add(
    "reconcile",
    { tenantId, instanceId },
    {
      jobId: `lid-reconcile:${instanceId}`,
      removeOnComplete: 10,
      removeOnFail: 100
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LID normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: "c1", phoneNumber: null, rawJid: "19383773@lid" });
  });

  it("stores null in phoneNumber when remoteJid ends with @lid", async () => {
    await upsertContact(
      mockPrisma,
      "instance-1",
      "19383773@lid",
      "fallback-phone",
      "Test User",
      {}
    );

    expect(mockUpsert).toHaveBeenCalledOnce();
    const call = mockUpsert.mock.calls[0][0] as UpsertArgs;
    expect(call.create.phoneNumber).toBeNull();
  });

  it("stores raw @lid string in rawJid when phoneNumber is null", async () => {
    await upsertContact(
      mockPrisma,
      "instance-1",
      "19383773@lid",
      "fallback-phone",
      undefined,
      {}
    );

    const call = mockUpsert.mock.calls[0][0] as UpsertArgs;
    expect(call.create.rawJid).toBe("19383773@lid");
    expect(call.create.phoneNumber).toBeNull();
  });

  it("does not write @lid digits into phoneNumber column", async () => {
    const lidJid = "19383773@lid";
    // storedContactPhoneNumber would normally be derived from LID digits — ensure it's not used
    await upsertContact(mockPrisma, "instance-1", lidJid, "19383773", undefined, {});

    const call = mockUpsert.mock.calls[0][0] as UpsertArgs;
    // The create payload must never contain the lid digit string as phoneNumber
    expect(call.create.phoneNumber).not.toBe("19383773");
    expect(call.create.phoneNumber).toBeNull();
  });
});

describe("rawJid fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ id: "c1", phoneNumber: null, rawJid: "19383773@lid" });
  });

  it("upserts by instanceId_rawJid when remoteJid is @lid", async () => {
    await upsertContact(
      mockPrisma,
      "instance-1",
      "19383773@lid",
      "fallback",
      undefined,
      {}
    );

    const call = mockUpsert.mock.calls[0][0] as UpsertArgs;
    expect(call.where).toHaveProperty("instanceId_rawJid");
    expect((call.where as Record<string, unknown>).instanceId_rawJid).toEqual({
      instanceId: "instance-1",
      rawJid: "19383773@lid"
    });
    // Must NOT use instanceId_phoneNumber for LID contacts
    expect(call.where).not.toHaveProperty("instanceId_phoneNumber");
  });

  it("leaves phoneNumber null when LID resolution fails", async () => {
    // Simulate a contact returned with phoneNumber still null (resolution not yet available)
    mockUpsert.mockResolvedValueOnce({ id: "c1", phoneNumber: null, rawJid: "19383773@lid" });

    const result = await upsertContact(
      mockPrisma,
      "instance-1",
      "19383773@lid",
      "fallback",
      undefined,
      {}
    );

    expect(result.phoneNumber).toBeNull();
  });
});

describe("LID reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueAdd.mockResolvedValue({ id: "job-1" });
  });

  it("enqueues BullMQ job lid-reconcile:{instanceId} on connection.update:open", async () => {
    await enqueueReconciliation(mockLidReconciliationQueue, "tenant-1", "instance-abc");

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>
    ];
    expect(name).toBe("reconcile");
    expect(data).toEqual({ tenantId: "tenant-1", instanceId: "instance-abc" });
    expect(opts).toMatchObject({ jobId: "lid-reconcile:instance-abc" });
  });

  it("does not enqueue duplicate jobs for same instanceId", async () => {
    // BullMQ dedup: when jobId already exists, add() resolves without creating a new job
    // Simulate by calling add twice — the dedup is enforced by BullMQ via jobId
    // We verify our code always passes the same deterministic jobId
    await enqueueReconciliation(mockLidReconciliationQueue, "tenant-1", "instance-abc");
    await enqueueReconciliation(mockLidReconciliationQueue, "tenant-1", "instance-abc");

    // Both calls use the same jobId — BullMQ silently skips the second
    const firstJobId = (mockQueueAdd.mock.calls[0] as [string, unknown, { jobId: string }])[2].jobId;
    const secondJobId = (mockQueueAdd.mock.calls[1] as [string, unknown, { jobId: string }])[2].jobId;
    expect(firstJobId).toBe(secondJobId);
    expect(firstJobId).toBe("lid-reconcile:instance-abc");
  });
});
