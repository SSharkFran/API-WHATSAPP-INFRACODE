import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionStateService } from "../session-state.service.js";
import { SessionStatus } from "../conversation-session-manager.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRedisMock() {
  return {
    hset: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue({}),
  };
}

function makePrismaMock() {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
}

function makeTenantPrismaRegistryMock(prismaMock = makePrismaMock()) {
  return {
    getClient: vi.fn().mockResolvedValue(prismaMock),
    _prisma: prismaMock,
  };
}

function makeLoggerMock() {
  const inner = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    child: vi.fn(() => inner),
    _inner: inner,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-abc";
const INSTANCE_ID = "instance-xyz";
const REMOTE_JID = "5511999887766@s.whatsapp.net";

describe("SessionStateService", () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let prismaMock: ReturnType<typeof makePrismaMock>;
  let tenantPrismaRegistry: ReturnType<typeof makeTenantPrismaRegistryMock>;
  let logger: ReturnType<typeof makeLoggerMock>;
  let service: SessionStateService;

  beforeEach(() => {
    redis = makeRedisMock();
    prismaMock = makePrismaMock();
    tenantPrismaRegistry = makeTenantPrismaRegistryMock(prismaMock);
    logger = makeLoggerMock();
    service = new SessionStateService({
      redis: redis as any,
      tenantPrismaRegistry: tenantPrismaRegistry as any,
      logger: logger as any,
    });
  });

  // -------------------------------------------------------------------------
  // Test 1 (SESS-02): openSession writes HSET with correct fields
  // -------------------------------------------------------------------------
  it("Test 1 (SESS-02): openSession writes Redis HSET with status=ATIVA, humanTakeover=0, startedAt, sessionId", async () => {
    const sessionId = await service.openSession({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
    });

    expect(redis.hset).toHaveBeenCalledOnce();
    const [key, fields] = redis.hset.mock.calls[0] as [string, Record<string, string>];

    expect(key).toBe(`session:${TENANT_ID}:${INSTANCE_ID}:${REMOTE_JID}`);
    expect(fields.status).toBe(SessionStatus.ATIVA);
    expect(fields.humanTakeover).toBe("0");
    expect(fields.startedAt).toBeDefined();
    expect(new Date(fields.startedAt).toISOString()).toBe(fields.startedAt);
    expect(fields.sessionId).toBe(sessionId);
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(10); // UUID
  });

  // -------------------------------------------------------------------------
  // Test 2 (SESS-02): openSession calls redis.expire with 86400 seconds
  // -------------------------------------------------------------------------
  it("Test 2 (SESS-02): openSession calls redis.expire with TTL=86400", async () => {
    await service.openSession({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
    });

    expect(redis.expire).toHaveBeenCalledOnce();
    const [key, ttl] = redis.expire.mock.calls[0] as [string, number];
    expect(key).toBe(`session:${TENANT_ID}:${INSTANCE_ID}:${REMOTE_JID}`);
    expect(ttl).toBe(86400);
  });

  // -------------------------------------------------------------------------
  // Test 3 (SESS-02): openSession inserts a ConversationSession row in PostgreSQL
  // -------------------------------------------------------------------------
  it("Test 3 (SESS-02): openSession calls prisma.$executeRawUnsafe with INSERT into ConversationSession", async () => {
    await service.openSession({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
    });

    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledOnce();
    const [sql] = prismaMock.$executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(sql.toLowerCase()).toContain("insert");
    expect(sql).toContain("ConversationSession");
  });

  // -------------------------------------------------------------------------
  // Test 4 (SESS-06/07): isHumanTakeover returns false when Redis returns '0'
  //                       and true when Redis returns '1'
  // -------------------------------------------------------------------------
  it("Test 4 (SESS-06/07): isHumanTakeover returns false when Redis hget returns '0'", async () => {
    redis.hget.mockResolvedValueOnce("0");
    const result = await service.isHumanTakeover(TENANT_ID, INSTANCE_ID, REMOTE_JID);
    expect(result).toBe(false);
  });

  it("Test 4b (SESS-06/07): isHumanTakeover returns true when Redis hget returns '1'", async () => {
    redis.hget.mockResolvedValueOnce("1");
    const result = await service.isHumanTakeover(TENANT_ID, INSTANCE_ID, REMOTE_JID);
    expect(result).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5 (SESS-07): isHumanTakeover returns false when Redis key is missing
  // -------------------------------------------------------------------------
  it("Test 5 (SESS-07): isHumanTakeover returns false when Redis hget returns null (safe default)", async () => {
    redis.hget.mockResolvedValueOnce(null);
    const result = await service.isHumanTakeover(TENANT_ID, INSTANCE_ID, REMOTE_JID);
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6 (SESS-02): getSessionState returns null when Redis returns empty hash
  // -------------------------------------------------------------------------
  it("Test 6 (SESS-02): getSessionState returns null when Redis hgetall returns empty object", async () => {
    redis.hgetall.mockResolvedValueOnce({});
    const result = await service.getSessionState(TENANT_ID, INSTANCE_ID, REMOTE_JID);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 7 (SESS-08): closeSession calls UPDATE with endedAt, durationSeconds, closedReason, status
  // -------------------------------------------------------------------------
  it("Test 7 (SESS-08): closeSession calls prisma.$executeRawUnsafe with UPDATE setting endedAt, durationSeconds, closedReason, status", async () => {
    const startedAt = new Date(Date.now() - 60000).toISOString(); // 60 seconds ago
    const sessionId = "test-session-uuid";
    redis.hgetall.mockResolvedValueOnce({
      status: SessionStatus.ATIVA,
      humanTakeover: "0",
      startedAt,
      sessionId,
    });

    await service.closeSession({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
      closedReason: "client_closed",
    });

    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledOnce();
    const [sql, ...params] = prismaMock.$executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(sql.toLowerCase()).toContain("update");
    expect(sql).toContain("ConversationSession");
    expect(sql.toLowerCase()).toContain("endedat");
    expect(sql.toLowerCase()).toContain("durationseconds");
    expect(sql.toLowerCase()).toContain("closedreason");
    expect(sql.toLowerCase()).toContain("status");
    // closedReason param
    expect(params).toContain("client_closed");
    // sessionId param
    expect(params).toContain(sessionId);
  });

  // -------------------------------------------------------------------------
  // Test 8 (SESS-08): closeSession sets status to ENCERRADA in Redis
  // -------------------------------------------------------------------------
  it("Test 8 (SESS-08): closeSession sets status=ENCERRADA in Redis hash for non-timeout reason", async () => {
    const startedAt = new Date(Date.now() - 30000).toISOString();
    const sessionId = "test-session-uuid-2";
    redis.hgetall.mockResolvedValueOnce({
      status: SessionStatus.ATIVA,
      humanTakeover: "0",
      startedAt,
      sessionId,
    });

    await service.closeSession({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      remoteJid: REMOTE_JID,
      closedReason: "client_closed",
    });

    expect(redis.hset).toHaveBeenCalledOnce();
    const [, fields] = redis.hset.mock.calls[0] as [string, Record<string, string>];
    expect(fields.status).toBe(SessionStatus.ENCERRADA);
  });

  // -------------------------------------------------------------------------
  // Test 9: updateStatus updates only the status field in Redis HSET
  // -------------------------------------------------------------------------
  it("Test 9: updateStatus calls Redis HSET with only the status field and extends TTL", async () => {
    await service.updateStatus(TENANT_ID, INSTANCE_ID, REMOTE_JID, SessionStatus.CONFIRMACAO_ENVIADA);

    expect(redis.hset).toHaveBeenCalledOnce();
    const [key, fields] = redis.hset.mock.calls[0] as [string, Record<string, string>];
    expect(key).toBe(`session:${TENANT_ID}:${INSTANCE_ID}:${REMOTE_JID}`);
    expect(fields).toEqual({ status: SessionStatus.CONFIRMACAO_ENVIADA });

    expect(redis.expire).toHaveBeenCalledOnce();
    const [expireKey, ttl] = redis.expire.mock.calls[0] as [string, number];
    expect(expireKey).toBe(`session:${TENANT_ID}:${INSTANCE_ID}:${REMOTE_JID}`);
    expect(ttl).toBe(86400);
  });
});
