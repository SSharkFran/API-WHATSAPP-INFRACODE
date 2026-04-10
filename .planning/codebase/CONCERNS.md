# Codebase Concerns

**Analysis Date:** 2026-04-10

---

## 1. Technical Debt

### [HIGH] Massive `InstanceOrchestrator` god-class
- **Files:** `apps/api/src/modules/instances/service.ts` (5,150 lines)
- **Issue:** A single class handles worker lifecycle, conversation sessions, lead extraction, anti-spam, scheduling alerts, blacklists, escalation routing, audio transcription, and rate limiting. It has 15+ private fields, 3 interval timers, and 5 in-memory Maps acting as ad-hoc state stores.
- **Impact:** Near-impossible to test individual flows in isolation; every change risks cross-feature regression.
- **Fix approach:** Extract into domain-specific services: `ConversationSessionManager`, `LeadProcessor`, `AdminEscalationCoordinator`, `SchedulerService`.

### [HIGH] Tenant schema managed via raw SQL strings
- **Files:** `apps/api/src/lib/tenant-schema.ts` (268 lines)
- **Issue:** The entire tenant schema — 12+ tables, 20+ indexes, and 30+ `ALTER TABLE ADD COLUMN IF NOT EXISTS` migrations — is managed as hardcoded raw SQL strings executed via `$executeRawUnsafe`. There is no migration history or rollback capability.
- **Impact:** Schema drift between tenants is invisible; accidental breaking changes have no safety net.
- **Fix approach:** Migrate to Prisma multi-schema migrations or a versioned migration table per tenant schema.

### [MEDIUM] Commented-out dead code block left in production path
- **Files:** `apps/api/src/modules/instances/service.ts` lines 3304–3390
- **Issue:** A large `/* ... */` block (80+ lines) containing an alternative chatbot dispatch path (`fiadoAgent → conversationAgent → HUMAN_HANDOFF`) is left commented out immediately after the live dispatch call, inside the hot message-processing path.
- **Impact:** Confusing to maintainers; unclear if this is a rollback plan or abandoned code.
- **Fix:** Delete the block or move it to a separate branch/feature flag.

### [MEDIUM] `console.log/warn/error` used directly throughout production code instead of structured logger
- **Files:** `apps/api/src/modules/instances/service.ts` (40+ instances), `apps/api/src/modules/chatbot/service.ts` (10+ instances), `apps/api/src/lib/mail.ts`, `apps/api/src/lib/groq-key-rotator.ts`
- **Issue:** The application has a structured Pino logger injected via Fastify, but large portions of the orchestrator and chatbot service bypass it with raw `console.*` calls, losing request correlation IDs, log levels, and JSON structure.
- **Fix:** Replace all `console.*` calls in service files with the logger or a module-scoped child logger.

### [MEDIUM] `INCOMPLETA-*` internal markers left in source
- **Files:** `apps/api/src/modules/instances/service.ts` lines 2584, 2645, 3259
- **Issue:** Three `// INCOMPLETA-XX:` comments mark code paths that are described as incomplete features.
- **Impact:** Partial implementations shipped to production without tracking in issue management.
- **Fix:** Convert to tracked issues; either complete or explicitly guard with feature flags.

### [LOW] `ChatbotService` also exceeds 3,000 lines
- **Files:** `apps/api/src/modules/chatbot/service.ts` (3,049 lines)
- **Issue:** Combines AI provider management, fallback routing, lead extraction, prompt building, knowledge synthesis, and persistent memory extraction in one class.
- **Fix:** Split into `AiProviderRouter`, `PromptBuilder`, `LeadExtractionService`.

---

## 2. Security Concerns

### [HIGH] CORS configured to allow any origin
- **Files:** `apps/api/src/app.ts` line 191
- **Issue:** `origin: true` reflects the request origin back unconditionally, making CSRF token protection irrelevant and exposing all authenticated endpoints to any website.
- **Impact:** Any malicious site can make cross-origin requests on behalf of logged-in users.
- **Fix:** Set `origin` to an explicit allowlist (e.g., `['https://app.infracode.com.br']`) or read from env.

### [HIGH] Fallback AI API key (`aiFallbackApiKey`) stored unencrypted in database
- **Files:** `apps/api/src/modules/chatbot/service.ts` lines 644–645, 670–671; `apps/api/src/lib/tenant-schema.ts` line 164
- **Issue:** The primary AI key (`aiApiKeyEncrypted`) is encrypted at rest using `API_ENCRYPTION_KEY`, but `aiFallbackApiKey` is stored and read as plaintext. It is saved directly from user input without encryption and returned in API responses.
- **Impact:** Any database read (backup, breach, misconfigured query) exposes third-party API keys.
- **Fix:** Encrypt `aiFallbackApiKey` using the same `encrypt/decrypt` pattern used for `aiApiKeyEncrypted`.

### [MEDIUM] Authentication disabled by default in non-production environments
- **Files:** `apps/api/src/plugins/auth.ts` lines 45–66; `apps/api/src/config.ts` line 63
- **Issue:** When `ENABLE_AUTH` is not `"true"`, the plugin assigns full `PLATFORM_OWNER` permissions to all requests with a hardcoded `actorId` of `"development-bypass"`. This is blocked in production but not in staging or preview environments.
- **Impact:** A staging/preview deployment missing `ENABLE_AUTH=true` is fully open to anyone who can reach the network.
- **Fix:** Require `ENABLE_AUTH=true` in any non-development `NODE_ENV`, or make the bypass opt-in only in `NODE_ENV=development`.

### [MEDIUM] API key and access token accepted as query string parameters
- **Files:** `apps/api/src/plugins/auth.ts` lines 70–71
- **Issue:** `?accessToken=...` and `?apiKey=...` are accepted alongside headers. Query string values appear in server logs, browser history, and are captured in upstream proxy access logs.
- **Impact:** Token leakage via request logs.
- **Fix:** Remove query string fallback; require tokens in headers only. If WebSocket requires it, scope the query param to the WebSocket upgrade endpoint only.

### [LOW] `/metrics` and `/health` endpoints are unauthenticated
- **Files:** `apps/api/src/routes/index.ts` lines 19–57
- **Issue:** Both `GET /health` and `GET /metrics` (Prometheus) respond to all traffic without any authentication. The `/metrics` endpoint exposes internal counters including tenant Prisma cache hit/miss rates and active client counts.
- **Fix:** Protect `/metrics` behind an IP allowlist or a static bearer token checked in the route config.

### [LOW] `/debug/group-jids` endpoint with no auth bypass risk
- **Files:** `apps/api/src/routes/index.ts` lines 59–96
- **Issue:** A debug route returning up to 200 distinct WhatsApp group JIDs is registered in production with `auth: "tenant"` and hidden from Swagger (`hide: true`), but it has no separate feature flag or environment guard.
- **Fix:** Remove or move behind a platform-admin-only guard.

---

## 3. Performance Risks

### [HIGH] CRM contacts pagination uses in-process deduplication instead of SQL
- **Files:** `apps/api/src/modules/crm/routes.ts` lines 60–85
- **Issue:** The contacts list query fetches `(pageSize + skip) * 2` rows (up to hundreds), then deduplicates them in JavaScript memory using a `Set`, then applies `skip/take` manually. This means every page request executes a query that over-fetches up to 200% more rows than needed.
- **Impact:** For tenants with many conversations per contact, page 10 may fetch 800+ rows to return 40.
- **Fix:** Use a `GROUP BY contactId` SQL query or `DISTINCT ON` with proper SQL pagination.

### [MEDIUM] Per-request N+1 memory queries in CRM contacts list
- **Files:** `apps/api/src/modules/crm/routes.ts` lines 76–85
- **Issue:** After loading `N` contacts, the handler executes `N` separate `prisma.clientMemory.findFirst()` queries wrapped in `Promise.all`. For a page of 40 contacts, this is 41 database round-trips.
- **Fix:** Batch-fetch memories with a single `findMany({ where: { phoneNumber: { in: [...] } } })` and join in application code.

### [MEDIUM] Conversation sessions held in-process memory without bounds on active conversations
- **Files:** `apps/api/src/modules/instances/service.ts` lines 257, 329–341
- **Issue:** `conversationSessions` is a `Map` that grows unboundedly between GC ticks (every 30 minutes). A single active instance with 1,000 concurrent conversations will hold all session history objects in the Node.js heap for up to 30 minutes after last activity.
- **Impact:** In multi-tenant deployments with many instances, memory pressure grows proportionally.
- **Fix:** Implement a bounded LRU Map (similar to `TenantPrismaRegistry`) evicting sessions over a configurable cap.

### [LOW] `getHealth()` in admin service loops through all tenants and counts instances
- **Files:** `apps/api/src/modules/admin/service.ts` lines 579–613
- **Issue:** The platform health endpoint iterates every tenant, fetches a Prisma client, and runs `instance.count()` for each — a sequential N-query loop.
- **Fix:** Use a single `GROUP BY tenantId` aggregate query.

---

## 4. Missing Functionality / Incomplete Features

### [HIGH] Email service is a stub — no emails are ever sent
- **Files:** `apps/api/src/lib/mail.ts`
- **Issue:** `EmailService.send()` and `sendTemplate()` both write the email as a JSON log line to `console.info`. No SMTP, SendGrid, or any outbound email transport is wired. Invitations, password resets, and first-access emails are silently swallowed.
- **Impact:** User onboarding flows (invitations, password reset) are non-functional in all environments.
- **Fix:** Integrate an actual email transport. The config schema has `SMTP_FROM` but no `SMTP_HOST`/`SMTP_PORT` — these need to be added and wired into a Nodemailer or Resend client.

### [HIGH] `security` module directory is empty
- **Files:** `apps/api/src/modules/security/` (empty directory)
- **Issue:** The directory exists but contains no files. Implies a planned but unbuilt security module.
- **Impact:** Unknown scope; no planned security controls are active.

### [HIGH] `metrics` module directory is empty
- **Files:** `apps/api/src/modules/metrics/` (empty directory)
- **Issue:** Separate metrics module directory is empty; metrics are handled by `lib/metrics.ts` only.

### [MEDIUM] `aiFallbackApiKey` column saved in `ChatbotConfig` but always set to `null` at save time
- **Files:** `apps/api/src/modules/chatbot/service.ts` lines 631, 657
- **Issue:** The upsert for `ChatbotConfig` always writes `aiApiKeyEncrypted: null`, suggesting the per-tenant AI key feature is unfinished. The field exists in schema and API but the key is never persisted from the current save path.
- **Impact:** Tenants who configure their own AI key may silently fall back to platform keys.

### [LOW] Google Calendar OAuth tokens stored without persistence / refresh token handling
- **Files:** `apps/api/src/modules/chatbot/tools/google-calendar.tool.ts` lines 38–40
- **Issue:** The `OAuth2Client` is constructed per-request from the module config but there is no token refresh persistence or token expiry handling visible in the tool.
- **Impact:** Calendar integrations may silently stop working when tokens expire.

---

## 5. Error Handling Gaps

### [HIGH] Fire-and-forget lead extraction with swallowed encoding error
- **Files:** `apps/api/src/modules/instances/service.ts` lines 4859–4897
- **Issue:** Lead extraction runs in a detached `void (async () => { ... })()` block. The catch handler at line 4887 logs `"[lead] erro na extração:"` but the string has a UTF-8 encoding corruption (`extraÃ§Ã£o`) caused by a source file encoding mismatch, making the log line unreadable in most log viewers.
- **Impact:** Lead extraction failures produce garbled log output; the conversational context is also lost silently.
- **Fix:** Fix file encoding (UTF-8 BOM issue); replace fire-and-forget with a BullMQ job for reliability.

### [MEDIUM] Silent Redis failures masked by `.catch(() => null)`
- **Files:** `apps/api/src/modules/instances/service.ts` (15+ instances), `apps/api/src/modules/chatbot/escalation.service.ts` (10+ instances)
- **Issue:** Redis operations for deduplication, rate limiting, and escalation tracking all catch errors and return `null` silently. A Redis outage would degrade deduplication (duplicate lead sends, duplicate admin alerts) without any observable signal.
- **Fix:** Log the error at warn level before returning null: `.catch((err) => { logger.warn({ err }, "redis op failed"); return null; })`.

### [MEDIUM] Worker exit does not trigger instance reconnect or status update in the orchestrator
- **Files:** `apps/api/src/modules/instances/service.ts` lines 1053–1074
- **Issue:** When a worker thread exits unexpectedly (non-zero code), the orchestrator logs it, resolves pending RPC requests with a 503 error, removes the worker from the map, but does **not** attempt to restart the worker or update the instance status in the database to `DISCONNECTED`.
- **Impact:** An unexpected worker crash leaves the instance in its last known status (e.g., `CONNECTED`) in the DB while the worker is gone, causing UI inconsistency.
- **Fix:** Call `prisma.instance.update({ status: "DISCONNECTED" })` in the `exit` event handler when `code !== 0`.

### [LOW] `void` prefix used on async calls without error handling in route handlers
- **Files:** `apps/api/src/modules/chatbot/routes.ts` lines 420, 443, 541, 608
- **Issue:** `void app.chatbotService.triggerKnowledgeSynthesis(...).catch(() => null)` discards both the promise result and any error silently.
- **Fix:** At minimum, log the error in the `.catch()` handler.

---

## 6. Documentation Gaps

### [MEDIUM] No API documentation for CRM module
- **Files:** `apps/api/src/modules/crm/routes.ts`
- **Issue:** CRM routes have no Swagger `summary` or `description` fields, and the `schema` declarations are missing `response` schemas. All other modules define response schemas.
- **Fix:** Add `summary`, `description`, and `response` Zod schemas to all four CRM endpoints.

### [MEDIUM] Admin impersonation flow is undocumented and lacks audit trail
- **Files:** `apps/api/src/modules/admin/routes.ts` line 329
- **Issue:** The impersonation endpoint is documented as "emite sessao temporaria" but there is no audit log write visible in the service path for impersonation events.
- **Fix:** Add an `AuditLog` entry when an impersonation token is issued.

### [LOW] `RISCO-07` internal risk label in source without documentation
- **Files:** `apps/api/src/modules/instances/service.ts` line 265
- **Issue:** `// RISCO-07:` is a private classification system with no external tracking or explanation of what risks 01–06 are.

---

## 7. Deployment / Ops Concerns

### [HIGH] Tenant session data stored in the repository working directory
- **Files:** `apps/api/apps/api/data/sessions/` (contains live auth directories with UUIDs)
- **Issue:** WhatsApp session authentication files for multiple tenants are stored at `apps/api/apps/api/data/sessions/`, a path inside the project directory structure. This directory appears to contain real session data committed or present in the working tree.
- **Impact:** Repository clones or backups may contain sensitive WhatsApp session keys. A `git add .` mistake would commit credentials.
- **Fix:** Ensure `apps/api/data/` is in `.gitignore`; move session storage to a dedicated volume path set via `DATA_DIR` env var.

### [MEDIUM] Schedulers start during `buildApp()` before the server is listening
- **Files:** `apps/api/src/app.ts` line 143; `apps/api/src/server.ts` lines 7–23
- **Issue:** `instanceOrchestrator.startSchedulers()` is called inside `buildApp()` before `app.listen()`. If `bootstrapPersistedInstances()` throws, the schedulers are already running with no way to stop them cleanly because `app.close()` is called — which runs `onClose` but `stopSchedulers()` is never called from `onClose`.
- **Fix:** Call `startSchedulers()` after `app.listen()` succeeds; add `stopSchedulers()` to the `onClose` hook.

### [MEDIUM] No graceful shutdown for in-flight conversation debounce timers
- **Files:** `apps/api/src/modules/instances/service.ts` — `conversationSessions` Map
- **Issue:** Each `ConversationSession` holds a `debounceTimer: NodeJS.Timeout | null`. The `close()` method on `InstanceOrchestrator` shuts down workers but does not iterate `conversationSessions` to clear pending debounce timers, which can keep the Node.js event loop alive after `app.close()`.
- **Fix:** Add a `conversationSessions.forEach(s => { if (s.debounceTimer) clearTimeout(s.debounceTimer); })` call in `close()`.

### [LOW] `SMTP_FROM` validated as an email address but no SMTP transport configured
- **Files:** `apps/api/src/config.ts` line 48
- **Issue:** Config validates `SMTP_FROM` as an email but there are no `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, or `SMTP_PASS` variables. Any deployment that sets `SMTP_FROM` will get no error on startup while emails silently fail.
- **Fix:** Either remove `SMTP_FROM` from config until the email transport is built, or add the full SMTP config block with validation.

---

## 8. Quick Wins

### [HIGH] Fix UTF-8 encoding corruption in `service.ts` log string
- **Files:** `apps/api/src/modules/instances/service.ts` line 4887
- **Issue:** `"[lead] erro na extraÃ§Ã£o:"` is a mangled UTF-8 string; the file has a local encoding issue at this line.
- **Fix:** Open the file with explicit UTF-8 encoding and re-save the string as `"[lead] erro na extração:"`. 5-minute fix.

### [MEDIUM] Encrypt `aiFallbackApiKey` before persistence
- **Files:** `apps/api/src/modules/chatbot/service.ts` lines 644, 671
- **Issue:** Replace `aiFallbackApiKey: input.aiFallbackApiKey?.trim() || null` with the same `encrypt(value, config.API_ENCRYPTION_KEY)` pattern used for `aiApiKeyEncrypted`. Add a corresponding `decrypt()` call in `getConfig()`.
- **Impact:** Closes the plaintext API key exposure with a minimal diff.

### [MEDIUM] Add `stopSchedulers()` to `onClose` hook in `app.ts`
- **Files:** `apps/api/src/app.ts` lines 249–257
- **Issue:** One-line addition: `await instanceOrchestrator.stopSchedulers()` in the `onClose` hook prevents zombie intervals on graceful shutdown.

### [LOW] Restrict CORS origin
- **Files:** `apps/api/src/app.ts` line 191
- **Issue:** Change `origin: true` to `origin: process.env.ALLOWED_ORIGINS?.split(',') ?? false` and add `ALLOWED_ORIGINS` to the config schema with a sensible default.

### [LOW] Replace silent `.catch(() => null)` on Redis calls with logging
- **Files:** Multiple files (see Error Handling Gaps above)
- **Issue:** A one-line template: `.catch((err) => { logger.warn({ err }, "redis:op:failed"); return null; })` added to all Redis catch handlers would make Redis degradation immediately observable in production logs.

---

*Concerns audit: 2026-04-10*
