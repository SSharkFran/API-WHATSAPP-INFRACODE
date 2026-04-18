import { describe, it, expect, vi, beforeEach } from "vitest";
// These tests will FAIL until Task 1 Step B adds getTodayMetrics() and getActiveQueue() to TenantManagementService
import { TenantManagementService } from "../service.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makePrismaMock() {
  return { $queryRawUnsafe: vi.fn() };
}

function makeTenantPrismaRegistryMock(p = makePrismaMock()) {
  return { getClient: vi.fn().mockResolvedValue(p), _prisma: p };
}

function makePlatformPrismaMock() {
  return {
    instance: {
      findMany: vi.fn().mockResolvedValue([{ id: "inst-1" }])
    }
  };
}

function makeServiceDeps() {
  const tenantPrismaRegistry = makeTenantPrismaRegistryMock();
  const platformPrisma = makePlatformPrismaMock();
  return {
    config: {} as never,
    platformPrisma: platformPrisma as never,
    tenantPrismaRegistry: tenantPrismaRegistry as never,
    emailService: {} as never,
    _tenantPrismaRegistry: tenantPrismaRegistry,
    _platformPrisma: platformPrisma,
  };
}

const TENANT_ID = "tenant-abc";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TenantManagementService — getTodayMetrics()", () => {
  it("MET-02: returns numeric metrics from raw query results (string coercion)", async () => {
    const deps = makeServiceDeps();
    const service = new TenantManagementService(deps as never);

    // Mock $queryRawUnsafe for both parallel queries
    let callCount = 0;
    deps._tenantPrismaRegistry._prisma.$queryRawUnsafe.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // metricsRows
        return Promise.resolve([{
          startedCount: "5",
          endedCount: "3",
          inactiveCount: "1",
          handoffCount: "2",
          avgDurationSeconds: "120",
          avgFirstResponseMs: "3000",
        }]);
      }
      // continuationRows
      return Promise.resolve([{
        timedOutCount: "1",
        totalClosedCount: "5",
      }]);
    });

    const result = await service.getTodayMetrics(TENANT_ID);

    expect(result.startedCount).toBe(5);
    expect(result.endedCount).toBe(3);
    expect(result.inactiveCount).toBe(1);
    expect(result.handoffCount).toBe(2);
    expect(result.avgDurationSeconds).toBe(120);
    expect(result.avgFirstResponseMs).toBe(3000);
  });

  it("MET-04: computes continuationRate correctly from timedOut and totalClosed", async () => {
    const deps = makeServiceDeps();
    const service = new TenantManagementService(deps as never);

    let callCount = 0;
    deps._tenantPrismaRegistry._prisma.$queryRawUnsafe.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve([{
          startedCount: "10",
          endedCount: "10",
          inactiveCount: "0",
          handoffCount: "0",
          avgDurationSeconds: null,
          avgFirstResponseMs: null,
        }]);
      }
      return Promise.resolve([{
        timedOutCount: "2",
        totalClosedCount: "10",
      }]);
    });

    const result = await service.getTodayMetrics(TENANT_ID);

    // continuationRate = (1 - 2/10) * 100 = 80
    expect(result.continuationRate).toBe(80);
  });

  it("MET-04 edge: returns null continuationRate when no closed sessions", async () => {
    const deps = makeServiceDeps();
    const service = new TenantManagementService(deps as never);

    let callCount = 0;
    deps._tenantPrismaRegistry._prisma.$queryRawUnsafe.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve([{
          startedCount: "5",
          endedCount: "0",
          inactiveCount: "0",
          handoffCount: "0",
          avgDurationSeconds: null,
          avgFirstResponseMs: null,
        }]);
      }
      return Promise.resolve([{
        timedOutCount: "0",
        totalClosedCount: "0",
      }]);
    });

    const result = await service.getTodayMetrics(TENANT_ID);

    expect(result.continuationRate).toBeNull();
  });
});

describe("TenantManagementService — getActiveQueue()", () => {
  it("MET-07: returns array of active sessions with urgencyScore and elapsedSeconds fields", async () => {
    const deps = makeServiceDeps();
    const service = new TenantManagementService(deps as never);

    const now = new Date();
    deps._tenantPrismaRegistry._prisma.$queryRawUnsafe.mockResolvedValue([
      { id: "s1", instanceId: "inst-1", remoteJid: "5511111@s.whatsapp.net", contactId: null, startedAt: now, urgencyScore: 90, elapsedSeconds: 600 },
      { id: "s2", instanceId: "inst-1", remoteJid: "5522222@s.whatsapp.net", contactId: "c-2", startedAt: now, urgencyScore: 45, elapsedSeconds: 300 },
      { id: "s3", instanceId: "inst-1", remoteJid: "5533333@s.whatsapp.net", contactId: null, startedAt: now, urgencyScore: 10, elapsedSeconds: 120 },
    ]);

    const result = await service.getActiveQueue(TENANT_ID);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      id: "s1",
      urgencyScore: 90,
      elapsedSeconds: 600,
    });
    expect(typeof result[0].startedAt).toBe("string");
    expect(result[0]).toHaveProperty("elapsedSeconds");
    expect(result[0]).toHaveProperty("urgencyScore");
  });
});
