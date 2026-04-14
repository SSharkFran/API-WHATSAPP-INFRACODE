import { describe, it, expect } from "vitest";
import { AdminIdentityService } from "../admin-identity.service.js";
import type { AdminIdentityInput } from "../admin-identity.service.js";

function buildInput(overrides: Partial<AdminIdentityInput> = {}): AdminIdentityInput {
  return {
    remoteJid: "unknown@s.whatsapp.net",
    senderJid: undefined,
    fromMe: false,
    rawTextInput: "",
    adminCandidatePhones: [],
    aprendizadoContinuoModule: null,
    instanceOwnPhone: null,
    contactPhoneNumber: null,
    sharedPhoneJid: null,
    lastRemoteJid: null,
    escalationConversationId: null,
    senderNumber: null,
    remoteChatNumber: null,
    resolvedContactNumber: null,
    remoteNumber: null,
    realPhoneFromRemoteJid: null,
    cleanPhoneFromRemoteJid: "",
    sharedPhoneNumberFromFields: null,
    lastRemoteNumber: null,
    ...overrides
  };
}

describe("AdminIdentityService", () => {
  const service = new AdminIdentityService();

  describe("Scenario 1 — Admin phone matches (ADM-01)", () => {
    it("detects admin when remoteJid matches adminCandidatePhones", () => {
      const input = buildInput({
        remoteJid: "5511999990001@s.whatsapp.net",
        adminCandidatePhones: ["5511999990001"],
        aprendizadoContinuoModule: null,
        fromMe: false,
        remoteChatNumber: "5511999990001"
      });

      const ctx = service.resolve(input);

      expect(ctx.isAdmin).toBe(true);
      expect(ctx.matchedAdminPhone).toBe("5511999990001");
      expect(ctx.isVerifiedAdmin).toBe(false);
    });
  });

  describe("Scenario 2 — Module disabled still detects admin (ADM-02)", () => {
    it("detects admin when aprendizadoContinuoModule is null (module not enabled)", () => {
      const input = buildInput({
        remoteJid: "5511999990002@s.whatsapp.net",
        adminCandidatePhones: ["5511999990002"],
        aprendizadoContinuoModule: null,
        fromMe: false,
        remoteChatNumber: "5511999990002"
      });

      const ctx = service.resolve(input);

      expect(ctx.isAdmin).toBe(true);
    });

    it("detects admin when aprendizadoContinuoModule is disabled (isEnabled=false)", () => {
      const input = buildInput({
        remoteJid: "5511999990002@s.whatsapp.net",
        adminCandidatePhones: ["5511999990002"],
        aprendizadoContinuoModule: {
          isEnabled: false,
          verificationStatus: "PENDING",
          configuredAdminPhone: null,
          verifiedPhone: null,
          verifiedPhones: [],
          additionalAdminPhones: null,
          verifiedRemoteJids: [],
          verifiedSenderJids: []
        },
        fromMe: false,
        remoteChatNumber: "5511999990002"
      });

      const ctx = service.resolve(input);

      expect(ctx.isAdmin).toBe(true);
    });
  });

  describe("Scenario 3 — fromMe echo is NOT verified admin (ADM-01, Pitfall D)", () => {
    it("fromMe=true does not produce isVerifiedAdmin=true even when phone matches", () => {
      const input = buildInput({
        remoteJid: "5511999990001@s.whatsapp.net",
        adminCandidatePhones: ["5511999990001"],
        aprendizadoContinuoModule: {
          isEnabled: true,
          verificationStatus: "VERIFIED",
          configuredAdminPhone: "5511999990001",
          verifiedPhone: "5511999990001",
          verifiedPhones: ["5511999990001"],
          additionalAdminPhones: null,
          verifiedRemoteJids: [],
          verifiedSenderJids: []
        },
        fromMe: true,
        remoteChatNumber: "5511999990001"
      });

      const ctx = service.resolve(input);

      expect(ctx.isVerifiedAdmin).toBe(false);
    });
  });

  describe("Scenario 4 — LID-form JID placeholder (ADM-03)", () => {
    it("@lid JID does not match phone candidates without cachedAdminJid (no false positive)", () => {
      const input = buildInput({
        remoteJid: "abc123@lid",
        adminCandidatePhones: ["5511999990003"],
        aprendizadoContinuoModule: null,
        escalationConversationId: null,
        fromMe: false,
        // No phone candidates available — all null
        senderNumber: null,
        remoteChatNumber: null,
        resolvedContactNumber: null,
        remoteNumber: null,
        realPhoneFromRemoteJid: null,
        cleanPhoneFromRemoteJid: "",
        sharedPhoneNumberFromFields: null,
        lastRemoteNumber: null
      });

      const ctx = service.resolve(input);

      expect(ctx.isAdmin).toBe(false);
    });

    it("@lid JID resolves admin via Redis-cached JID (ADM-03 fix)", () => {
      const input = buildInput({
        remoteJid: "abc123@lid",
        adminCandidatePhones: ["5511999990003"],
        aprendizadoContinuoModule: null,
        escalationConversationId: null,
        fromMe: false,
        cachedAdminJid: "abc123@lid",
        // No phone candidates available — all null
        senderNumber: null,
        remoteChatNumber: null,
        resolvedContactNumber: null,
        remoteNumber: null,
        realPhoneFromRemoteJid: null,
        cleanPhoneFromRemoteJid: "",
        sharedPhoneNumberFromFields: null,
        lastRemoteNumber: null
      });

      const ctx = service.resolve(input);

      expect(ctx.isAdmin).toBe(true);
      expect(ctx.matchedAdminPhone).toBe("5511999990003");
    });
  });
});
