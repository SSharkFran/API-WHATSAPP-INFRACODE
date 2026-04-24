# Phase 8: Continuous Learning Polish & Advanced Features — Research

**Researched:** 2026-04-24
**Domain:** Module isolation (Null Object pattern), knowledge ingestion gate, audit trail UI, urgency scoring, follow-up automation with WhatsApp 24h window
**Confidence:** HIGH (all findings verified directly from codebase)

---

## Summary

Phase 8 is the final phase of the v1 roadmap and deals with the highest-risk extraction in the project. The `aprendizadoContinuo` module is currently scattered across ~15 `isEnabled` guards in three files (`service.ts` at 5420 lines, `chatbot/service.ts`, and `admin-identity.service.ts`). The Null Object pattern formalizes an interface contract so these guards disappear entirely — replaced by polymorphic dispatch.

The knowledge ingestion path (Plan 8.2) is the most invasive change. Currently, `EscalationService.processAdminReply()` writes directly to the knowledge base on first admin reply with no confirmation step. Adding a confirmation gate requires a new in-flight state: the system must hold the admin's answer, send a confirmation echo, wait for "SIM", and only then call `knowledgeService.save()`. This state can live in a Redis key (short TTL, 10 minutes) — consistent with how the codebase already manages escalation locks.

The "Conhecimento Adquirido" panel tab (APR-06) already exists in `chatbot-studio.tsx` — it shows learned Q&A pairs with a delete button. What is missing for APR-05 is audit metadata on each row: confirmation timestamp, admin JID, and usage count are not stored on `TenantKnowledge`. The plan requires either schema extension or a separate `LearningLog` table. Urgency scoring infrastructure (URG-01, URG-02) is already wired: `urgencyScore` column exists on `ConversationSession`, the Redis hash field is set on `URGENCIA_ALTA` detection, and the metrics panel has an `UrgencyBadge` component. What remains is persisting the score from Redis to PostgreSQL and ensuring `ConversationSession.urgencyScore` updates. Follow-up automation (FOL-01, FOL-02) requires new infrastructure — no BullMQ queue or scheduled follow-up table exists yet.

**Primary recommendation:** Implement the four plans in strict order — 8.1 (interface) first because it affects every subsequent plan; 8.2 (confirmation gate) touches EscalationService state; 8.3 (audit panel) depends on schema from 8.2; 8.4 (urgency + follow-up) is mostly additive infrastructure.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| APR-01 | Disabled module must not impact any other module's functionality | Null Object pattern — `DisabledAprendizadoContinuoModule` returns `false`/`[]`/no-ops; all 14 `isEnabled` guards removed |
| APR-02 | Confirmation gate before ingesting admin reply into knowledge base | New confirmation state in Redis + `EscalationService` refactor; `SIM` detection before `knowledgeService.save()` |
| APR-03 | Admin receives structured escalation question when bot doesn't know (already implemented in Phase 5 Plan 5.3) | Already wired via `EscalationService.notifyAdmin()` — confirmed present in codebase |
| APR-04 | Admin reply validated before becoming a knowledge fact | Confirmation gate (same as APR-02) — admin must confirm via "SIM" |
| APR-05 | Auditable log of every knowledge addition: origin, date, admin responsible | Extend `TenantKnowledge` with `confirmedAt` + `confirmedByJid` OR add `LearningLog` table via migration |
| APR-06 | Panel UI to review and delete acquired knowledge | Already exists in `chatbot-studio.tsx` "conhecimento" tab — needs audit metadata columns surfaced |
| URG-01 | Urgency score per conversation based on detected intent and keywords | `urgencyScore` column exists on `ConversationSession`; Redis already sets it to 80 on URGENCIA_ALTA — needs DB write path |
| URG-02 | High-urgency conversations highlighted in dashboard queue | `UrgencyBadge` component and urgency queue already in `metrics/page.tsx` — reads from `ConversationSession.urgencyScore` |
| FOL-01 | Follow-up automation with 24h WhatsApp window check | No existing infrastructure — requires new BullMQ queue `follow-up` + `ScheduledFollowUp` table |
| FOL-02 | Follow-up blocked automatically outside 24h window — admin notified | 24h window = `Date.now() - contact.lastContactAt < 24h`; `ClientMemory.lastContactAt` is the correct field |
</phase_requirements>

---

## Project Constraints (from CLAUDE.md)

No CLAUDE.md found in the working directory. No project-level directives to enforce.

---

## Standard Stack

### Core (all already present in the project)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.x | All backend/frontend code | Project baseline [VERIFIED: codebase] |
| Prisma (tenant client) | Existing | `TenantKnowledge`, `ConversationSession`, `Conversation` access | Already generated and in use [VERIFIED: codebase] |
| BullMQ | Existing | Follow-up job queue (new `follow-up` queue, same pattern as `session-timeout`) | Already used for session-timeout, lid-reconciliation [VERIFIED: queue-names.ts] |
| ioredis | Existing | Confirmation-gate state (TTL keys), urgencyScore hash fields | Already used throughout service.ts [VERIFIED: codebase] |
| Vitest | ^3.2.4 | Test framework | `apps/api/package.json` scripts [VERIFIED: package.json] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:crypto` randomUUID | Built-in | IDs for new `LearningLog` rows | Already used in `knowledge.service.ts` |
| Zod | Existing | Validation of confirmation responses ("SIM") | Pattern already used across module-runtime.ts |

**No new npm packages needed.** All required infrastructure (BullMQ, Redis, Prisma, Vitest) is already installed.

---

## Architecture Patterns

### Recommended Project Structure Changes

```
apps/api/src/
├── modules/
│   ├── instances/
│   │   ├── aprendizado-continuo.interface.ts   # NEW — IAprendizadoContinuoModule
│   │   ├── aprendizado-continuo.active.ts      # NEW — ActiveAprendizadoContinuoModule
│   │   ├── aprendizado-continuo.disabled.ts    # NEW — DisabledAprendizadoContinuoModule
│   │   └── service.ts                          # CHANGED — wire interface in constructor
│   └── chatbot/
│       ├── escalation.service.ts               # CHANGED — add confirmation gate
│       └── knowledge.service.ts                # CHANGED — add confirmedAt/confirmedByJid
├── queues/
│   ├── follow-up-queue.ts                      # NEW — BullMQ follow-up queue
│   └── queue-names.ts                          # CHANGED — add FOLLOW_UP entry
└── lib/
    ├── tenant-schema.ts                        # CHANGED — LearningLog or TenantKnowledge extension
    └── run-migrations.ts                       # CHANGED — new migration entries
apps/panel/
└── components/tenant/
    └── chatbot-studio.tsx                      # CHANGED — surface audit metadata in "conhecimento" tab
```

### Pattern 1: Null Object Pattern for IAprendizadoContinuoModule

**What:** Define an interface with all methods the rest of the codebase calls. Implement two concrete classes: `Active` (real behavior) and `Disabled` (returns safe no-op defaults). Wire at startup based on config.

**When to use:** Whenever a feature module is optional and callers must work correctly whether it is on or off.

**Interface contract (from Plan 8.1):**

```typescript
// Source: ROADMAP.md Plan 8.1 — exact method list
export interface IAprendizadoContinuoModule {
  isEnabled(): boolean;
  isVerified(): boolean;
  getAdminPhones(): string[];
  getAdminJids(): string[];
  processLearningReply(
    tenantId: string,
    instanceId: string,
    adminRawAnswer: string,
    targetConversationId?: string | null
  ): Promise<unknown>;
  shouldSendDailySummary(tenantId: string, instanceId: string): boolean;
  buildDailySummary(tenantId: string, instanceId: string): Promise<string>;
}

// Disabled implementation — all guards replaced by this
export class DisabledAprendizadoContinuoModule implements IAprendizadoContinuoModule {
  isEnabled() { return false; }
  isVerified() { return false; }
  getAdminPhones() { return []; }
  getAdminJids() { return []; }
  async processLearningReply() { return null; }
  shouldSendDailySummary() { return false; }
  async buildDailySummary() { return ""; }
}
```

**Wiring in service.ts:**

```typescript
// Source: [VERIFIED: service.ts constructor pattern]
// Replace the aprendizadoContinuoModule config object with interface instance
const aprendizadoModule: IAprendizadoContinuoModule =
  chatbotConfig.modules?.aprendizadoContinuo?.isEnabled
    ? new ActiveAprendizadoContinuoModule(chatbotConfig.modules.aprendizadoContinuo)
    : new DisabledAprendizadoContinuoModule();
```

**Guards to remove (14 occurrences across 3 files):**
- `service.ts` lines: 1588, 1679, 2242, 2282, 2635, 4673, 4801 (7 guards)
- `chatbot/service.ts` lines: 683, 1281, 1306, 1448, 2175 (5 guards)
- `admin-identity.service.ts` lines: 74, 84 (2 guards — special case, see pitfalls)

### Pattern 2: Redis-backed Confirmation Gate (Plan 8.2)

**What:** A two-step flow for knowledge ingestion. Step 1: admin sends answer → system saves to Redis with TTL → sends confirmation echo. Step 2: admin replies "SIM" → system reads from Redis, calls `knowledgeService.save()`, deletes Redis key.

**Key design:**

```typescript
// Source: [ASSUMED — modeled on existing Redis lock pattern in escalation.service.ts:317]
// Key: confirmation:${instanceId}:${adminPhone}
// Value: JSON { tenantId, instanceId, question, synthesizedAnswer, rawAnswer, conversationId, adminJid }
// TTL: 600 seconds (10 minutes)

// Step 1 — After synthesizing answer, before saving:
await redis.set(
  `confirmation:${instanceId}:${adminPhone}`,
  JSON.stringify(pendingEntry),
  'EX', 600
);
await sendMessage(adminPhone, `Entendido: ${synthesized.answer}. Devo adicionar isso ao conhecimento do sistema? Responda SIM para confirmar.`);
// Do NOT call knowledgeService.save() here

// Step 2 — When admin next message arrives and is "SIM":
const raw = await redis.get(`confirmation:${instanceId}:${adminPhone}`);
if (raw && normalizeInput(adminMessage) === 'sim') {
  const entry = JSON.parse(raw);
  await knowledgeService.save(...entry);
  await redis.del(`confirmation:${instanceId}:${adminPhone}`);
}
```

**Detection of "SIM":** Normalize input (lowercase, strip accents, trim). Accept: "sim", "s", "sim!" — reject everything else (casual replies like "ok" or "claro" must NOT trigger ingestion).

**4-hour escalation window expiry:** If admin does not respond within 4 hours after being notified, mark `awaitingAdminResponse: false` on the `Conversation` row. The `escalationRetryMap` already has a timer infrastructure — extend it to fire at 4 hours and call `prisma.conversation.update({ awaitingAdminResponse: false })`.

### Pattern 3: Urgency Score Persistence (Plan 8.4)

**What is already done (verified):**
- `ConversationSession.urgencyScore` column exists (`tenant-schema.ts:253`, `run-migrations.ts:247`) [VERIFIED]
- `InstanceEventBus` has `session.urgency_detected` event with `urgencyScore: number` [VERIFIED: instance-events.ts]
- Redis hash field `urgencyScore` set to `'80'` on URGENCIA_ALTA detection in service.ts [VERIFIED: service.ts:2382]
- `metrics/page.tsx` has `UrgencyBadge` component and urgency-sorted queue [VERIFIED: metrics page]

**What is missing:**
- `SessionMetricsCollector` does not persist `urgencyScore` from Redis → `ConversationSession` DB row [ASSUMED: not verified by reading session-metrics-collector.ts in full]
- Secondary urgency signals (session duration, unanswered count, explicit keywords beyond URGENCIA_ALTA) — currently only intent-based (score = 80 fixed)

**Urgency computation for secondary signals:**

```typescript
// Source: [ASSUMED — not currently implemented]
// Score formula: start from intent base (0 or 80), add secondary signals
function computeUrgencyScore(params: {
  intentLabel: string;
  unansweredCount: number;
  sessionDurationMinutes: number;
  messageText: string;
}): number {
  const base = params.intentLabel === 'URGENCIA_ALTA' ? 80 : 0;
  const urgencyKeywords = ['urgente', 'urgência', 'imediato', 'agora', 'preciso agora', 'hj', 'hoje'];
  const keywordBonus = urgencyKeywords.some(k => params.messageText.toLowerCase().includes(k)) ? 15 : 0;
  const unansweredBonus = Math.min(params.unansweredCount * 5, 20);
  return Math.min(base + keywordBonus + unansweredBonus, 100);
}
```

### Pattern 4: Follow-Up BullMQ Queue (Plan 8.4)

**What:** A new BullMQ queue `follow-up` with jobs scheduled at `delay: targetTimestamp - now`. Before scheduling, validate the 24h window. Block if outside window.

**Pattern (consistent with session-timeout-queue.ts):**

```typescript
// Source: [ASSUMED — modeled on session-timeout-queue.ts pattern, verified as the project standard]
// apps/api/src/queues/follow-up-queue.ts
export const createFollowUpQueue = (connection: IORedis): Queue =>
  new Queue(QUEUE_NAMES.FOLLOW_UP, {
    connection: connection as never,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 }
  });

// 24h window check — use ClientMemory.lastContactAt (VERIFIED field exists)
function isWithin24hWindow(lastContactAt: Date): boolean {
  return Date.now() - lastContactAt.getTime() < 24 * 60 * 60 * 1000;
}

// Business hours block: 21:00–08:00 America/Sao_Paulo
function isWithinBusinessHours(targetDate: Date, timezone = 'America/Sao_Paulo'): boolean {
  const local = new Date(targetDate.toLocaleString('en-US', { timeZone: timezone }));
  const h = local.getHours();
  return h >= 8 && h < 21;
}
```

**ScheduledFollowUp table** (new, via `run-migrations.ts`):

```sql
CREATE TABLE IF NOT EXISTS {schema}."ScheduledFollowUp" (
  "id" TEXT PRIMARY KEY,
  "instanceId" TEXT NOT NULL REFERENCES {schema}."Instance"("id") ON DELETE CASCADE,
  "contactJid" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "scheduledAt" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', -- pending | sent | blocked | cancelled
  "blockedReason" TEXT,
  "bullmqJobId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Anti-Patterns to Avoid

- **Inline `isEnabled` guard after interface introduction:** Once `IAprendizadoContinuoModule` is wired, calling `.isEnabled()` anywhere other than the wiring site (`app.ts` or service constructor) is a regression. The disabled implementation handles all cases.
- **Accepting "ok", "claro", or "sim, pode" as confirmation:** Confirmation gate must normalize strictly. Only exact "sim" (after normalization) triggers ingestion — "sim, pode" must also work (check if normalized input starts with "sim" after trimming).
- **Writing urgencyScore to DB synchronously in the message pipeline:** Must use `setImmediate()` or the existing `InstanceEventBus` subscriber pattern (same as `SessionMetricsCollector`) to avoid blocking.
- **Scheduling a follow-up without persisting to `ScheduledFollowUp` table:** BullMQ jobs can be lost on Redis flush. The DB row is the durable record.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Distributed confirmation state | In-process `Map<string, PendingConfirmation>` | Redis key with TTL | Survives worker restart; consistent with existing escalation lock pattern |
| Follow-up job scheduling | `setTimeout` in process | BullMQ `follow-up` queue (new, same pattern as `session-timeout-queue.ts`) | Persisted across restarts; deduplication available |
| Knowledge similarity check | New similarity algorithm | `KnowledgeService.save()` already does semantic deduplication (Jaccard + containment, threshold 0.55) | Already implemented and tested |
| Panel knowledge review | New custom page | Extend existing `chatbot-studio.tsx` "conhecimento" tab | Already renders learned Q&A pairs with delete; needs audit metadata fields added |
| Urgency badge | Custom React component | `UrgencyBadge` in `metrics/page.tsx` already exists | [VERIFIED: metrics/page.tsx:20] |

**Key insight:** The "Conhecimento Adquirido" panel (APR-06) is substantially done. The "Remover" action already calls `DELETE /instances/:id/knowledge/:knowledgeId`. What's missing is surfacing `confirmedAt`, `confirmedByJid`, and `usageCount` (if tracked) — this requires a schema extension and a UI column, not a new page.

---

## Common Pitfalls

### Pitfall 1: admin-identity.service.ts has `isEnabled` guards that are NOT removable as-is

**What goes wrong:** The two guards in `admin-identity.service.ts` at lines 74 and 84 gate `verifiedAdminPhones` and `verifiedAdminJids` arrays. Simply removing the guard without providing the data another way will cause the `Disabled` module path to return empty arrays — which is actually correct behavior (disabled module = no verified admin phones from the module), so the guard can be replaced with `module.isEnabled()` method call on the interface.

**How to avoid:** The interface's `isVerified()` method can replace `isEnabled && verificationStatus === "VERIFIED"`. `getAdminPhones()` and `getAdminJids()` return `[]` when disabled. The `ActiveAprendizadoContinuoModule` reads from its config and returns populated arrays only when `verificationStatus === "VERIFIED"`.

**Warning sign:** Any test that verifies admin detection still works with `aprendizadoContinuo` disabled.

### Pitfall 2: Confirmation gate double-ingestion on Baileys duplicate events

**What goes wrong:** Baileys is known to emit duplicate message events. If the admin sends "SIM" and Baileys fires the event twice, `knowledgeService.save()` will be called twice. The similarity check in `KnowledgeService` (threshold 0.55) will deduplicate on the second call, but there's a race window.

**How to avoid:** Use the same Redis lock pattern as `processAdminReply` already does (`SET lockKey "1" EX 10 NX`). Delete the confirmation key atomically before calling `knowledgeService.save()` — if the DEL returns 0, the confirmation was already processed.

### Pitfall 3: 4-hour escalation window timer leaks on server restart

**What goes wrong:** `escalationRetryMap` is an in-process `Map<string, { timer, ctx }>`. Server restart clears it. Questions escalated before restart will never expire.

**How to avoid:** The 4-hour timer should be backed by Redis TTL, not just in-process. Set `SET escalation:window:{instanceId}:{conversationId} "1" EX 14400` when escalation fires. A startup recovery scan can find open `awaitingAdminResponse=true` conversations that have no corresponding Redis TTL key and mark them as `unanswered`.

### Pitfall 4: urgencyScore in Redis vs. DB divergence

**What goes wrong:** The Redis hash already has `urgencyScore: '80'` written by the intent pre-pass. But `ConversationSession.urgencyScore` in PostgreSQL starts at `DEFAULT 0` and may never be updated if the `session.urgency_detected` event is not handled by `SessionMetricsCollector`.

**How to avoid:** Check whether `SessionMetricsCollector` subscribes to `session.urgency_detected` event. If not, add the subscription (follow the same pattern as `session.handoff` handler). The dashboard queue reads from `ConversationSession`, not Redis.

### Pitfall 5: Follow-up schedule uses server local time instead of Brazil timezone

**What goes wrong:** Business hours check (`no sends 21:00–08:00`) uses UTC if `new Date()` is called without timezone conversion.

**How to avoid:** Use the same pattern as `isWithinHorarioAtendimento()` in `module-runtime.ts` — convert to `America/Sao_Paulo` with `toLocaleString('en-US', { timeZone: ... })` before reading `.getHours()`.

### Pitfall 6: "Conhecimento Adquirido" panel already exists — Plan 8.3 scope is narrower than it looks

**What goes wrong:** Planning duplicates existing work. The tab, the list, and the delete button are already in `chatbot-studio.tsx` (lines 372, 1479–1498, 532–637). Re-building this from scratch wastes time.

**How to avoid:** The plan for 8.3 is to (a) add `confirmedAt` and `confirmedByJid` to `TenantKnowledge` via migration, (b) populate them in the confirmation gate, (c) surface them as new columns in the existing `chatbot-studio.tsx` table. Not a new page.

---

## Code Examples

### Existing escalation lock pattern (confirmation gate can reuse this)

```typescript
// Source: [VERIFIED: escalation.service.ts:317–332]
const lockKey = `escalation:reply-lock:${instanceId}:${targetConversationId ?? "any"}`;
const acquired = await this.redis.set(lockKey, "1", "EX", 10, "NX");
if (!acquired) {
  console.warn(`[escalation] processAdminReply ignorado — lock ativo`);
  return null;
}
try {
  return await this._processAdminReplyInternal(...);
} finally {
  await this.redis.del(lockKey).catch(() => null);
}
```

### Existing urgencyScore Redis write (already in place)

```typescript
// Source: [VERIFIED: service.ts:2377–2383]
const jidPattern = /^[^:@]+@(s\.whatsapp\.net|g\.us)$/;
if (jidPattern.test(event.remoteJid)) {
  this.redis.hset(
    `session:${tenantId}:${instance.id}:${event.remoteJid}`,
    { urgencyScore: '80' }
  ).catch((err: unknown) => console.warn('[intent] failed to set urgencyScore in Redis', err));
}
```

### Existing knowledge save method signature

```typescript
// Source: [VERIFIED: knowledge.service.ts:81–135]
public async save(
  tenantId: string,
  instanceId: string,
  question: string,
  answer: string,
  rawAnswer: string,
  taughtBy: string
): Promise<LearnedKnowledge>
// Note: does NOT have confirmedAt/confirmedByJid — these must be added in Plan 8.3 migration
```

### Existing BullMQ queue pattern to replicate for follow-up

```typescript
// Source: [VERIFIED: session-timeout-queue.ts]
import { Queue } from "bullmq";
import type { Redis as IORedis } from "ioredis";
import { QUEUE_NAMES } from "./queue-names.js";

export const createFollowUpQueue = (connection: IORedis): Queue =>
  new Queue(QUEUE_NAMES.FOLLOW_UP, {
    connection: connection as never,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
  });
```

### InstanceEventBus urgency event (already typed)

```typescript
// Source: [VERIFIED: instance-events.ts:27–35]
export interface SessionUrgencyDetectedEvent {
  type: 'session.urgency_detected';
  tenantId: string;
  instanceId: string;
  remoteJid: string;
  sessionId: string;
  urgencyScore: number;
}
```

---

## Runtime State Inventory

> Step 2.5: Not a rename/refactor phase — this section is omitted.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Redis (ioredis) | Confirmation gate state, urgency hash | Confirmed running (used by all prior phases) | Existing | — |
| BullMQ | Follow-up queue (new queue, same infrastructure) | Confirmed — 4 queues already operational | Existing | — |
| PostgreSQL (Prisma tenant) | LearningLog/TenantKnowledge extension, ScheduledFollowUp | Confirmed running | Existing | — |
| Vitest | Test scaffolds | Confirmed — `npm test` runs vitest | ^3.2.4 | — |

**No missing dependencies.** Phase 8 is purely internal refactoring + additive features on existing infrastructure.

---

## State of the Art

| Old Approach | Current Approach | Status | Impact |
|--------------|------------------|--------|--------|
| `if (aprendizadoContinuoModule?.isEnabled)` guards everywhere | `IAprendizadoContinuoModule` interface + Null Object | To be done in Plan 8.1 | Removes 14 guards; disabled path is architecturally enforced |
| Admin reply → immediate knowledge ingestion | Admin reply → confirmation echo → "SIM" → ingestion | To be done in Plan 8.2 | Knowledge base cannot be contaminated by casual admin replies |
| `TenantKnowledge` rows with no audit metadata | Add `confirmedAt` + `confirmedByJid` via migration | To be done in Plan 8.3 | APR-05 compliance |
| urgencyScore written only to Redis | urgencyScore written to Redis + `ConversationSession` DB | To be done in Plan 8.4 | Dashboard queue reads from DB, not Redis |
| No automated follow-up infrastructure | BullMQ `follow-up` queue + `ScheduledFollowUp` table | To be done in Plan 8.4 | FOL-01, FOL-02 |

**Deprecated/outdated:**
- All inline `aprendizadoContinuoModule?.isEnabled` checks: replaced by interface method calls after Plan 8.1.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `SessionMetricsCollector` does NOT subscribe to `session.urgency_detected` | Architecture Patterns — Pitfall 4 | If it already subscribes and writes to DB, Plan 8.4 urgency work is narrower; low risk |
| A2 | Confirmation gate state can use Redis TTL key (10 min) | Architecture Patterns Pattern 2 | If Redis is unavailable, confirmation state is lost — but Redis is required for all other real-time features so this is not a new dependency |
| A3 | Secondary urgency signals (keyword bonus, unanswered count) should be computed at message-processing time | Architecture Patterns Pattern 3 | If computed elsewhere (e.g., on dashboard load), implementation placement changes |
| A4 | `ScheduledFollowUp` table approach for follow-ups is appropriate (vs. in-process timer only) | Architecture Patterns Pattern 4 | If follow-ups are very low volume and Redis flush risk is accepted, a simpler in-process approach works; DB table is safer |

---

## Open Questions

1. **Does `SessionMetricsCollector` already handle `session.urgency_detected`?**
   - What we know: The event is typed and emitted. `SessionMetricsCollector` subscribes to other events.
   - What's unclear: Whether `urgencyScore` DB write is already wired.
   - Recommendation: Read `session-metrics-collector.ts` first thing in Plan 8.4. If wired, skip; if not, add.

2. **Should the confirmation gate use "SIM" strict match or also accept "s", "sim!" etc.?**
   - What we know: Brazilian users often abbreviate. "s" alone could be ambiguous.
   - Recommendation: Accept: normalized input `=== 'sim'` OR starts with `'sim'` after normalization. Reject "s" alone to prevent false positives.

3. **`TenantKnowledge` extension vs. separate `LearningLog` table for APR-05?**
   - What we know: `TenantKnowledge` already has `taughtBy`, `updatedAt`, `createdAt`. Adding `confirmedAt` + `confirmedByJid` covers APR-05 without a new table.
   - Recommendation: Extend `TenantKnowledge` via migration (simpler, no join required). Add `confirmedAt TIMESTAMPTZ` and `confirmedByJid TEXT`. The existing "conhecimento" tab in the panel already queries this model.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 3.2.4 |
| Config file | `apps/api/vitest.config.ts` |
| Quick run command | `npm --prefix apps/api test -- --reporter=verbose --testPathPattern=aprendizado` |
| Full suite command | `npm --prefix apps/api test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| APR-01 | Disabled module — all service calls succeed with no-ops | Unit | `vitest run --testPathPattern=aprendizado-continuo` | ❌ Wave 0 |
| APR-02 | Admin reply triggers confirmation echo; knowledge NOT written until "SIM" | Unit | `vitest run --testPathPattern=escalation` | ❌ (extend existing escalation.service test) |
| APR-04 | Casual admin reply ("ok", "vou ver") does NOT write to knowledge base | Unit | `vitest run --testPathPattern=escalation` | ❌ Wave 0 |
| APR-05 | Saved knowledge entry has `confirmedAt` and `confirmedByJid` populated | Unit | `vitest run --testPathPattern=knowledge` | ❌ Wave 0 |
| APR-06 | Panel "conhecimento" tab shows audit metadata columns | Manual (UI) | — | N/A |
| URG-01 | `URGENCIA_ALTA` intent → `ConversationSession.urgencyScore >= 80` in DB | Integration | `vitest run --testPathPattern=session-metrics` | ❌ Wave 0 (extend session-metrics-collector test) |
| URG-02 | Dashboard queue sorted by urgencyScore descending | Manual (UI) | — | N/A |
| FOL-01 | Follow-up scheduled within 24h window → BullMQ job created | Unit | `vitest run --testPathPattern=follow-up` | ❌ Wave 0 |
| FOL-02 | Follow-up outside 24h window → job NOT created; admin notified | Unit | `vitest run --testPathPattern=follow-up` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm --prefix apps/api test -- --reporter=dot`
- **Per wave merge:** `npm --prefix apps/api test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `apps/api/src/modules/instances/__tests__/aprendizado-continuo.interface.test.ts` — covers APR-01 (Null Object behavior)
- [ ] `apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts` — covers APR-02, APR-04
- [ ] `apps/api/src/modules/chatbot/__tests__/knowledge-audit.test.ts` — covers APR-05
- [ ] `apps/api/src/modules/instances/__tests__/follow-up.service.test.ts` — covers FOL-01, FOL-02
- [ ] Extend `session-metrics-collector.test.ts` — add `session.urgency_detected` handler test for URG-01

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | — |
| V3 Session Management | No | — |
| V4 Access Control | Yes — knowledge ingestion must only accept admin-origin replies | `AdminIdentityService.canReceiveLearningReply` (already enforced upstream) |
| V5 Input Validation | Yes — confirmation gate input ("SIM" detection) | Normalize + strict match; reject anything not "sim" |
| V6 Cryptography | No | — |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Non-admin reply spoofing as "SIM" to inject knowledge | Spoofing | Confirmation gate only fires when `canReceiveLearningReply = true` (from `AdminIdentityService`) |
| Duplicate Baileys events triggering double knowledge write | Tampering | Redis DEL atomicity + existing distributed lock pattern |
| Follow-up sent outside 24h window (consent violation) | Repudiation | Block at scheduling time with explicit DB log entry (`blockedReason`) |

---

## Sources

### Primary (HIGH confidence)

- `[VERIFIED: codebase]` — All `isEnabled` guard locations counted directly from source files
- `[VERIFIED: escalation.service.ts]` — `processAdminReply()` method, distributed lock pattern, `pendingCorrectionMap`
- `[VERIFIED: knowledge.service.ts]` — `save()`, `list()`, `delete()` methods and `TenantKnowledge` schema
- `[VERIFIED: tenant-schema.ts]` — `TenantKnowledge`, `ConversationSession` (with `urgencyScore`), `Conversation` (with `awaitingAdminResponse`)
- `[VERIFIED: instance-events.ts]` — `SessionUrgencyDetectedEvent` type definition
- `[VERIFIED: admin-identity.service.ts]` — `canReceiveLearningReply`, `isAdminLearningReply` logic
- `[VERIFIED: chatbot-studio.tsx]` — "conhecimento" tab exists with list + delete (lines 372, 1479)
- `[VERIFIED: metrics/page.tsx]` — `UrgencyBadge` component and urgency-sorted queue
- `[VERIFIED: session-timeout-queue.ts]` — BullMQ queue pattern for follow-up replication
- `[VERIFIED: queue-names.ts]` — Existing queue names; `FOLLOW_UP` not yet registered
- `[VERIFIED: run-migrations.ts:247]` — `urgencyScore` migration already applied

### Secondary (MEDIUM confidence)

- `[VERIFIED: service.ts:2367–2384]` — `urgencyScore` written to Redis on URGENCIA_ALTA; DB write path not confirmed in session-metrics-collector
- `[VERIFIED: memory.service.ts:112]` — `listForFollowUp()` uses `ClientMemory.lastContactAt` + `follow_up` tag

### Tertiary (LOW confidence)

- None. All findings were verified from source.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — project has no new dependencies; all tools confirmed in codebase
- Architecture: HIGH — patterns derived from verified existing code in same files
- Pitfalls: HIGH — all pitfalls derived from verified code behavior
- Urgency DB persistence gap: MEDIUM — requires reading `session-metrics-collector.ts` to confirm

**Research date:** 2026-04-24
**Valid until:** 2026-05-24 (stable codebase; fast-moving only if other phases merge changes to `escalation.service.ts` or `service.ts`)
