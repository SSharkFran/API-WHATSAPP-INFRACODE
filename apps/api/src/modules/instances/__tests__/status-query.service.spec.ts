import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusQueryService } from '../status-query.service.js';
import type { StatusQueryDeps, StatusSnapshot } from '../status-query.service.js';

// ---------------------------------------------------------------------------
// Tests for StatusQueryService — TDD RED phase
// ---------------------------------------------------------------------------

function makeDeps(): StatusQueryDeps {
  return {
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
    } as unknown as StatusQueryDeps['logger'],
    getInstanceStatus: vi.fn().mockReturnValue('connected'),
    getActiveSessionCount: vi.fn().mockResolvedValue(3),
    getTodayMessageCount: vi.fn().mockResolvedValue(42),
    getLastSummaryAt: vi.fn().mockResolvedValue(new Date('2026-04-23T08:00:00Z')),
  };
}

const TENANT_ID = 'tenant-abc';
const INSTANCE_ID = 'instance-xyz';

describe('StatusQueryService', () => {
  let deps: StatusQueryDeps;
  let service: StatusQueryService;

  beforeEach(() => {
    deps = makeDeps();
    service = new StatusQueryService(deps);
  });

  // -------------------------------------------------------------------------
  // getSnapshot
  // -------------------------------------------------------------------------

  it('returns a StatusSnapshot with all fields populated', async () => {
    const snap = await service.getSnapshot(TENANT_ID, INSTANCE_ID);

    expect(snap.instanceStatus).toBe('connected');
    expect(snap.activeSessionCount).toBe(3);
    expect(snap.todayMessageCount).toBe(42);
    expect(snap.lastSummaryAt).toBeInstanceOf(Date);
    expect(snap.generatedAt).toBeInstanceOf(Date);
  });

  it('fetches all data in parallel via Promise.all', async () => {
    // All deps should be called once per getSnapshot call
    await service.getSnapshot(TENANT_ID, INSTANCE_ID);

    expect(deps.getInstanceStatus).toHaveBeenCalledOnce();
    expect(deps.getActiveSessionCount).toHaveBeenCalledWith(TENANT_ID, INSTANCE_ID);
    expect(deps.getTodayMessageCount).toHaveBeenCalledWith(TENANT_ID, INSTANCE_ID);
    expect(deps.getLastSummaryAt).toHaveBeenCalledWith(TENANT_ID, INSTANCE_ID);
  });

  it('degrades gracefully when getActiveSessionCount throws — returns 0', async () => {
    (deps.getActiveSessionCount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    const snap = await service.getSnapshot(TENANT_ID, INSTANCE_ID);

    expect(snap.activeSessionCount).toBe(0);
    expect(snap.todayMessageCount).toBe(42); // other fields unaffected
  });

  it('degrades gracefully when getTodayMessageCount throws — returns 0', async () => {
    (deps.getTodayMessageCount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    const snap = await service.getSnapshot(TENANT_ID, INSTANCE_ID);

    expect(snap.todayMessageCount).toBe(0);
    expect(snap.activeSessionCount).toBe(3); // other fields unaffected
  });

  it('degrades gracefully when getLastSummaryAt throws — returns null', async () => {
    (deps.getLastSummaryAt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('redis error'));

    const snap = await service.getSnapshot(TENANT_ID, INSTANCE_ID);

    expect(snap.lastSummaryAt).toBeNull();
  });

  it('handles disconnected instance status', async () => {
    (deps.getInstanceStatus as ReturnType<typeof vi.fn>).mockReturnValue('disconnected');

    const snap = await service.getSnapshot(TENANT_ID, INSTANCE_ID);

    expect(snap.instanceStatus).toBe('disconnected');
  });

  it('handles null lastSummaryAt (no previous summary)', async () => {
    (deps.getLastSummaryAt as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const snap = await service.getSnapshot(TENANT_ID, INSTANCE_ID);

    expect(snap.lastSummaryAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // formatStatusMessage
  // -------------------------------------------------------------------------

  it('formatStatusMessage includes connection status in pt-BR', () => {
    const snap: StatusSnapshot = {
      instanceStatus: 'connected',
      activeSessionCount: 5,
      todayMessageCount: 100,
      lastSummaryAt: null,
      generatedAt: new Date(),
    };

    const msg = service.formatStatusMessage(snap);

    expect(msg).toContain('Conectado');
    expect(msg).toContain('5');
    expect(msg).toContain('100');
  });

  it('formatStatusMessage shows disconnected state', () => {
    const snap: StatusSnapshot = {
      instanceStatus: 'disconnected',
      activeSessionCount: 0,
      todayMessageCount: 0,
      lastSummaryAt: null,
      generatedAt: new Date(),
    };

    const msg = service.formatStatusMessage(snap);

    expect(msg).toContain('Desconectado');
  });

  it('formatStatusMessage shows "Nenhum" when no previous summary', () => {
    const snap: StatusSnapshot = {
      instanceStatus: 'connected',
      activeSessionCount: 0,
      todayMessageCount: 0,
      lastSummaryAt: null,
      generatedAt: new Date(),
    };

    const msg = service.formatStatusMessage(snap);

    expect(msg).toContain('Nenhum');
  });

  it('formatStatusMessage includes last summary timestamp when present', () => {
    const snap: StatusSnapshot = {
      instanceStatus: 'connected',
      activeSessionCount: 2,
      todayMessageCount: 15,
      lastSummaryAt: new Date('2026-04-23T08:00:00Z'),
      generatedAt: new Date(),
    };

    const msg = service.formatStatusMessage(snap);

    // Should contain some date representation
    expect(msg).not.toContain('Nenhum');
  });

  // -------------------------------------------------------------------------
  // formatResumoMessage
  // -------------------------------------------------------------------------

  it('formatResumoMessage includes daily summary heading in pt-BR', () => {
    const snap: StatusSnapshot = {
      instanceStatus: 'connected',
      activeSessionCount: 7,
      todayMessageCount: 200,
      lastSummaryAt: null,
      generatedAt: new Date(),
    };

    const msg = service.formatResumoMessage(snap);

    expect(msg).toContain('Resumo do Dia');
    expect(msg).toContain('7');
    expect(msg).toContain('200');
  });

  it('formatResumoMessage shows Online for connected instance', () => {
    const snap: StatusSnapshot = {
      instanceStatus: 'connected',
      activeSessionCount: 1,
      todayMessageCount: 10,
      lastSummaryAt: null,
      generatedAt: new Date(),
    };

    const msg = service.formatResumoMessage(snap);

    expect(msg).toContain('Online');
  });

  it('formatResumoMessage shows Offline for disconnected instance', () => {
    const snap: StatusSnapshot = {
      instanceStatus: 'disconnected',
      activeSessionCount: 0,
      todayMessageCount: 0,
      lastSummaryAt: null,
      generatedAt: new Date(),
    };

    const msg = service.formatResumoMessage(snap);

    expect(msg).toContain('Offline');
  });
});
