/**
 * IAprendizadoContinuoModule — Null Object interface (APR-01).
 * All consumers call this interface. DisabledAprendizadoContinuoModule
 * returns safe no-op defaults. No caller may check module?.isEnabled directly.
 */
export interface IAprendizadoContinuoModule {
  isEnabled(): boolean;
  isVerified(): boolean;
  getAdminPhones(): string[];
  getAdminJids(): string[];
  processLearningReply(
    tenantId: string,
    instanceId: string,
    adminRawAnswer: string,
    targetConversationId?: string | null
  ): Promise<unknown>;
  shouldSendDailySummary(tenantId: string, instanceId: string): boolean;
  buildDailySummary(tenantId: string, instanceId: string): Promise<string>;
  /** Returns the raw config object for callers that need full shape (e.g., AdminIdentityInput wiring) */
  getConfig(): AprendizadoContinuoConfig | null;
}

export interface AprendizadoContinuoConfig {
  isEnabled: boolean;
  verificationStatus: "UNVERIFIED" | "PENDING" | "VERIFIED";
  configuredAdminPhone?: string | null;
  verifiedPhone: string | null;
  verifiedPhones: string[];
  verifiedRemoteJids: string[];
  verifiedSenderJids: string[];
  additionalAdminPhones: string[];
}
