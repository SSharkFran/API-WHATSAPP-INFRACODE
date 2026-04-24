import { describe, it } from 'vitest';
// Stub — will fail until Plan 03 adds confirmedAt/confirmedByJid to schema and service.
import { KnowledgeService } from '../knowledge.service.js';

describe('KnowledgeService — Audit Metadata (APR-05)', () => {
  it.todo('saved knowledge entry has confirmedAt populated as non-null Date');
  it.todo('saved knowledge entry has confirmedByJid matching admin JID');
});
