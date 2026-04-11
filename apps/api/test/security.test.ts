import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { encrypt, decrypt } from "../src/lib/crypto.js";
import { loadConfig } from "../src/config.js";

// SEC-01: CORS Allowlist
describe("SEC-01: CORS allowlist enforcement", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    delete process.env.ALLOWED_ORIGINS;
  });

  it("rejects cross-origin request from unlisted origin (no ACAO header)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://evil.com"
      }
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("accepts cross-origin request from allowlisted origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "http://localhost:3000"
      }
    });
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});

// SEC-02: Auth Bypass Guard
describe("SEC-02: Auth bypass restricted to development", () => {
  it("loadConfig() throws when ENABLE_AUTH is falsy and NODE_ENV is not development", () => {
    const original = { ...process.env };
    process.env.ENABLE_AUTH = "";
    process.env.NODE_ENV = "production";
    try {
      expect(() => loadConfig()).toThrow(/ENABLE_AUTH/);
    } finally {
      Object.assign(process.env, original);
    }
  });

  it("loadConfig() does not throw when ENABLE_AUTH is falsy and NODE_ENV is development", () => {
    const original = { ...process.env };
    process.env.ENABLE_AUTH = "";
    process.env.NODE_ENV = "development";
    try {
      expect(() => loadConfig()).not.toThrow();
    } finally {
      Object.assign(process.env, original);
    }
  });
});

// SEC-03: aiFallbackApiKey At-Rest Encryption
describe("SEC-03: aiFallbackApiKey encryption", () => {
  const TEST_KEY = "0123456789abcdef0123456789abcdef";

  it("isAlreadyEncrypted detects iv.tag.ciphertext format correctly", () => {
    expect.fail("not implemented — implement after Plan 1.3 encryption fix");
  });

  it("encrypt/decrypt round-trip returns original value", () => {
    expect.fail("not implemented — implement after Plan 1.3 encryption fix");
  });

  it("GET /instances/:id/chatbot-config masks aiFallbackApiKey in response", async () => {
    expect.fail("not implemented — implement after Plan 1.3 encryption fix");
  });
});

// SEC-04: Session Files and Query-String Tokens
describe("SEC-04: DATA_DIR assertion and query-string token removal", () => {
  it("startup fails fatally when DATA_DIR resolves inside project root", () => {
    expect.fail("not implemented — implement after Plan 1.4 startup assertion");
  });

  it("HTTP request with ?accessToken= query param is rejected with 401", async () => {
    expect.fail("not implemented — implement after Plan 1.4 query-string removal");
  });
});
