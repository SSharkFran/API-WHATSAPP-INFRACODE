import { describe, it, expect } from "vitest";
import {
  getAgendamentoAdminModuleConfig,
  buildOperationalModuleInstructions
} from "../src/modules/chatbot/module-runtime.js";

// Pure helper to test the [AGENDAR_ADMIN:{...}] marker parsing logic
// extracted from the regex used in chatbot service
const AGENDAR_ADMIN_REGEX = /\[AGENDAR_ADMIN:(\{[^[\]]*\})\]/i;

function parseAgendamentoMarker(text: string): { assunto: string; dataPreferencia: string; clientName: string } | null {
  const match = AGENDAR_ADMIN_REGEX.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { assunto?: string; dataPreferencia?: string; clientName?: string };
    if (!parsed.assunto?.trim() || !parsed.dataPreferencia?.trim()) return null;
    return { assunto: parsed.assunto.trim(), dataPreferencia: parsed.dataPreferencia.trim(), clientName: parsed.clientName?.trim() ?? "Cliente" };
  } catch {
    return null;
  }
}

describe("module-runtime: agendamentoAdmin", () => {
  it("getAgendamentoAdminModuleConfig retorna null quando modulo ausente", () => {
    expect(getAgendamentoAdminModuleConfig(undefined)).toBeNull();
    expect(getAgendamentoAdminModuleConfig({})).toBeNull();
  });

  it("getAgendamentoAdminModuleConfig retorna config com isEnabled=false quando desabilitado", () => {
    const result = getAgendamentoAdminModuleConfig({
      agendamentoAdmin: { isEnabled: false, clientPendingMessage: "ok", adminAlertTemplate: "ok" }
    });
    expect(result).not.toBeNull();
    expect(result?.isEnabled).toBe(false);
  });

  it("getAgendamentoAdminModuleConfig retorna config quando habilitado", () => {
    const result = getAgendamentoAdminModuleConfig({
      agendamentoAdmin: { isEnabled: true, clientPendingMessage: "Verificando...", adminAlertTemplate: "{{nome}} quer reuniao" }
    });
    expect(result).not.toBeNull();
    expect(result?.isEnabled).toBe(true);
    expect(result?.clientPendingMessage).toBe("Verificando...");
  });

  it("buildOperationalModuleInstructions inclui bloco AGENDAMENTO quando ativo e sem Google Calendar", () => {
    const instructions = buildOperationalModuleInstructions({
      agendamentoAdmin: { isEnabled: true, clientPendingMessage: "ok", adminAlertTemplate: "ok" }
    });
    const joined = instructions.join("\n");
    expect(joined).toContain("AGENDAMENTO VIA ADMIN");
    expect(joined).toContain("AGENDAR_ADMIN");
  });

  it("buildOperationalModuleInstructions omite bloco quando googleCalendar ativo", () => {
    const instructions = buildOperationalModuleInstructions({
      agendamentoAdmin: { isEnabled: true, clientPendingMessage: "ok", adminAlertTemplate: "ok" },
      googleCalendar: { isEnabled: true, clientId: "x", clientSecret: "x", refreshToken: "x", calendarId: "x" }
    });
    const joined = instructions.join("\n");
    expect(joined).not.toContain("AGENDAMENTO VIA ADMIN");
    expect(joined).toContain("GOOGLE CALENDAR");
  });
});

describe("AGENDAR_ADMIN marker parsing", () => {
  it("parseia marcador valido", () => {
    const text = '[AGENDAR_ADMIN:{"assunto":"criacao de site","dataPreferencia":"sexta à tarde","clientName":"Joao"}] Estou verificando!';
    const result = parseAgendamentoMarker(text);
    expect(result).not.toBeNull();
    expect(result?.assunto).toBe("criacao de site");
    expect(result?.dataPreferencia).toBe("sexta à tarde");
    expect(result?.clientName).toBe("Joao");
  });

  it("retorna null para marcador com JSON invalido", () => {
    const text = "[AGENDAR_ADMIN:{invalido}] ok";
    expect(parseAgendamentoMarker(text)).toBeNull();
  });

  it("retorna null quando assunto ou dataPreferencia ausente", () => {
    const text = '[AGENDAR_ADMIN:{"assunto":"site"}] ok';
    expect(parseAgendamentoMarker(text)).toBeNull();
  });

  it("retorna null quando texto nao contem marcador", () => {
    expect(parseAgendamentoMarker("Olá, como posso ajudar?")).toBeNull();
  });

  it("usa clientName padrao quando ausente", () => {
    const text = '[AGENDAR_ADMIN:{"assunto":"reuniao","dataPreferencia":"amanha"}] ok';
    const result = parseAgendamentoMarker(text);
    expect(result?.clientName).toBe("Cliente");
  });
});
