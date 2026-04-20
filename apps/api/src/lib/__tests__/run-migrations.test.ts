import { describe, it, expect, vi } from "vitest";
import { runMigrations, MIGRATIONS } from "../run-migrations.js";
import type pino from "pino";

// Create a compatible pino.Logger mock without importing the pino package at runtime.
// run-migrations.ts uses `import type pino` so the interface is compatible.
const makeLogger = (): pino.Logger => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  silent: vi.fn(),
  level: "silent",
  isLevelEnabled: vi.fn().mockReturnValue(false),
} as unknown as pino.Logger);

const noop = vi.fn().mockResolvedValue(undefined);

describe("runMigrations", () => {
  it("returns 'success' when all migrations applied without error", async () => {
    const logger = makeLogger();
    const db = {
      $executeRawUnsafe: noop,
      $queryRawUnsafe: vi.fn().mockResolvedValue([]) // no applied versions
    };
    const result = await runMigrations(db as never, "test-tenant", logger);
    expect(result).toBe("success");
  });

  it("returns 'skipped' when all migrations already applied", async () => {
    const logger = makeLogger();
    const allVersions = MIGRATIONS.map((m) => ({ version: m.version }));
    const db = {
      $executeRawUnsafe: noop,
      $queryRawUnsafe: vi.fn().mockResolvedValue(allVersions)
    };
    const result = await runMigrations(db as never, "test-tenant", logger);
    expect(result).toBe("skipped");
  });

  it("catches per-tenant error and returns 'failed' without throwing", async () => {
    // Must NOT propagate - API startup continues even if one tenant fails
    const logger = makeLogger();
    const db = {
      $executeRawUnsafe: vi.fn().mockRejectedValue(new Error("connection lost")),
      $queryRawUnsafe: vi.fn().mockResolvedValue([])
    };
    await expect(runMigrations(db as never, "bad-tenant", logger)).resolves.toBe("failed");
  });

  it("logs structured { tenantId, migration, error } at error level on failure", async () => {
    const logger = makeLogger();
    const db = {
      $executeRawUnsafe: vi.fn()
        .mockResolvedValueOnce(undefined) // CREATE TABLE schema_migrations — ok
        .mockRejectedValue(new Error("column exists")), // first migration fails
      $queryRawUnsafe: vi.fn().mockResolvedValue([])
    };
    await runMigrations(db as never, "bad-tenant", logger);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "bad-tenant", migration: expect.any(String) }),
      expect.any(String)
    );
  });

  it("applies only unapplied migrations (version tracking)", async () => {
    const logger = makeLogger();
    const executeRaw = vi.fn().mockResolvedValue(undefined);
    const firstVersion = MIGRATIONS[0]?.version;
    const db = {
      $executeRawUnsafe: executeRaw,
      $queryRawUnsafe: vi.fn().mockResolvedValue(
        firstVersion ? [{ version: firstVersion }] : []
      )
    };
    await runMigrations(db as never, "partial-tenant", logger);
    // CREATE TABLE call + (MIGRATIONS.length - 1) migrations applied + inserts
    const migrationApplyCalls = executeRaw.mock.calls.filter(
      (args: unknown[]) => {
        const sql = args[0] as string;
        return sql.includes("ADD COLUMN") ||
          sql.includes("CREATE INDEX") ||
          sql.includes("CREATE UNIQUE INDEX") ||
          sql.includes("ALTER COLUMN") ||
          sql.includes("DROP NOT NULL");
      }
    );
    expect(migrationApplyCalls.length).toBe(Math.max(0, MIGRATIONS.length - 1));
  });

  it("creates schema_migrations table if absent before reading applied versions", async () => {
    const logger = makeLogger();
    const executeRaw = vi.fn().mockResolvedValue(undefined);
    const queryRaw = vi.fn().mockResolvedValue([]);
    const db = { $executeRawUnsafe: executeRaw, $queryRawUnsafe: queryRaw };
    await runMigrations(db as never, "new-tenant", logger);
    // First executeRaw call must be the CREATE TABLE schema_migrations
    const firstCall: string = executeRaw.mock.calls[0]?.[0] ?? "";
    expect(firstCall).toContain("schema_migrations");
    expect(firstCall).toContain("CREATE TABLE IF NOT EXISTS");
  });
});
