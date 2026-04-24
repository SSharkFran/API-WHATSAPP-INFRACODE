import { describe, it, expect } from 'vitest';
// These imports will fail until Plan 01 creates the files — that is intentional.
// Wave 0: stubs exist so the verify command in Plan 01 has a target.
import {
  DisabledAprendizadoContinuoModule,
  ActiveAprendizadoContinuoModule,
} from '../aprendizado-continuo.disabled.js';

describe('DisabledAprendizadoContinuoModule — APR-01 Null Object', () => {
  const mod = new DisabledAprendizadoContinuoModule();

  it('isEnabled() returns false', () => {
    expect(mod.isEnabled()).toBe(false);
  });
  it('getAdminPhones() returns []', () => {
    expect(mod.getAdminPhones()).toEqual([]);
  });
  it('getAdminJids() returns []', () => {
    expect(mod.getAdminJids()).toEqual([]);
  });
  it('processLearningReply() resolves to null', async () => {
    await expect(mod.processLearningReply('t1', 'i1', 'any')).resolves.toBeNull();
  });
  it('shouldSendDailySummary() returns false', () => {
    expect(mod.shouldSendDailySummary('t1', 'i1')).toBe(false);
  });
  it('buildDailySummary() resolves to empty string', async () => {
    await expect(mod.buildDailySummary('t1', 'i1')).resolves.toBe('');
  });
});

describe('ActiveAprendizadoContinuoModule — APR-01 active path', () => {
  it('isEnabled() returns true', () => {
    const mod = new ActiveAprendizadoContinuoModule({
      isEnabled: true,
      verificationStatus: 'VERIFIED',
      configuredAdminPhone: '+5511999990000',
      verifiedPhone: '+5511999990000',
      verifiedPhones: [],
      verifiedRemoteJids: [],
      verifiedSenderJids: [],
      additionalAdminPhones: [],
    });
    expect(mod.isEnabled()).toBe(true);
  });
});
