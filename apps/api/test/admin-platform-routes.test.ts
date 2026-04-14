/**
 * ADM-04: Integration tests — super-admin API route guard enforcement.
 *
 * Verifies that every /admin/* route returns 401 or 403 for unauthorized
 * requests. The goal is to confirm that unauthorized access is blocked,
 * not that authorized access works (no PLATFORM_OWNER token is used here).
 *
 * Routes tested:
 *   GET /admin/tenants
 *   GET /admin/billing
 *   GET /admin/settings
 *   GET /admin/health
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { buildApp } from "../src/app.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? "change-me";

/** Signs a minimal JWT with the test secret. */
const signJwt = async (payload: Record<string, unknown>): Promise<string> =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(JWT_SECRET));

// ── ADM-04: No auth token (Test 1 & 2) ───────────────────────────────────

describe("ADM-04: Super-admin routes reject unauthenticated requests", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("Test 1 — GET /admin/tenants without auth token returns 401 or 403", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/tenants"
      // No Authorization header
    });

    expect([401, 403]).toContain(response.statusCode);
  });

  it("Test 2 — GET /admin/health without auth token returns 401 or 403", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/health"
      // No Authorization header
    });

    expect([401, 403]).toContain(response.statusCode);
  });
});

// ── ADM-04: JWT without PLATFORM_OWNER role (Test 3 & 4) ──────────────────

describe("ADM-04: Super-admin routes reject non-platform JWT tokens", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  // We mock the prisma user lookup so the token passes JWT validation but
  // hits the platformRole check (platformRole is null → 403).
  const mockFindUnique = vi.fn();

  beforeAll(async () => {
    // Return a user with no platform role to trigger the 403 branch in auth.ts:
    // "if (!isPlatformRole(user.platformRole)) throw new ApiError(403, ...)"
    mockFindUnique.mockResolvedValue({
      id: "regular-user-id",
      isActive: true,
      platformRole: null // NOT a platform role
    });

    app = await buildApp();

    // Override the platformPrisma.user.findUnique method after app is built
    (app as unknown as { platformPrisma: { user: { findUnique: typeof mockFindUnique } } })
      .platformPrisma.user.findUnique = mockFindUnique;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    vi.restoreAllMocks();
  });

  it("Test 3 — GET /admin/tenants with non-platform JWT returns 403", async () => {
    // Sign a JWT referencing the mock user (no platformRole in payload)
    const token = await signJwt({
      actorId: "regular-user-id",
      actorType: "PLATFORM_USER"
      // No platformRole field → forces DB-level check
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/tenants",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    // Auth plugin sees platformRole = null → 403 PLATFORM_ACCESS_DENIED
    expect(response.statusCode).toBe(403);
  });

  it("Test 4 — GET /admin/health with non-platform JWT returns 403", async () => {
    const token = await signJwt({
      actorId: "regular-user-id",
      actorType: "PLATFORM_USER"
      // No platformRole field
    });

    const response = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.statusCode).toBe(403);
  });
});

// ── ADM-04: Additional coverage for billing and settings ─────────────────

describe("ADM-04: Billing and settings routes also enforce auth", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("GET /admin/billing without auth token returns 401 or 403", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/billing"
    });

    expect([401, 403]).toContain(response.statusCode);
  });

  it("GET /admin/settings without auth token returns 401 or 403", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/settings"
    });

    expect([401, 403]).toContain(response.statusCode);
  });
});
