import { describe, it, expect } from "vitest";

// TODO: uncomment after Plan 2.2 creates the module
// import { formatPhone } from "../../../lib/format-phone";

// All test cases derived from 02-UI-SPEC.md formatPhone() Output Contract

describe("formatPhone", () => {
  it("formats BR 11-digit mobile: 5511987654321 to +55 11 98765-4321", () => {
    expect(true).toBe(false); // RED stub
  });

  it("formats BR 11-digit with leading +: +5511987654321 to +55 11 98765-4321", () => {
    expect(true).toBe(false); // RED stub
  });

  it("formats BR 10-digit landline: 551198765432 to +55 11 9876-5432", () => {
    expect(true).toBe(false); // RED stub
  });

  it("returns E.164 as-is for non-BR international: +14155550199 to +14155550199", () => {
    expect(true).toBe(false); // RED stub
  });

  it("returns 'Aguardando número' for null input", () => {
    expect(true).toBe(false); // RED stub
  });

  it("strips @c.us suffix before formatting: 5511987654321@c.us to +55 11 98765-4321", () => {
    expect(true).toBe(false); // RED stub
  });

  it("returns 'Contato desconhecido' for non-numeric garbage after stripping", () => {
    expect(true).toBe(false); // RED stub
  });

  it("never returns a string containing @lid", () => {
    expect(true).toBe(false); // RED stub
  });
});
