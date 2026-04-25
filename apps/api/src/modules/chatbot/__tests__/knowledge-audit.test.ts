import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeService } from '../knowledge.service.js';

// Mock TenantPrismaRegistry
const mockUpdate = vi.fn();
const mockCreate = vi.fn();
const mockFindMany = vi.fn();

const mockPrisma = {
  tenantKnowledge: {
    findMany: mockFindMany,
    create: mockCreate,
    update: mockUpdate,
  },
};

const mockRegistry = {
  getClient: vi.fn().mockResolvedValue(mockPrisma),
};

describe('KnowledgeService — Audit Metadata (APR-05)', () => {
  let service: KnowledgeService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new KnowledgeService({ tenantPrismaRegistry: mockRegistry as any });
    // No existing records — always create
    mockFindMany.mockResolvedValue([]);
  });

  it('saved knowledge entry has confirmedAt populated as non-null Date', async () => {
    const confirmedAt = new Date('2026-04-24T10:00:00Z');
    const confirmedByJid = '5511999990000@s.whatsapp.net';

    mockCreate.mockResolvedValue({
      id: 'test-id',
      instanceId: 'inst-1',
      question: 'horario de funcionamento',
      answer: 'das 9h as 18h',
      rawAnswer: 'das 9h as 18h',
      taughtBy: '5511999990000@s.whatsapp.net',
      confirmedAt,
      confirmedByJid,
      createdAt: new Date('2026-04-24T10:00:00Z'),
      updatedAt: new Date('2026-04-24T10:00:00Z'),
    });

    const result = await service.save(
      'tenant-1',
      'inst-1',
      'horario de funcionamento',
      'das 9h as 18h',
      'das 9h as 18h',
      '5511999990000@s.whatsapp.net',
      confirmedAt,
      confirmedByJid
    );

    expect(result.confirmedAt).toBe(confirmedAt.toISOString());
  });

  it('saved knowledge entry has confirmedByJid matching admin JID', async () => {
    const confirmedAt = new Date('2026-04-24T10:00:00Z');
    const confirmedByJid = '5511999990000@s.whatsapp.net';

    mockCreate.mockResolvedValue({
      id: 'test-id-2',
      instanceId: 'inst-1',
      question: 'preco do servico',
      answer: 'R$ 100',
      rawAnswer: 'R$ 100',
      taughtBy: '5511999990000@s.whatsapp.net',
      confirmedAt,
      confirmedByJid,
      createdAt: new Date('2026-04-24T10:00:00Z'),
      updatedAt: new Date('2026-04-24T10:00:00Z'),
    });

    const result = await service.save(
      'tenant-1',
      'inst-1',
      'preco do servico',
      'R$ 100',
      'R$ 100',
      '5511999990000@s.whatsapp.net',
      confirmedAt,
      confirmedByJid
    );

    expect(result.confirmedByJid).toBe('5511999990000@s.whatsapp.net');
  });
});
