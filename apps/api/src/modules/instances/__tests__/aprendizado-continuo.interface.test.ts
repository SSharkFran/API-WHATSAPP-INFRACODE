import { describe, it, expect } from "vitest";
import { DisabledAprendizadoContinuoModule, ActiveAprendizadoContinuoModule } from "../aprendizado-continuo.disabled.js";
import type { AprendizadoContinuoConfig } from "../aprendizado-continuo.interface.js";

const enabledConfig: AprendizadoContinuoConfig = {
  isEnabled: true,
  verificationStatus: "VERIFIED",
  configuredAdminPhone: "5511999990001",
  verifiedPhone: "5511999990001",
  verifiedPhones: ["5511999990002"],
  verifiedRemoteJids: ["5511999990001@s.whatsapp.net"],
  verifiedSenderJids: ["5511999990001@s.whatsapp.net"],
  additionalAdminPhones: ["5511999990003"]
};

describe("DisabledAprendizadoContinuoModule", () => {
  const disabled = new DisabledAprendizadoContinuoModule();

  it("isEnabled() returns false", () => {
    expect(disabled.isEnabled()).toBe(false);
  });

  it("getAdminPhones() returns []", () => {
    expect(disabled.getAdminPhones()).toEqual([]);
  });

  it("getAdminJids() returns []", () => {
    expect(disabled.getAdminJids()).toEqual([]);
  });

  it("processLearningReply() resolves to null", async () => {
    const result = await disabled.processLearningReply("t1", "i1", "answer");
    expect(result).toBeNull();
  });

  it("shouldSendDailySummary() returns false", () => {
    expect(disabled.shouldSendDailySummary("t1", "i1")).toBe(false);
  });

  it("buildDailySummary() resolves to empty string", async () => {
    const result = await disabled.buildDailySummary("t1", "i1");
    expect(result).toBe("");
  });

  it("getConfig() returns null", () => {
    expect(disabled.getConfig()).toBeNull();
  });
});

describe("ActiveAprendizadoContinuoModule", () => {
  it("isEnabled() returns true with enabled config", () => {
    const active = new ActiveAprendizadoContinuoModule(enabledConfig);
    expect(active.isEnabled()).toBe(true);
  });

  it("getAdminPhones() returns all verified phones when verified", () => {
    const active = new ActiveAprendizadoContinuoModule(enabledConfig);
    const phones = active.getAdminPhones();
    expect(phones).toContain("5511999990001");
    expect(phones).toContain("5511999990002");
    expect(phones).toContain("5511999990003");
  });

  it("getAdminJids() returns verified jids when verified", () => {
    const active = new ActiveAprendizadoContinuoModule(enabledConfig);
    const jids = active.getAdminJids();
    expect(jids).toContain("5511999990001@s.whatsapp.net");
  });

  it("isEnabled() returns false when config.isEnabled is false", () => {
    const disabledConfig: AprendizadoContinuoConfig = { ...enabledConfig, isEnabled: false };
    const active = new ActiveAprendizadoContinuoModule(disabledConfig);
    expect(active.isEnabled()).toBe(false);
  });
});
