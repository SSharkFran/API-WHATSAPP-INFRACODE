import { describe, it, expect, vi, beforeEach } from "vitest";
// TODO: will pass after Task 2 implements SessionMetricsCollector
import { SessionMetricsCollector } from "../session-metrics-collector.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makePrismaMock() {
  return { $executeRawUnsafe: vi.fn().mockResolvedValue(1) };
}

function makeTenantPrismaRegistryMock(p = makePrismaMock()) {
  return { getClient: vi.fn().mockResolvedValue(p), _prisma: p };
}

function makeLoggerMock() {
  const inner = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child: vi.fn(() => inner), _inner: inner };
}

function makeEventBusMock() {
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  return {
    on: vi.fn((event: string, fn: (p: unknown) => void) => {
      listeners[event] = [...(listeners[event] ?? []), fn];
    }),
    emit: vi.fn((event: string, payload: unknown) => {
      (listeners[event] ?? []).forEach(fn => fn(payload));
    }),
    _listeners: listeners,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-abc";
const INSTANCE_ID = "instance-xyz";
const REMOTE_JID = "5511999887766@s.whatsapp.net";
const SESSION_ID = "session-uuid-1234";

// Helper: flush all setImmediate callbacks
function flushSetImmediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionMetricsCollector", () => {
  let prismaMock: ReturnType<typeof makePrismaMock>;
  let tenantPrismaRegistry: ReturnType<typeof makeTenantPrismaRegistryMock>;
  let logger: ReturnType<typeof makeLoggerMock>;
  let eventBus: ReturnType<typeof makeEventBusMock>;
  let collector: SessionMetricsCollector;

  beforeEach(() => {
    prismaMock = makePrismaMock();
    tenantPrismaRegistry = makeTenantPrismaRegistryMock(prismaMock);
    logger = makeLoggerMock();
    eventBus = makeEventBusMock();
    collector = new SessionMetricsCollector({
      eventBus: eventBus as any,
      tenantPrismaRegistry: tenantPrismaRegistry as any,
      logger: logger as any,
    });
  });

  // -------------------------------------------------------------------------
  // Test 1 (MET-01): session.opened event — constructor subscribes without error
  // SessionStateService already wrote the row; collector just tracks session
  // -------------------------------------------------------------------------
  it("Test 1 (MET-01): session.opened event — constructor subscribes to session.opened without error and does NOT call $executeRawUnsafe", async () => {
    // Emit session.opened — collector is already subscribed via constructor
    eventBus.emit("session.opened", {
      type: "session.opened",
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
      sessionId: SESSION_ID,
      contactId: null,
    });

    await flushSetImmediate();

    // SessionStateService already created the ConversationSession row — collector should NOT write again
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
    // Verify constructor subscribed to session.opened
    expect(eventBus.on).toHaveBeenCalledWith("session.opened", expect.any(Function));
  });

  // -------------------------------------------------------------------------
  // Test 2 (MET-03): session.first_response → writes firstResponseMs
  // -------------------------------------------------------------------------
  it("Test 2 (MET-03): session.first_response event causes $executeRawUnsafe with SET firstResponseMs WHERE id = sessionId", async () => {
    const FIRST_RESPONSE_MS = 4200;

    eventBus.emit("session.first_response", {
      type: "session.first_response",
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
      sessionId: SESSION_ID,
      firstResponseMs: FIRST_RESPONSE_MS,
    });

    await flushSetImmediate();

    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledOnce();
    const [sql, ...params] = prismaMock.$executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toContain('"firstResponseMs"');
    expect(sql).toContain('"id"');
    expect(params).toContain(FIRST_RESPONSE_MS);
    expect(params).toContain(SESSION_ID);
  });

  // -------------------------------------------------------------------------
  // Test 3 (MET-05): document.sent → increments documentCount
  // -------------------------------------------------------------------------
  it("Test 3 (MET-05): document.sent event causes $executeRawUnsafe with documentCount = documentCount + 1 WHERE id = sessionId", async () => {
    eventBus.emit("document.sent", {
      type: "document.sent",
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
      sessionId: SESSION_ID,
    });

    await flushSetImmediate();

    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledOnce();
    const [sql, ...params] = prismaMock.$executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toContain('"documentCount"');
    expect(sql).toContain('"documentCount" + 1');
    expect(sql).toContain('"id"');
    expect(params).toContain(SESSION_ID);
  });

  // -------------------------------------------------------------------------
  // Test 4 (MET-05 edge): document.sent with null sessionId → logs warn, no DB write
  // -------------------------------------------------------------------------
  it("Test 4 (MET-05 edge): document.sent with null sessionId logs warn and does NOT call $executeRawUnsafe", async () => {
    eventBus.emit("document.sent", {
      type: "document.sent",
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
      sessionId: null,
    });

    await flushSetImmediate();

    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(logger._inner.warn).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5: errors in DB writes are caught and logged, never re-thrown
  // -------------------------------------------------------------------------
  it("Test 5: DB write errors in event handlers are caught via logger.warn, not re-thrown to emit caller", async () => {
    const dbError = new Error("DB connection failed");
    prismaMock.$executeRawUnsafe.mockRejectedValueOnce(dbError);

    // Emit session.first_response — the DB write will fail
    let thrownError: unknown = null;
    try {
      eventBus.emit("session.first_response", {
        type: "session.first_response",
        tenantId: TENANT_ID,
        instanceId: INSTANCE_ID,
        remoteJid: REMOTE_JID,
        sessionId: SESSION_ID,
        firstResponseMs: 1000,
      });
    } catch (err) {
      thrownError = err;
    }

    // Emit must not throw
    expect(thrownError).toBeNull();

    await flushSetImmediate();
    // Error should be caught and logged
    expect(logger._inner.warn).toHaveBeenCalled();
  });
});

describe("SessionMetricsCollector — urgency_detected (URG-01)", () => {
  it.todo("session.urgency_detected event writes urgencyScore to ConversationSession DB row via $executeRawUnsafe");
});
