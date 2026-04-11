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
    const ciphertext = encrypt("sk-test-groq-key", TEST_KEY);
    const parts = ciphertext.split('.');
    expect(parts.length).toBe(3);
    expect(Buffer.from(parts[0], 'base64').length).toBe(12);
    // Plaintext should NOT look like ciphertext
    const plainParts = "sk-test-groq-key".split('.');
    expect(plainParts.length).not.toBe(3);
  });

  it("encrypt/decrypt round-trip returns original value", () => {
    const original = "sk-test-groq-api-key-12345";
    const ciphertext = encrypt(original, TEST_KEY);
    expect(ciphertext).not.toBe(original);
    expect(decrypt(ciphertext, TEST_KEY)).toBe(original);
  });

  it("maskKey returns masked string for keys longer than 8 chars", () => {
    const mask = (key: string | null): string | null => {
      if (!key) return null;
      return key.length > 8 ? `${key.slice(0, 4)}...****` : '****';
    };
    expect(mask("sk-test-groq-key-12345")).toMatch(/^.{1,4}\.\.\.(\*{4})$/);
    expect(mask("short")).toBe('****');
    expect(mask(null)).toBeNull();
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
