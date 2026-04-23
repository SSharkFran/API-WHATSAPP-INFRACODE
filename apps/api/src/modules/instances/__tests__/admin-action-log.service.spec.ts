import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdminActionLogService } from "../admin-action-log.service.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makePrismaMock() {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
}

function makeTenantPrismaRegistryMock(p = makePrismaMock()) {
  return { getClient: vi.fn().mockResolvedValue(p), _prisma: p };
}

function makeLoggerMock() {
  const inner = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child: vi.fn(() => inner), _inner: inner };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-abc";
const INSTANCE_ID = "instance-xyz";
const ADMIN_JID = "5511999887766@s.whatsapp.net";

function flushSetImmediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdminActionLogService", () => {
  let prismaMock: ReturnType<typeof makePrismaMock>;
  let tenantPrismaRegistry: ReturnType<typeof makeTenantPrismaRegistryMock>;
  let logger: ReturnType<typeof makeLoggerMock>;
  let service: AdminActionLogService;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock = makePrismaMock();
    tenantPrismaRegistry = makeTenantPrismaRegistryMock(prismaMock);
    logger = makeLoggerMock();
    service = new AdminActionLogService({
      tenantPrismaRegistry: tenantPrismaRegistry as never,
      logger: logger as never,
    });
  });

  // CMD-05: writes a row to AdminActionLog after every command
  it("writes a row to AdminActionLog after every command", async () => {
    await service.writeLog({ tenantId: TENANT_ID, instanceId: INSTANCE_ID, adminJid: ADMIN_JID, command: '/contrato João', result: 'sent' });
    await flushSetImmediate();
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledOnce();
    const [sql] = prismaMock.$executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toContain('"AdminActionLog"');
  });

  // CMD-05: does not throw when DB write fails — logs warn and continues
  it("does not throw when DB write fails — logs warn and continues", async () => {
    prismaMock.$executeRawUnsafe.mockRejectedValueOnce(new Error("DB connection failed"));

    let thrownError: unknown = null;
    try {
      await service.writeLog({ tenantId: TENANT_ID, instanceId: INSTANCE_ID, adminJid: ADMIN_JID, command: '/status', result: 'ok' });
    } catch (err) { thrownError = err; }
    await flushSetImmediate();
    expect(thrownError).toBeNull();
    expect(logger._inner.warn).toHaveBeenCalled();
  });

  // CMD-05: uses setImmediate for deferred write — does not block caller
  it("uses setImmediate for deferred write — does not block caller", async () => {
    let dbCallHappened = false;
    prismaMock.$executeRawUnsafe.mockImplementation(async () => {
      dbCallHappened = true;
      return 1;
    });

    const callPromise = service.writeLog({ tenantId: TENANT_ID, instanceId: INSTANCE_ID, adminJid: ADMIN_JID, command: '/status', result: 'ok' });
    // Synchronous resolution should happen before DB write
    expect(dbCallHappened).toBe(false); // setImmediate deferred
    await callPromise;
    expect(dbCallHappened).toBe(false); // still not run until setImmediate fires
    await flushSetImmediate();
    expect(dbCallHappened).toBe(true);
  });
});
