import type { IAprendizadoContinuoModule, AprendizadoContinuoConfig } from './aprendizado-continuo.interface.js';

export class DisabledAprendizadoContinuoModule implements IAprendizadoContinuoModule {
  isEnabled(): boolean { return false; }
  isVerified(): boolean { return false; }
  getAdminPhones(): string[] { return []; }
  getAdminJids(): string[] { return []; }
  async processLearningReply(): Promise<null> { return null; }
  shouldSendDailySummary(): boolean { return false; }
  async buildDailySummary(): Promise<string> { return ''; }
  getConfig(): null { return null; }
}

export class ActiveAprendizadoContinuoModule implements IAprendizadoContinuoModule {
  constructor(private readonly cfg: AprendizadoContinuoConfig) {}

  isEnabled(): boolean { return this.cfg.isEnabled; }

  isVerified(): boolean {
    return this.cfg.isEnabled && this.cfg.verificationStatus === 'VERIFIED';
  }

  getAdminPhones(): string[] {
    if (!this.isVerified()) return [];
    return [
      this.cfg.configuredAdminPhone,
      this.cfg.verifiedPhone,
      ...this.cfg.verifiedPhones,
      ...(this.cfg.additionalAdminPhones ?? []),
    ].filter((p): p is string => p != null);
  }

  getAdminJids(): string[] {
    if (!this.isVerified()) return [];
    return [
      ...this.cfg.verifiedRemoteJids,
      ...this.cfg.verifiedSenderJids,
    ].filter(Boolean);
  }

  async processLearningReply(): Promise<null> {
    // Real implementation delegated to EscalationService (called by handleInboundMessage callers).
    // This method is a routing hook only — the actual save logic lives in EscalationService.
    return null;
  }

  shouldSendDailySummary(): boolean { return this.cfg.isEnabled; }

  async buildDailySummary(): Promise<string> { return ''; }

  getConfig(): AprendizadoContinuoConfig { return this.cfg; }
}
