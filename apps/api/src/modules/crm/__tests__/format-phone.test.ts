import { describe, it, expect } from "vitest";
import { formatPhone } from "../../../lib/format-phone";

// All test cases derived from 02-UI-SPEC.md formatPhone() Output Contract

describe("formatPhone", () => {
  it("formats BR 11-digit mobile: 5511987654321 to +55 11 98765-4321", () => {
    expect(formatPhone("5511987654321")).toBe("+55 11 98765-4321");
  });

  it("formats BR 11-digit with leading +: +5511987654321 to +55 11 98765-4321", () => {
    expect(formatPhone("+5511987654321")).toBe("+55 11 98765-4321");
  });

  it("formats BR 10-digit landline: 551198765432 to +55 11 9876-5432", () => {
    expect(formatPhone("551198765432")).toBe("+55 11 9876-5432");
  });

  it("returns E.164 as-is for non-BR international: +14155550199 to +14155550199", () => {
    expect(formatPhone("+14155550199")).toBe("+14155550199");
  });

  it("returns 'Aguardando número' for null input", () => {
    expect(formatPhone(null)).toBe("Aguardando número");
  });

  it("strips @c.us suffix before formatting: 5511987654321@c.us to +55 11 98765-4321", () => {
    expect(formatPhone("5511987654321@c.us")).toBe("+55 11 98765-4321");
  });

  it("returns 'Contato desconhecido' for non-numeric garbage after stripping", () => {
    expect(formatPhone("garbage!!$$")).toBe("Contato desconhecido");
  });

  it("never returns a string containing @lid", () => {
    const result = formatPhone("19383773@lid");
    expect(result).not.toContain("@lid");
    expect(result).not.toContain("19383773");
  });
});
