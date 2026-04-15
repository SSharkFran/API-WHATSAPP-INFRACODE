import { randomUUID } from "node:crypto";
import type pino from "pino";
import type { Redis as IORedis } from "ioredis";
import type { TenantPrismaRegistry } from "../../lib/database.js";
import { SessionStatus } from "./conversation-session-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// T-04-02-01: only valid WhatsApp JID formats are accepted as Redis key components
const VALID_JID_PATTERN = /^[^:@]+@(s\.whatsapp\.net|g\.us)$/;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SessionStateServiceDeps {
  redis: IORedis;
  tenantPrismaRegistry: TenantPrismaRegistry;
  logger: pino.Logger;
}

export interface SessionOpenParams {
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  conversationId?: string | null;
}

export interface SessionCloseParams {
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  closedReason: string;
}

export interface SessionHashState {
  status: SessionStatus;
  humanTakeover: boolean;
  startedAt: string | null;
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// SessionStateService
// ---------------------------------------------------------------------------

export class SessionStateService {
  private readonly logger: pino.Logger;

  constructor(private readonly deps: SessionStateServiceDeps) {
    this.logger = deps.logger.child({ component: "SessionStateService" });
  }

  // ---------------------------------------------------------------------------
  // Key building (T-04-02-01: validate remoteJid to prevent key injection)
  // ---------------------------------------------------------------------------

  private redisKey(tenantId: string, instanceId: string, remoteJid: string): string {
    if (!VALID_JID_PATTERN.test(remoteJid)) {
      throw new Error(
        `[SessionStateService] Invalid remoteJid format: "${remoteJid}". Must end in @s.whatsapp.net or @g.us`
      );
    }
    return `session:${tenantId}:${instanceId}:${remoteJid}`;
  }

  // ---------------------------------------------------------------------------
  // openSession — creates Redis hash (fast state) + ConversationSession row (durable)
  // ---------------------------------------------------------------------------

  async openSession(params: SessionOpenParams): Promise<string> {
    const { tenantId, instanceId, remoteJid, conversationId } = params;
    const sessionId = randomUUID();
    const key = this.redisKey(tenantId, instanceId, remoteJid);
    const now = new Date();

    // Write Redis hash (fast state)
    // T-04-02-02: humanTakeover is NEVER set here — only via setHumanTakeover()
    await this.deps.redis.hset(key, {
      status: SessionStatus.ATIVA,
      humanTakeover: "0",
      startedAt: now.toISOString(),
      sessionId,
    });
    await this.deps.redis.expire(key, SESSION_TTL_SECONDS);

    // Insert ConversationSession row (durable record)
    const prisma = await this.deps.tenantPrismaRegistry.getClient(tenantId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ConversationSession"
         ("id", "instanceId", "remoteJid", "status", "startedAt", "conversationId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT ("id") DO NOTHING`,
      sessionId,
      instanceId,
      remoteJid,
      SessionStatus.ATIVA,
      now,
      conversationId ?? null
    );

    this.logger.info({ sessionId, instanceId, remoteJid }, "[session] opened");
    return sessionId;
  }

  // ---------------------------------------------------------------------------
  // getSessionState — fast-path read from Redis hash
  // ---------------------------------------------------------------------------

  async getSessionState(
    tenantId: string,
    instanceId: string,
    remoteJid: string
  ): Promise<SessionHashState | null> {
    const key = this.redisKey(tenantId, instanceId, remoteJid);
    const hash = await this.deps.redis.hgetall(key);

    // T-04-02-03: empty hash (expired TTL) → return null (safe default)
    if (!hash || !hash.status) return null;

    return {
      status: hash.status as SessionStatus,
      humanTakeover: hash.humanTakeover === "1",
      startedAt: hash.startedAt ?? null,
      sessionId: hash.sessionId ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // isHumanTakeover — SESS-07 fast-path check via HGET (no full HGETALL needed)
  // ---------------------------------------------------------------------------

  async isHumanTakeover(
    tenantId: string,
    instanceId: string,
    remoteJid: string
  ): Promise<boolean> {
    const key = this.redisKey(tenantId, instanceId, remoteJid);
    const value = await this.deps.redis.hget(key, "humanTakeover");
    // T-04-02-03: null (missing key) → false (safe default, never block on missing state)
    return value === "1";
  }

  // ---------------------------------------------------------------------------
  // updateStatus — updates status field in Redis hash + extends TTL
  // T-04-02-02: this method NEVER writes humanTakeover
  // ---------------------------------------------------------------------------

  async updateStatus(
    tenantId: string,
    instanceId: string,
    remoteJid: string,
    status: SessionStatus
  ): Promise<void> {
    const key = this.redisKey(tenantId, instanceId, remoteJid);
    await this.deps.redis.hset(key, { status });
    await this.deps.redis.expire(key, SESSION_TTL_SECONDS);
    this.logger.debug({ instanceId, remoteJid, status }, "[session] status updated");
  }

  // ---------------------------------------------------------------------------
  // setHumanTakeover — T-04-02-02: ONLY this dedicated method may write '1'
  // Callers MUST gate this behind an admin identity check before calling
  // ---------------------------------------------------------------------------

  async setHumanTakeover(
    tenantId: string,
    instanceId: string,
    remoteJid: string,
    value: boolean
  ): Promise<void> {
    const key = this.redisKey(tenantId, instanceId, remoteJid);
    await this.deps.redis.hset(key, { humanTakeover: value ? "1" : "0" });
    await this.deps.redis.expire(key, SESSION_TTL_SECONDS);
    this.logger.info({ instanceId, remoteJid, humanTakeover: value }, "[session] humanTakeover updated");
  }

  // ---------------------------------------------------------------------------
  // closeSession — writes endedAt + durationSeconds to PG; updates Redis status
  // ---------------------------------------------------------------------------

  async closeSession(params: SessionCloseParams): Promise<void> {
    const { tenantId, instanceId, remoteJid, closedReason } = params;
    const key = this.redisKey(tenantId, instanceId, remoteJid);

    // Read current state from Redis to get sessionId and startedAt
    const hash = await this.deps.redis.hgetall(key);
    const sessionId = hash?.sessionId ?? null;
    const startedAt = hash?.startedAt ? new Date(hash.startedAt) : null;
    const endedAt = new Date();
    const durationSeconds =
      startedAt ? Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000) : null;

    const finalStatus =
      closedReason === "timeout_no_response" ? SessionStatus.INATIVA : SessionStatus.ENCERRADA;

    // Update Redis status
    await this.deps.redis.hset(key, { status: finalStatus });

    // Update PostgreSQL record
    if (sessionId) {
      const prisma = await this.deps.tenantPrismaRegistry.getClient(tenantId);
      await prisma.$executeRawUnsafe(
        `UPDATE "ConversationSession"
         SET "endedAt" = $1, "durationSeconds" = $2, "closedReason" = $3, "status" = $4, "updatedAt" = NOW()
         WHERE "id" = $5`,
        endedAt,
        durationSeconds,
        closedReason,
        finalStatus,
        sessionId
      );
    }

    this.logger.info(
      { sessionId, instanceId, remoteJid, closedReason, durationSeconds },
      "[session] closed"
    );
  }
}
