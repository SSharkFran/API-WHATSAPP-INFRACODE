import { describe, it } from 'vitest';
// Stub — will fail until Plan 02 refactors EscalationService.
// Tests are written against the post-refactor interface.
import { EscalationService } from '../escalation.service.js';

describe('EscalationService — Confirmation Gate (APR-02, APR-04)', () => {
  it.todo('admin reply triggers confirmation echo; knowledgeService.save NOT called immediately');
  it.todo('admin follow-up "SIM" triggers knowledgeService.save and deletes Redis key');
  it.todo('admin follow-up "ok" does NOT trigger knowledgeService.save');
  it.todo('admin follow-up "claro" does NOT trigger knowledgeService.save');
  it.todo('Redis confirmation key has TTL=600 after first admin reply');
});
