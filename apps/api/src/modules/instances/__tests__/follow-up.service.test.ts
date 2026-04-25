import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FollowUpService } from '../follow-up.service.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makePrismaMock() {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ jid: 'contact@s.whatsapp.net' }]),
  };
}

function makeTenantPrismaRegistryMock(p = makePrismaMock()) {
  return { getClient: vi.fn().mockResolvedValue(p), _prisma: p };
}

function makeLoggerMock() {
  const inner = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child: vi.fn(() => inner), _inner: inner };
}

function makeQueueMock() {
  const addMock = vi.fn().mockResolvedValue({ id: 'job-abc-123' });
  return { add: addMock, _add: addMock };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-test-001';
const INSTANCE_ID = 'instance-xyz';
const CONTACT_JID = 'contact@s.whatsapp.net';
const MESSAGE = 'Olá, passando para verificar se precisa de algo!';

// A scheduledAt that is within business hours (10:00 São Paulo on a weekday)
// Use a fixed UTC time that maps to 10:00 in America/Sao_Paulo (UTC-3): 13:00 UTC
function makeBusinessHoursDate(): Date {
  const d = new Date();
  d.setUTCHours(13, 0, 0, 0); // 13:00 UTC = 10:00 America/Sao_Paulo (UTC-3)
  return d;
}

// A scheduledAt that is outside business hours (22:00 São Paulo): 01:00 UTC next day
function makeOutsideBusinessHoursDate(): Date {
  const d = new Date();
  d.setUTCHours(1, 0, 0, 0); // 01:00 UTC = 22:00 America/Sao_Paulo (UTC-3)
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FollowUpService — 24h Window + Business Hours (FOL-01, FOL-02)', () => {
  let prismaMock: ReturnType<typeof makePrismaMock>;
  let tenantPrismaRegistry: ReturnType<typeof makeTenantPrismaRegistryMock>;
  let logger: ReturnType<typeof makeLoggerMock>;
  let queueMock: ReturnType<typeof makeQueueMock>;
  let service: FollowUpService;

  beforeEach(() => {
    prismaMock = makePrismaMock();
    tenantPrismaRegistry = makeTenantPrismaRegistryMock(prismaMock);
    logger = makeLoggerMock();
    queueMock = makeQueueMock();
    service = new FollowUpService({
      followUpQueue: queueMock as any,
      tenantPrismaRegistry: tenantPrismaRegistry as any,
      logger: logger as any,
    });
  });

  it('scheduleFollowUp within 24h window creates BullMQ job', async () => {
    const lastContactAt = new Date(Date.now() - 23 * 60 * 60 * 1000); // 23h ago — within window
    const scheduledAt = makeBusinessHoursDate();

    const result = await service.scheduleFollowUp({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      contactJid: CONTACT_JID,
      message: MESSAGE,
      scheduledAt,
      lastContactAt,
    });

    expect(result.status).toBe('scheduled');
    expect((result as { status: 'scheduled'; jobId: string }).jobId).toBe('job-abc-123');
    expect(queueMock._add).toHaveBeenCalledOnce();
    // DB row inserted with status='pending'
    const insertCall = prismaMock.$executeRawUnsafe.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('pending')
    );
    expect(insertCall).toBeDefined();
  });

  it('scheduleFollowUp outside 24h window returns blocked:true and no BullMQ job', async () => {
    const lastContactAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago — outside window
    const scheduledAt = makeBusinessHoursDate();

    const result = await service.scheduleFollowUp({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      contactJid: CONTACT_JID,
      message: MESSAGE,
      scheduledAt,
      lastContactAt,
    });

    expect(result.status).toBe('blocked');
    expect((result as { status: 'blocked'; reason: string }).reason).toBe('outside_24h_window');
    expect(queueMock._add).not.toHaveBeenCalled();
    // DB row inserted with status='blocked' and blockedReason='outside_24h_window'
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('blocked'),
      expect.any(String), // followUpId
      INSTANCE_ID,
      CONTACT_JID,
      MESSAGE,
      scheduledAt,
      'outside_24h_window'
    );
  });

  it('scheduleFollowUp outside business hours (21:00-08:00 Sao Paulo) returns blocked:true', async () => {
    const lastContactAt = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago — within 24h window
    const scheduledAt = makeOutsideBusinessHoursDate();

    const result = await service.scheduleFollowUp({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      contactJid: CONTACT_JID,
      message: MESSAGE,
      scheduledAt,
      lastContactAt,
    });

    expect(result.status).toBe('blocked');
    expect((result as { status: 'blocked'; reason: string }).reason).toBe('outside_business_hours');
    expect(queueMock._add).not.toHaveBeenCalled();
  });

  it('blocked follow-up persisted to ScheduledFollowUp table with status=blocked', async () => {
    const lastContactAt = new Date(Date.now() - 26 * 60 * 60 * 1000); // outside 24h
    const scheduledAt = makeBusinessHoursDate();

    await service.scheduleFollowUp({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      contactJid: CONTACT_JID,
      message: MESSAGE,
      scheduledAt,
      lastContactAt,
    });

    // Exactly one $executeRawUnsafe call — the blocked INSERT
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledOnce();
    const [sql, , , , , , blockedReason] = prismaMock.$executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toContain('ScheduledFollowUp');
    expect(sql).toContain('blocked');
    expect(blockedReason).toBe('outside_24h_window');
  });

  it('force-override flag logs override and creates BullMQ job despite 24h block', async () => {
    const lastContactAt = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago — well outside window
    const scheduledAt = makeBusinessHoursDate();

    const result = await service.forceScheduleFollowUp({
      tenantId: TENANT_ID,
      instanceId: INSTANCE_ID,
      contactJid: CONTACT_JID,
      message: MESSAGE,
      scheduledAt,
      lastContactAt,
    });

    expect(result.status).toBe('scheduled');
    expect(queueMock._add).toHaveBeenCalledOnce();
    // DB row should include blockedReason='admin_override'
    const insertCall = prismaMock.$executeRawUnsafe.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('ScheduledFollowUp')
    );
    expect(insertCall).toBeDefined();
    const args = insertCall as unknown[];
    expect(args).toContain('admin_override');
  });
});
