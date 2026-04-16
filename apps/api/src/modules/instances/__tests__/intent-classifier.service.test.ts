import { describe, it, expect, vi } from "vitest";
import { classifyIntent, VALID_INTENT_LABELS } from "../../../lib/intent-classifier.service.js";
import type { AiCaller } from "../../chatbot/agents/types.js";

function makeCallAi(response: string | null): AiCaller {
  return vi.fn().mockResolvedValue(response);
}

function makeThrowingCallAi(): AiCaller {
  return vi.fn().mockRejectedValue(new Error("network error"));
}

describe("classifyIntent", () => {
  it("Test 1: classifies ENCERRAMENTO with high confidence", async () => {
    const callAi = makeCallAi('{"label":"ENCERRAMENTO","confidence":0.92}');
    const result = await classifyIntent("era só isso, muito obrigado", callAi);
    expect(result.label).toBe("ENCERRAMENTO");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("Test 2: classifies TRANSFERENCIA_HUMANO with high confidence", async () => {
    const callAi = makeCallAi('{"label":"TRANSFERENCIA_HUMANO","confidence":0.95}');
    const result = await classifyIntent("quero falar com um humano", callAi);
    expect(result.label).toBe("TRANSFERENCIA_HUMANO");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("Test 3: classifies PERGUNTA with confidence >= 0.5", async () => {
    const callAi = makeCallAi('{"label":"PERGUNTA","confidence":0.85}');
    const result = await classifyIntent("qual o horário de funcionamento?", callAi);
    expect(result.label).toBe("PERGUNTA");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("Test 4: callAi returns null (LLM failure) → { label: 'OUTRO', confidence: 0.5 } — never throws", async () => {
    const callAi = makeCallAi(null);
    const result = await classifyIntent("qualquer texto", callAi);
    expect(result).toEqual({ label: "OUTRO", confidence: 0.5 });
  });

  it("Test 5: callAi throws an error → { label: 'OUTRO', confidence: 0.5 } — never throws", async () => {
    const callAi = makeThrowingCallAi();
    const result = await classifyIntent("qualquer texto", callAi);
    expect(result).toEqual({ label: "OUTRO", confidence: 0.5 });
  });

  it("Test 6: LLM returns label 'INVALID_LABEL' not in VALID_INTENT_LABELS → { label: 'OUTRO', confidence: 0.5 }", async () => {
    const callAi = makeCallAi('{"label":"INVALID_LABEL","confidence":0.9}');
    const result = await classifyIntent("qualquer texto", callAi);
    expect(result).toEqual({ label: "OUTRO", confidence: 0.5 });
  });

  it('Test 7: LLM returns raw string "ENCERRAMENTO" (no JSON) → { label: \'OUTRO\', confidence: 0.5 }', async () => {
    const callAi = makeCallAi("ENCERRAMENTO");
    const result = await classifyIntent("qualquer texto", callAi);
    expect(result).toEqual({ label: "OUTRO", confidence: 0.5 });
  });

  it("VALID_INTENT_LABELS contains expected labels", () => {
    expect(VALID_INTENT_LABELS).toContain("ENCERRAMENTO");
    expect(VALID_INTENT_LABELS).toContain("URGENCIA_ALTA");
    expect(VALID_INTENT_LABELS).toContain("TRANSFERENCIA_HUMANO");
    expect(VALID_INTENT_LABELS).toContain("PERGUNTA");
    expect(VALID_INTENT_LABELS).toContain("CONTINUACAO");
    expect(VALID_INTENT_LABELS).toContain("OUTRO");
  });
});
