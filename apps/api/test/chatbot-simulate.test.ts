import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("POST /instances/:id/chatbot/simulate", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("rejeita request sem autenticacao", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/instances/test-instance-id/chatbot/simulate",
      payload: { text: "ola", isFirstContact: false, phoneNumber: "5511999999999" }
    });
    // sem autenticacao retorna 401 (ENABLE_AUTH=true) ou 403 (sem contexto de tenant)
    expect([401, 403]).toContain(response.statusCode);
  });
});
