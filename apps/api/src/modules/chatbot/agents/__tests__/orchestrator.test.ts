/**
 * Unit tests for OrchestratorAgent fallback chain (IA-03, IA-05).
 *
 * These tests verify that:
 * - process() returns string when a specialized agent throws → GeneralAgent catches
 * - process() returns null (never undefined) when GeneralAgent also throws
 * - process() never returns undefined under any combination of success/failure
 * - process() falls back to GENERAL intent when IntentRouter throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrchestratorAgent } from "../orchestrator.agent.js";
import type { AgentContext } from "../types.js";

// ---------------------------------------------------------------------------
// Minimal AgentContext factory
// ---------------------------------------------------------------------------

function makeCtx(callAiImpl?: (system: string, messages: unknown[]) => Promise<string | null>): AgentContext {
  return {
    tenantId: "tenant-1",
    instanceId: "inst-1",
    isFirstContact: false,
    history: [{ role: "user", content: "test message" }],
    blocks: {
      globalSystemPrompt: "You are a helpful assistant.",
      baseSystemPrompt: "Base prompt.",
      memoryMd: "",
      clientContext: "",
      knowledge: "",
      servicesAndPrices: "",
      persistentMemory: "",
      phoneNumber: "5511999999999",
      currentDateLine: "Today is 2026-04-16.",
    },
    modules: undefined,
    allowAdminEscalation: false,
    callAi: callAiImpl ?? vi.fn().mockResolvedValue("Generic AI response"),
  } as AgentContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrchestratorAgent fallback chain (IA-03, IA-05)", () => {
  let agent: OrchestratorAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new OrchestratorAgent();
  });

  it("Test 1: FaqAgent throws → GeneralAgent is called → returns string (not undefined)", async () => {
    // Force IntentRouter to return FAQ intent
    vi.spyOn(agent["intentRouter"], "classify").mockResolvedValue({ intent: "FAQ", confidence: 0.9 });
    // Force FaqAgent to throw
    vi.spyOn(agent["faqAgent"], "respond").mockRejectedValue(new Error("faq failed"));
    // Force GeneralAgent to return a response
    vi.spyOn(agent["generalAgent"], "respond").mockResolvedValue("Fallback response from GeneralAgent");

    const result = await agent.process(makeCtx());

    expect(result).toBe("Fallback response from GeneralAgent");
    expect(typeof result).toBe("string");
  });

  it("Test 2: SchedulingAgent throws → GeneralAgent is called → returns string", async () => {
    vi.spyOn(agent["intentRouter"], "classify").mockResolvedValue({ intent: "SCHEDULE", confidence: 0.9 });
    vi.spyOn(agent["schedulingAgent"], "respond").mockRejectedValue(new Error("scheduling failed"));
    vi.spyOn(agent["generalAgent"], "respond").mockResolvedValue("Handled by GeneralAgent");

    const result = await agent.process(makeCtx());

    expect(result).toBe("Handled by GeneralAgent");
    expect(typeof result).toBe("string");
  });

  it("Test 3: GeneralAgent also throws → returns null (not undefined, not re-throw)", async () => {
    // Force all agents to fail: route to GENERAL, then GeneralAgent throws
    vi.spyOn(agent["intentRouter"], "classify").mockResolvedValue({ intent: "GENERAL", confidence: 0.5 });
    vi.spyOn(agent["generalAgent"], "respond").mockRejectedValue(new Error("all agents failed"));

    const result = await agent.process(makeCtx());

    expect(result).toBeNull(); // IA-03: never return undefined — null signals "no response available"
    expect(result).not.toBeUndefined();
  });

  it("Test 4: IntentRouter throws → falls back to GENERAL → GeneralAgent returns string", async () => {
    vi.spyOn(agent["intentRouter"], "classify").mockRejectedValue(new Error("router failed"));
    vi.spyOn(agent["generalAgent"], "respond").mockResolvedValue("General fallback after router failure");

    const result = await agent.process(makeCtx());

    expect(result).toBe("General fallback after router failure");
    expect(typeof result).toBe("string");
  });

  it("Test 5: process() never returns undefined — return type is always string | null", async () => {
    // Test happy path: callAi returns null → GeneralAgent likely returns null or string
    const ctx = makeCtx(vi.fn().mockResolvedValue(null));
    const result = await agent.process(ctx);

    // The contract: result must be string | null, never undefined
    expect(result === null || typeof result === "string").toBe(true);
    expect(result).not.toBeUndefined();
  });

  it("Test 6: process() with EscalationAgent throwing → GeneralAgent catches → returns string", async () => {
    vi.spyOn(agent["intentRouter"], "classify").mockResolvedValue({ intent: "ESCALATE", confidence: 0.8 });
    vi.spyOn(agent["escalationAgent"], "respond").mockRejectedValue(new Error("escalation failed"));
    vi.spyOn(agent["generalAgent"], "respond").mockResolvedValue("General escalation fallback");

    const result = await agent.process(makeCtx());

    expect(result).toBe("General escalation fallback");
  });
});
