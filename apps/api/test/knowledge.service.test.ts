import { describe, expect, it } from "vitest";

import {
  isPhoneBlockedByBlacklist,
  isPhoneAllowedByListaBranca,
  matchesPauseWord,
  sanitizeChatbotModules,
} from "../src/modules/chatbot/module-runtime.js";

describe("module-runtime: blacklist", () => {
  it("bloqueia numero na blacklist", () => {
    const modules = sanitizeChatbotModules({
      blacklist: { isEnabled: true, numeros: ["5511999999999"] }
    });
    expect(isPhoneBlockedByBlacklist(modules, "5511999999999")).toBe(true);
  });

  it("nao bloqueia numero fora da blacklist", () => {
    const modules = sanitizeChatbotModules({
      blacklist: { isEnabled: true, numeros: ["5511999999999"] }
    });
    expect(isPhoneBlockedByBlacklist(modules, "5511888888888")).toBe(false);
  });

  it("nao bloqueia quando modulo desativado", () => {
    const modules = sanitizeChatbotModules({
      blacklist: { isEnabled: false, numeros: ["5511999999999"] }
    });
    expect(isPhoneBlockedByBlacklist(modules, "5511999999999")).toBe(false);
  });
});

describe("module-runtime: lista branca", () => {
  it("bloqueia numero fora da lista branca", () => {
    const modules = sanitizeChatbotModules({
      listaBranca: { isEnabled: true, numeros: ["5511111111111"], modo: "permitir_lista" }
    });
    expect(isPhoneAllowedByListaBranca(modules, "5511999999999")).toBe(false);
  });

  it("permite numero na lista branca", () => {
    const modules = sanitizeChatbotModules({
      listaBranca: { isEnabled: true, numeros: ["5511999999999"], modo: "permitir_lista" }
    });
    expect(isPhoneAllowedByListaBranca(modules, "5511999999999")).toBe(true);
  });

  it("permite qualquer numero quando modulo desativado", () => {
    const modules = sanitizeChatbotModules({
      listaBranca: { isEnabled: false, numeros: [], modo: "permitir_lista" }
    });
    expect(isPhoneAllowedByListaBranca(modules, "5511999999999")).toBe(true);
  });
});

describe("module-runtime: palavra de pausa", () => {
  it("detecta palavra de pausa (includes)", () => {
    const modules = sanitizeChatbotModules({
      palavraPausa: { isEnabled: true, palavras: ["humano", "atendente"] }
    });
    const result = matchesPauseWord(modules, "preciso falar com um humano agora");
    expect(result.matched).toBe(true);
  });

  it("nao detecta quando palavra nao esta presente", () => {
    const modules = sanitizeChatbotModules({
      palavraPausa: { isEnabled: true, palavras: ["humano"] }
    });
    const result = matchesPauseWord(modules, "qual o preco do produto");
    expect(result.matched).toBe(false);
  });
});
