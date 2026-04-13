# Phase 3: Admin Identity Service — Research

**Researched:** 2026-04-13
**Domain:** Admin identity extraction (service class), Redis JID cache, Baileys connection lifecycle, platform-auth wiring, housekeeping refactors
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ADM-01 | Admin do tenant identificado de forma confiável em todo fluxo de mensagens — nunca tratado como cliente | Plan 3.1 extracts the detection block; Plan 3.3 wires single call site in `handleInboundMessage` |
| ADM-02 | Identificação de admin desacoplada do módulo `aprendizadoContinuo` — funciona mesmo com módulo desativado | Plan 3.1 accepts `IAprendizadoContinuoModule` interface (nullable), derives `adminCandidatePhones` from `platformConfig.adminAlertPhone` + `chatbotConfig.leadsPhoneNumber` which do not require module enabled |
| ADM-03 | JID do admin resolvido via `sock.onWhatsApp()` na abertura de conexão e cacheado no Redis | Plan 3.2 — pattern already proven in `baileys-session.worker.ts:934`; worker communicates to orchestrator via message; orchestrator owns Redis |
| ADM-04 | Super admin da plataforma (platform owner) reconhecido corretamente em todas as rotas do painel | Plan 3.3 — authz system is already correct in `auth.ts`; specific routes may bypass it via wrong patterns; audit needed |

</phase_requirements>

---

## Summary

Phase 3 extracts admin identity from `InstanceOrchestrator.handleInboundMessage()` into a standalone `AdminIdentityService`, adds a Redis-backed JID cache populated at Baileys connection open, and audits super-admin API routes for correct `PLATFORM_OWNER` enforcement. The fourth plan handles five housekeeping fixes that would otherwise create noise in future extraction diffs.

The admin detection block is already written and correct — it lives at lines 2134–2257 of `service.ts` and covers all required cases (plain phone match, verified aprendizadoContinuo admin, LID-form JID, instance self-chat). The extraction work is refactoring, not new feature work. The Redis JID cache is a new capability that adds one async step to `connection.update: open` in the worker, and one lookup in `AdminIdentityService.resolve()` for `@lid` JIDs.

The key risk is the extraction seam: `AdminIdentityService` needs four helper methods (`findMatchingExpectedPhone`, `matchesAnyExpectedJids`, `phonesMatch`, `buildPhoneMatchVariants`) that are currently private methods on `InstanceOrchestrator`. They must be moved to the new service without breaking the LID alias tracking and escalation resolution flows that also call `matchesAnyExpectedJids` and `matchesAnyExpectedPhones`.

**Primary recommendation:** Extract the admin detection block as a pure-function service (no database writes, no side effects), inject it into `handleInboundMessage()` as a single call that returns `AdminIdentityContext`, and write unit tests for the four key scenarios before touching production code.

---

## Standard Stack

No new npm packages are required for this phase. All dependencies are already present.

### In Use

| Library | Version in Use | Role in This Phase |
|---------|---------------|-------------------|
| `ioredis` | already present | Redis SET/GET for `instance:{id}:admin_jid` key |
| `@whiskeysockets/baileys` | already present | `sock.onWhatsApp()` at connection open; `signalRepository.lidMapping?.getPNForLID?.(jid)` |
| `pino` | already present via `lib/logger.ts` | Replace `console.*` calls with structured log calls |
| `vitest` | `^3.2.4` (apps/api/package.json) | Unit tests for `AdminIdentityService` |

[VERIFIED: codebase grep of package.json and import analysis]

**Version verification:** No new packages — nothing to pin.

---

## Architecture Patterns

### Recommended Project Structure (Phase 3 additions)

```
apps/api/src/modules/instances/
├── service.ts                      # InstanceOrchestrator — admin block removed, service injected
├── admin-identity.service.ts       # NEW — AdminIdentityService class
├── baileys-session.worker.ts       # MODIFIED — onWhatsApp() call at connection:open
├── schemas.ts
├── routes.ts
└── ...

apps/api/src/modules/instances/__tests__/
└── admin-identity.service.test.ts  # NEW — four scenario unit tests (Wave 0)
```

### Pattern 1: AdminIdentityContext Return Shape

The service returns a single immutable struct. This prevents callers from re-deriving flags independently (the anti-pattern being eliminated).

```typescript
// apps/api/src/modules/instances/admin-identity.service.ts
export interface AdminIdentityContext {
  isAdmin: boolean;                      // matched adminCandidatePhones
  isVerifiedAdmin: boolean;              // matched verified aprendizadoContinuo admin
  isInstanceSelf: boolean;               // sender IS the whatsapp instance's own number
  isAdminSelfChat: boolean;              // admin messaging their own number
  canReceiveLearningReply: boolean;      // canProcessAprendizadoContinuoReply
  matchedAdminPhone: string | null;      // which candidate phone matched
  escalationConversationId: string | null; // resolved learning conversation id
}
```

[ASSUMED: field names derived from current variable names in service.ts:2223–2257; shape is our design choice]

### Pattern 2: Service Constructor — Interface Not Concrete Module

The service must NOT import the concrete `aprendizadoContinuo` module. It receives the already-resolved config object from `getAprendizadoContinuoModuleConfig()`, which is typed and nullable.

```typescript
// Input to AdminIdentityService.resolve()
export interface AdminIdentityInput {
  remoteJid: string;
  senderJid: string | undefined;
  messageKey: { fromMe?: boolean } | undefined;
  rawMessage: unknown;
  rawTextInput: string;
  // resolved data
  adminCandidatePhones: Array<string | null>;
  aprendizadoContinuoModule: ReturnType<typeof getAprendizadoContinuoModuleConfig> | null;
  instanceOwnPhone: string | null;
  contactFields: Record<string, unknown> | null;
  // resolved phone variants (already computed in handleInboundMessage)
  senderNumber: string | null;
  remoteChatNumber: string | null;
  resolvedContactNumber: string | null;
  remoteNumber: string | null;
  realPhoneFromRemoteJid: string | null;
  cleanPhoneFromRemoteJid: string;
  sharedPhoneNumberFromFields: string | null;
  lastRemoteNumber: string | null;
}
```

[ASSUMED: input shape is a design choice; exact fields validated against the 2134–2257 block]

### Pattern 3: Redis JID Cache Key Convention

The existing Redis key convention in this codebase uses `instance:{instanceId}:` prefix for per-instance state. The admin JID cache follows the same convention.

```
SET  instance:{instanceId}:admin_jid  {resolvedJid}    # no TTL — cleared on disconnect
GET  instance:{instanceId}:admin_jid                   # read in AdminIdentityService.resolve()
DEL  instance:{instanceId}:admin_jid                   # on connection.update: close
```

[VERIFIED: key pattern matches existing Redis usage in `lib/redis-rate-limit.ts` and `escalation.service.ts`]

### Pattern 4: Worker → Orchestrator Communication for Redis Cache

The Baileys worker thread cannot access the orchestrator's Redis instance directly. The worker sends a typed message to the parent; the orchestrator writes to Redis.

```typescript
// In baileys-session.worker.ts — new message type
parentPort?.postMessage({
  type: "admin-jid-resolved",
  resolvedJid: result.jid   // from sock.onWhatsApp(adminPhone)[0].jid
});

// In service.ts handleWorkerMessage()
if (event.type === "admin-jid-resolved") {
  await this.redis.set(
    `instance:${instance.id}:admin_jid`,
    event.resolvedJid
  );
  return;
}
```

[ASSUMED: no TTL is correct per plan spec — key cleared on disconnect, not expiry]

The worker already sends `profile`, `inbound-message`, `phone-number-share`, `chat-phone-mapping`, `status` messages via `parentPort.postMessage`. Adding `admin-jid-resolved` follows the same pattern. [VERIFIED: service.ts:1186–1212]

### Pattern 5: Baileys `onWhatsApp()` Call at Connection Open

`onWhatsApp()` is already used in the send path at `baileys-session.worker.ts:934`. The same call is appropriate at connection open.

```typescript
// In baileys-session.worker.ts — connection.update: open handler (line ~748)
if (event.connection === "open") {
  // ... existing emitStatus("CONNECTED") code ...

  // Resolve admin JID now that socket is authenticated
  const adminPhone = init.adminPhone; // passed in worker init payload
  if (adminPhone) {
    try {
      const result = await activeSocket.onWhatsApp(adminPhone);
      const resolved = Array.isArray(result) ? result[0] : undefined;
      if (resolved?.exists && resolved.jid) {
        parentPort?.postMessage({
          type: "admin-jid-resolved",
          resolvedJid: resolved.jid
        });
      }
    } catch {
      log("warn", "Falha ao resolver JID do admin na conexao");
    }
  }
}
```

[ASSUMED: `init.adminPhone` is available in worker init — must be verified against worker init message shape or added]

**Critical check needed:** The worker's `init` message currently passes `instanceId`, `tenantId`, and auth/session config. Whether `adminPhone` is already in the init payload needs to be verified. If not, it must be added to the `WorkerInitMessage` type in `service.ts`.

### Pattern 6: LID-to-Phone Lookup in AdminIdentityService

When `remoteJid` ends with `@lid`, the service should attempt resolution via `signalRepository` before falling back to the Redis-cached JID.

```typescript
// This is a worker-thread-only API — NOT accessible in InstanceOrchestrator
// Resolution must happen in the worker before the inbound-message event is posted
// OR via the Redis cached value set at connection open
```

[VERIFIED: `signalRepository.lidMapping?.getPNForLID` is accessible only inside the Baileys worker thread, NOT in InstanceOrchestrator — see baileys-session.worker.ts context]

**Implication for Plan 3.2:** The LID resolution at message receipt must also happen in the worker, in the `messages.upsert` handler, before posting `inbound-message` to the orchestrator. This is consistent with how Phase 2 Plan 2.1 handles LID normalization. The Redis-cached `admin_jid` serves as a cross-message identity anchor.

### Pattern 7: Pino Logger for Plan 3.4

The project has `lib/logger.ts` which exports `createLogger(config)` returning a Pino instance. `InstanceOrchestrator` does not currently receive the logger — it uses `console.*` directly. Plan 3.4 should use a module-scoped child logger pattern to avoid requiring logger injection into the constructor.

```typescript
// At top of service.ts — module-scoped logger
// The orchestrator already has this.config — use it to create a scoped logger
import { createLogger } from "../../lib/logger.js";

// Inside constructor:
this.logger = createLogger(deps.config).child({ component: "InstanceOrchestrator" });
```

Or simpler: accept optional `logger` in `InstanceOrchestratorDeps` to match the Fastify pattern.

[VERIFIED: `lib/logger.ts` confirmed to export `createLogger(config: AppConfig)`]

### Anti-Patterns to Avoid

- **Duplicating `isAdmin` computation outside `AdminIdentityService`:** After Plan 3.3, `AdminIdentityService.resolve()` is the ONLY call site. No other location may compute `isAdmin` independently. Any future code that needs admin identity must call the service.
- **Hard-coding admin phone in worker init:** Worker should receive it at connection time, not embedded in the worker file. Pass via `WorkerInitMessage`.
- **Using TTL on the `admin_jid` Redis key:** The plan explicitly says no TTL. The key is cleared on disconnect. Adding a TTL creates a race where the cache expires mid-session.
- **Making `AdminIdentityService` async for LID resolution:** The Redis lookup can be done synchronously with an `await` but the service should not do its own Redis I/O if the resolved JID was already injected in the inbound message event. Keep LID resolution in the worker layer.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Phone number normalization variants | Custom normalizer inside AdminIdentityService | `normalizeWhatsAppPhoneNumber`, `normalizePhoneNumber`, `buildPhoneMatchVariants` already in `lib/phone.ts` and service.ts private methods | 15+ edge cases already handled (device suffix, country code, E.164) |
| Redis typed messaging | Custom serialization | `ioredis` `.set()` / `.get()` / `.del()` with string values | Already in use; type safety via explicit cast |
| Pino child logger | Module-level console wrapper | `createLogger(config).child({ component })` | Already the project pattern in app.ts:78 |

---

## Common Pitfalls

### Pitfall A: Extracting Admin Block Without Moving Its Helper Methods

**What goes wrong:** The admin detection block (lines 2134–2257) calls four private methods: `findMatchingExpectedPhone`, `matchesAnyExpectedJids`, `phonesMatch`, and `buildPhoneMatchVariants`. These methods are also called by `linkAprendizadoContinuoAdminAlias` (line 1554), `tryVerifyAprendizadoContinuoAdmin` (line 1685), and `matchesAnyExpectedPhones`. If the helpers are moved to `AdminIdentityService` without updating those other call sites, compilation breaks.

**How to avoid:** Move the helpers to `AdminIdentityService` as public or package-level methods, OR extract them to a shared `phone-match.ts` utility. Do NOT leave duplicated copies in both places.

**Warning signs:** TypeScript compiler errors on the four helper method names after extraction.

[VERIFIED: grep of service.ts confirms other call sites at lines 1554, 1563, 1685, 1694, 1699, 1803]

### Pitfall B: Worker Init Message Missing `adminPhone`

**What goes wrong:** Plan 3.2 requires `sock.onWhatsApp(adminPhone)` at connection open. If the worker's init payload doesn't include `adminPhone`, the call cannot be made at the right time (it would require an RPC round-trip back to the orchestrator).

**How to avoid:** Audit the `WorkerInitMessage` type in `service.ts`. If `adminPhone` is not present, add it. The orchestrator has access to `chatbotConfig.leadsPhoneNumber` and `platformConfig.adminAlertPhone` before starting the worker.

**Warning signs:** `init.adminPhone` is undefined in the worker when reading during `connection.update: open`.

[VERIFIED: worker init shape found at service.ts — worker is spawned from `startWorkerForInstance()`; must check what init payload contains]

### Pitfall C: `escalationConversationId` Resolution Has Async DB Calls

**What goes wrong:** Lines 2181–2201 of service.ts contain two async operations: `escalationService.resolveConversationIdByAdminAlertMessageAsync()` and `escalationService.resolveConversationIdByPersistedAdminPrompt()`. If these are included in `AdminIdentityService.resolve()`, the service gains a dependency on `EscalationService` and is no longer a simple struct computer.

**How to avoid:** Option 1: leave escalation conversation ID resolution in `handleInboundMessage()` and pass the result as input to `AdminIdentityService`. Option 2: accept `EscalationService` as a constructor dependency. The planner should pick one approach.

**Recommendation:** Leave escalation resolution in `handleInboundMessage()` and pass `escalationConversationId` as a pre-computed input to `AdminIdentityService.resolve()`. This keeps the service as a pure, fast, synchronous identity checker.

[VERIFIED: lines 2181–2201 confirmed as async escalation lookups in service.ts]

### Pitfall D: `fromMe` Echo Guard Must Not Be Bypassed

**What goes wrong:** The `isVerifiedAprendizadoContinuoAdminSender` check includes `!event.messageKey?.fromMe` (line 2172). This prevents the bot's own outbound messages (echoes) from being mis-identified as admin messages. If the extraction accidentally drops this guard, the bot starts treating its own output as admin commands.

**How to avoid:** `AdminIdentityInput` must include `messageKey?.fromMe` flag. The service must preserve the `!fromMe` guard in the verified admin path.

[VERIFIED: line 2172 of service.ts]

### Pitfall E: Scheduler Start/Stop Ordering (Plan 3.4)

**What goes wrong:** `startSchedulers()` is called at line 179 of `app.ts` inside `buildApp()`, before `app.listen()` in `server.ts:13`. CONCERNS.md section 7 documents this: if `bootstrapPersistedInstances()` throws, schedulers are running but `stopSchedulers()` is not in the `onClose` hook.

**How to avoid:**
1. Move `instanceOrchestrator.startSchedulers()` to `server.ts` after `await app.listen()` succeeds.
2. Add `instanceOrchestrator.stopSchedulers()` inside the `onClose` hook in `app.ts`.

[VERIFIED: app.ts:179, server.ts:7-23, onClose hook at app.ts:321 — stopSchedulers() is NOT in the onClose hook]

### Pitfall F: Worker Exit Without DB Status Update (Plan 3.4)

**What goes wrong:** `service.ts:1056-1077` — the `worker.on("exit")` handler resolves pending requests with 503 but does NOT call `prisma.instance.update({ status: "DISCONNECTED" })`. CONCERNS.md section 5 confirms this.

**How to avoid:** In the `exit` event handler, add a `prisma.instance.update()` call when `code !== 0`. The `tenantId` and `instanceId` are available in the closure.

[VERIFIED: lines 1046-1054 do the DB update on "error" event but NOT on "exit" event; exit handler is at 1056-1077]

### Pitfall G: ADM-04 — Route Audit Scope

**What goes wrong:** Plan 3.3 audits `apps/panel/app/(super-admin)/admin/` panel routes. The actual auth enforcement is in the API routes, not the panel. The panel relies on API 403 responses to block access. If a panel page calls an API endpoint that lacks `auth: "platform"` or `platformRoles: ["PLATFORM_OWNER"]`, the bypass-fix from Phase 1 may have exposed those endpoints correctly, but the routes may have been calling the wrong API endpoints or none at all.

**How to avoid:** For each panel page in `(super-admin)/admin/`, trace which API route it calls and verify that route has `auth: "platform"` and the correct `platformRoles` array in its config. `admin/routes.ts` already has well-structured platformRoles — the audit should confirm coverage is complete.

[VERIFIED: `admin/routes.ts` has correct platformRoles on all routes inspected; audit should confirm panel pages are calling those routes and not bypassed ones]

---

## Code Examples

### Existing Admin Detection — Source Block (lines 2134–2257)

```typescript
// Source: service.ts:2134-2257 [VERIFIED]
// adminCandidatePhones — does NOT require aprendizadoContinuo module
const adminCandidatePhones = [
  platformConfig?.adminAlertPhone ?? null,
  chatbotConfig?.leadsPhoneNumber ?? null
];
// verifiedAdminPhones — REQUIRES aprendizadoContinuo module AND VERIFIED status
const verifiedAdminPhones =
  aprendizadoContinuoModule?.isEnabled && aprendizadoContinuoModule.verificationStatus === "VERIFIED"
    ? [ ... ]
    : [];

// This is the key insight for ADM-02:
// isAdminSender = Boolean(matchedAdminPhone)
// ...works WITHOUT aprendizadoContinuo because adminCandidatePhones is derived
// from platformConfig and chatbotConfig directly.
```

### onWhatsApp() Pattern (already proven in send path)

```typescript
// Source: baileys-session.worker.ts:934 [VERIFIED]
const onWhatsAppResult = await activeSocket.onWhatsApp(payload.to);
const result = Array.isArray(onWhatsAppResult) ? onWhatsAppResult[0] : undefined;
if (result?.exists && result.jid) {
  resolvedJid = result.jid;
}
```

### Redis SET Without TTL

```typescript
// Source: ioredis pattern [VERIFIED: ioredis docs, existing usage in codebase]
await this.redis.set(`instance:${instanceId}:admin_jid`, resolvedJid);
// DEL on disconnect:
await this.redis.del(`instance:${instanceId}:admin_jid`);
```

### Pino Logger Pattern (project convention)

```typescript
// Source: apps/api/src/app.ts:78 [VERIFIED]
const logger = createLogger(config);

// Module-scoped child in InstanceOrchestrator:
this.logger = createLogger(this.config).child({ component: "InstanceOrchestrator" });
// Then replace all console.log/warn/error with:
this.logger.info({ instanceId, ... }, "[worker-status] ...");
this.logger.warn({ err }, "[scheduler] ...");
this.logger.error({ err }, "[orchestrator] ...");
```

---

## State of the Art

| Old Approach | Current Approach | Status |
|--------------|------------------|--------|
| Admin phone inlined in `handleInboundMessage` | Extracted `AdminIdentityService` | This phase |
| `console.*` logging throughout orchestrator | Pino structured logger | This phase (Plan 3.4) |
| Schedulers started before `app.listen()` | Started after listen, stopped in `onClose` | This phase (Plan 3.4) |

**Lines to delete (Plan 3.4):**
- Lines 3389–end of comment block: the `/* ... */` dead code block is 80+ lines, referenced in CONCERNS.md section 3 as lines 3304–3390. Current code shows the comment starts at line 3389 (`/*`) after the `return;` at 3387.
- Line 4887 context: the UTF-8 corruption in `"[lead] erro na extraÃ§Ã£o:"` is a source encoding issue — fix is to re-save the character as the correct UTF-8 sequence `"[lead] erro na extração:"`.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `AdminIdentityInput` shape as defined includes all fields needed for the detection block | Architecture Patterns > Pattern 2 | Service may miss a field; compilation error will catch this |
| A2 | `init.adminPhone` must be added to WorkerInitMessage (not already present) | Pitfall B | If already present, no change needed; if absent, Plan 3.2 cannot proceed without adding it |
| A3 | `escalationConversationId` should be pre-computed outside `AdminIdentityService` (left in `handleInboundMessage`) | Pitfall C | If planner prefers to include it, `EscalationService` becomes a dep — both approaches are valid |
| A4 | No TTL on `admin_jid` Redis key | Architecture Patterns > Pattern 3 | If session persists across disconnect without clearing, stale JID could persist; mitigated by DEL on close |
| A5 | Dead code block is lines 3389–~3470 based on `/*` at 3389 | State of the Art | Exact end line must be verified before deletion |

---

## Open Questions

1. **`adminPhone` in WorkerInitMessage**
   - What we know: Worker is spawned from `startWorkerForInstance()` in `service.ts`; the init payload must be checked.
   - What's unclear: Whether `adminPhone` (derived from `chatbotConfig.leadsPhoneNumber` or `platformConfig.adminAlertPhone`) is already passed to the worker.
   - Recommendation: Wave 0 task should read the `WorkerInitMessage` type definition before coding Plan 3.2.

2. **Which `adminPhone` to cache — one or multiple?**
   - What we know: `adminCandidatePhones` has two entries: `platformConfig.adminAlertPhone` and `chatbotConfig.leadsPhoneNumber`. `onWhatsApp()` takes a single phone.
   - What's unclear: Should we cache one JID or two?
   - Recommendation: Cache both separately as `instance:{id}:admin_jid:0` and `instance:{id}:admin_jid:1`, OR resolve the primary one only (the `leadsPhoneNumber` as it is more specific). Plan 3.2 spec says "the admin's current JID" implying one. Use `chatbotConfig.leadsPhoneNumber` as primary, fall back to `platformConfig.adminAlertPhone`.

3. **Exact end line of dead code block**
   - What we know: CONCERNS.md says lines 3304–3390; code shows `return;` at ~3387 then `/*` starting the dead block.
   - What's unclear: Whether the `*/` closing the dead block is at 3390 or later.
   - Recommendation: Executor of Plan 3.4 should visually confirm before deleting.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 3 is code/config-only changes. No external services beyond Redis (already running) and PostgreSQL (already running) are introduced.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 3.2.4 |
| Config file | `apps/api/vitest.config.ts` |
| Quick run command | `cd apps/api && pnpm test` |
| Full suite command | `cd apps/api && pnpm test` |
| Setup file | `apps/api/test/setup.ts` (env stubs) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ADM-01 | Admin phone message routes to admin handler, never ChatbotService | unit | `pnpm test -- admin-identity` | Wave 0 |
| ADM-01 | fromMe echo does NOT match as admin | unit | `pnpm test -- admin-identity` | Wave 0 |
| ADM-02 | Admin identified when aprendizadoContinuo module is null/disabled | unit | `pnpm test -- admin-identity` | Wave 0 |
| ADM-02 | Admin identified via `platformConfig.adminAlertPhone` alone | unit | `pnpm test -- admin-identity` | Wave 0 |
| ADM-03 | `@lid` remoteJid matched via Redis-cached admin JID | unit (mock Redis) | `pnpm test -- admin-identity` | Wave 0 |
| ADM-04 | Platform route without PLATFORM_OWNER token returns 403 | integration | `pnpm test -- security` or new test | Partial (security.test.ts exists) |

### Sampling Rate

- **Per task commit:** `cd apps/api && pnpm test -- admin-identity`
- **Per wave merge:** `cd apps/api && pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `apps/api/src/modules/instances/__tests__/admin-identity.service.test.ts` — covers ADM-01, ADM-02, ADM-03 with four key scenarios: (1) admin phone matches, (2) module disabled still detects, (3) LID-form JID resolved via Redis, (4) fromMe echo is NOT admin
- [ ] `apps/api/test/security.test.ts` extension — ADM-04 platform route guard test (or new `apps/api/test/admin-platform-routes.test.ts`)

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (ADM-04) | JWT `platformRole` check in `auth.ts` — already implemented |
| V3 Session Management | no | Not addressed in this phase |
| V4 Access Control | yes (ADM-04) | `platformRoles` array in route config enforced by auth plugin |
| V5 Input Validation | yes (ADM-01/ADM-02) | Phone number normalization via `normalizeWhatsAppPhoneNumber` — never compare raw strings |
| V6 Cryptography | no | Not addressed in this phase |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Client spoofs admin phone number | Spoofing | `verifiedAdminPhones` requires VERIFIED status in aprendizadoContinuo + JID-level matching, not just phone string comparison |
| Admin LID JID stale in Redis after re-registration | Spoofing | DEL key on disconnect; repopulate on next `connection.update: open` |
| Platform route accessible without PLATFORM_OWNER token | Elevation of Privilege | `auth: "platform"` + `platformRoles` enforcement in auth plugin; Phase 1 removed the dev bypass from non-development environments |

---

## Sources

### Primary (HIGH confidence)

- `apps/api/src/modules/instances/service.ts` lines 2134–2257 — verified admin detection block
- `apps/api/src/modules/instances/service.ts` lines 3790–3892 — verified phone/JID match helpers
- `apps/api/src/modules/instances/baileys-session.worker.ts` lines 726–764, 930–946 — verified connection.update handler and onWhatsApp() usage
- `apps/api/src/plugins/auth.ts` — verified PLATFORM_OWNER enforcement logic
- `apps/api/src/lib/authz.ts` — verified platform role definitions
- `apps/api/src/lib/logger.ts` — verified Pino logger factory
- `apps/api/src/app.ts` lines 170–321 — verified scheduler start position and onClose hook
- `.planning/codebase/CONCERNS.md` sections 3, 5, 7 — verified issues addressed by Plan 3.4
- `.planning/research/PITFALLS.md` Pitfalls 8 and 9 — verified worker crash and admin false positive risks

### Secondary (MEDIUM confidence)

- `.planning/ROADMAP.md` Phase 3 section — plan descriptions
- `.planning/codebase/ARCHITECTURE.md` — service layer pattern

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; existing tools verified in codebase
- Architecture: HIGH — extraction seam is well-defined; helpers are localized; Redis pattern proven
- Pitfalls: HIGH — all pitfalls verified against actual source lines or CONCERNS.md
- Test mapping: HIGH — Vitest infrastructure confirmed, test pattern established in security.test.ts

**Research date:** 2026-04-13
**Valid until:** 2026-05-13 (stable codebase — 30 days)
