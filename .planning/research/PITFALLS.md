# Domain Pitfalls — Infracode WhatsApp SaaS Platform

**Domain:** Multi-tenant WhatsApp automation SaaS (Fastify + Baileys + BullMQ + PostgreSQL)
**Researched:** 2026-04-10
**Confidence:** HIGH (most pitfalls verified against Baileys GitHub issues, BullMQ docs, OWASP, and CONCERNS.md)

---

## Critical Pitfalls

Mistakes in this category cause data loss, account bans, security breaches, or make the product non-functional for real clients.

---

### Pitfall 1: WhatsApp Account Bans from Automation Behavior

**What goes wrong:** Baileys sends messages in patterns that WhatsApp's spam detection flags — uniform timing, no typing simulation, bursts of identical text, or sudden high-volume messaging on a new number. Accounts are restricted or permanently banned. In a multi-tenant SaaS, one tenant's banned number produces a disconnected instance that never recovers, and if ban detection is silent (which it currently is), the tenant sees no error.

**Why it happens:** Baileys is an unofficial library that reverse-engineers the WhatsApp Web protocol. WhatsApp actively detects non-human messaging patterns. New numbers ("cold" accounts) have no reputation and are banned much faster. The current codebase sends via BullMQ jobs with no inter-message delay enforcement at the delivery layer.

**Consequences:**
- Tenant loses their WhatsApp number permanently — no recovery path.
- SaaS reputation damaged if multiple tenants are banned in a short period.
- No observable signal in current code: worker disconnects silently, instance stays `CONNECTED` in DB (see CONCERNS.md Worker exit bug).

**Warning signs:**
- Instance disconnects shortly after high-volume sends.
- Baileys emits `DisconnectReason.loggedOut` rather than a network-related code.
- Tenant reports "messages sent but not received" before full ban.
- WhatsApp Web on the paired phone shows "This account is not allowed to use WhatsApp" message.

**Prevention strategy:**
1. Enforce a minimum inter-message delay at the BullMQ worker level (1.5–3 seconds between consecutive sends to different JIDs from the same instance). Do not trust callers to space sends correctly.
2. Rate-cap outbound sends per instance per minute in Redis (e.g., max 8/min, 200/hr, 1500/day — community-established safe thresholds).
3. Implement a "warm-up" guard: newly connected instances are capped at 20 messages/day for the first 7 days. Increase gradually.
4. Log every `DisconnectReason` from Baileys with the instance ID and update DB status to `DISCONNECTED` immediately (this also fixes the CONCERNS.md Worker exit bug).
5. Alert the tenant admin and platform owner when `loggedOut` or `accountBanned` disconnect codes are received.

**Which phase should address it:** Phase addressing "Ciclo de Vida da Sessão" and instance reliability. The inter-message delay and rate cap should be added before the first real client onboards.

**Severity if ignored:** CRITICAL — tenant permanently loses their phone number with no recourse. One public ban event damages platform credibility.

---

### Pitfall 2: LID/JID Resolution Failure Corrupts Contact Identity

**What goes wrong:** WhatsApp has been rolling out "hidden IDs" (`@lid`) as an alternative identity system. Baileys surfaces these as the `remoteJid` on incoming messages for affected contacts. The current system already shows `@lid` codes in the CRM instead of real phone numbers — this is the symptom. The deeper problem is that `@lid` values are not phone numbers and cannot be used to send messages via standard JID routing. If the system stores an `@lid` as a contact's phone number, all subsequent sends to that contact will silently fail or reach the wrong destination.

**Why it happens:** WhatsApp's `@lid` is a device-scoped internal identifier. The numeric portion before `@lid` is not a phone number. Mapping between `@lid` and the real `@s.whatsapp.net` JID requires access to `signalRepository.lidMapping` in the Baileys session store. If the mapping table isn't populated at session startup (common with fresh sessions or after session restore), LID contacts cannot be resolved.

**Consequences:**
- CRM displays garbled identifiers to operators.
- Outbound sends to LID contacts silently drop or reach incorrect recipients.
- Lead data is corrupted at ingestion — phone number stored as LID cannot be dialed or matched.
- `targetJid` fix (committed in recent git history) only addresses send routing; the stored phone field remains wrong.

**Warning signs:**
- `remoteJid` in message events contains `@lid` suffix.
- CRM "Phone" column shows numeric strings not matching standard E.164 format.
- Outbound messages to certain contacts show `SENT` but are never received.
- Baileys store `contacts` map has entries with no `name` and a `@lid` JID.

**Prevention strategy:**
1. At message ingestion, always call `signalRepository.getPNForLID(lid)` before storing the JID as a contact identifier. If resolution fails, store the LID in a separate `rawJid` field but do not overwrite `phoneNumber`.
2. Implement a background reconciliation job that periodically tries to resolve stored LID contacts using the current session's mapping store.
3. Display logic must never show raw JID strings — always format through a normalization function that strips server suffix, validates E.164 format, and falls back to a human-readable "Unknown contact" label rather than showing `@lid`.
4. The official Baileys guidance ("migrate to LIDs") means the send path should use the LID when available for sending, but the phone number for display and CRM storage remains the PN.

**Which phase should address it:** The current active CRM phase. This is already listed as a known bug and must be resolved before any client uses the CRM.

**Severity if ignored:** HIGH — contact data is irreversibly corrupted. Operators send documents and contracts to wrong recipients. Trust in the platform is destroyed.

---

### Pitfall 3: Auth State Stored on Filesystem Inside the Repository

**What goes wrong:** WhatsApp session credentials (`creds.json`, signal key files) are stored at `apps/api/apps/api/data/sessions/` — a path inside the project directory. The CONCERNS.md audit confirms live session data is present in the working tree. A `git add .` or an automated CI/CD clone creates a credential leak. Any developer with repo access has full WhatsApp session credentials for all tenants.

**Why it happens:** `useMultiFileAuthState` (or equivalent file-based auth) is the Baileys default and "just works" locally. It was never moved to an isolated volume. The path being nested inside `apps/api/apps/api/` suggests a misconfigured `DATA_DIR` that doubled the path prefix.

**Consequences:**
- Repository clone = full WhatsApp account takeover for every tenant session present at that moment.
- Session files in CI/CD build context. Any public GitHub Actions runner would expose them.
- WhatsApp sessions are single-use — once exported, they can be used from a different machine, logging out the legitimate user.

**Warning signs:**
- `apps/api/data/` is not in `.gitignore`.
- `git status` shows `.../sessions/` directories.
- Docker build context includes the sessions path.
- `DATA_DIR` env var is unset or defaults to a relative path.

**Prevention strategy:**
1. Immediately add `apps/api/data/` to `.gitignore` and verify no session files are tracked (`git ls-files apps/api/data/`). If they are tracked, remove with `git rm -r --cached apps/api/data/`.
2. Set `DATA_DIR` to an absolute path outside the repository (e.g., `/var/data/infracode/sessions`) in all environments.
3. For production: migrate from file-based auth state to database-backed auth state (PostgreSQL table with `instanceId`, `keyType`, `keyId`, `value` columns). Baileys documents this pattern explicitly. This eliminates the filesystem dependency entirely and enables horizontal scaling.
4. Add a startup assertion: if `DATA_DIR` resolves to a path inside the project directory, refuse to start with a clear error.

**Which phase should address it:** Immediately — before any deployment or new developer onboarding. This is a pre-launch blocker.

**Severity if ignored:** CRITICAL — all tenant WhatsApp sessions can be compromised by anyone with repository access.

---

### Pitfall 4: CORS `origin: true` Enables Cross-Site Request Forgery

**What goes wrong:** With `origin: true`, the API reflects any request origin back as `Access-Control-Allow-Origin` and (if credentials mode is enabled) also sets `Access-Control-Allow-Credentials: true`. This means any webpage on any domain can make fully authenticated API requests using a logged-in user's session cookies or stored tokens — the browser will attach them automatically. An attacker's page at `evil.com` can call `POST /instances/:id/messages/send` on behalf of a logged-in tenant admin.

**Why it happens:** `origin: true` is the Fastify CORS plugin shorthand for "allow everything." It is convenient for development and was never tightened for production.

**Consequences:**
- Any malicious link sent to a tenant admin can trigger arbitrary API actions: send messages, delete contacts, change chatbot config, export data.
- If `credentials: true` is also set, this becomes a complete CSRF bypass.
- Even without credentials, reflected CORS with wildcard is flagged by OWASP as a critical misconfiguration and will fail any security audit.

**Warning signs:**
- `apps/api/src/app.ts` contains `origin: true`.
- Browser DevTools shows `Access-Control-Allow-Origin: [attacker-origin]` in API responses.
- Security scanners (OWASP ZAP, Burp Suite) immediately flag this.

**Prevention strategy:**
1. Replace `origin: true` with `origin: process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()) ?? false`.
2. Add `ALLOWED_ORIGINS` to the Zod config schema with no default (fail fast if unset in production).
3. In development, set `ALLOWED_ORIGINS=http://localhost:3000`.
4. In production, set to the panel domain only (e.g., `https://app.infracode.com.br`).
5. Test by making a cross-origin request from a non-listed origin — it must be rejected.

**Which phase should address it:** Security hardening phase, before production launch. One-line fix in `app.ts` plus one env var.

**Severity if ignored:** CRITICAL — full CSRF attack surface on all tenant and admin endpoints. Any attacker who can get a logged-in admin to click a link can take over their WhatsApp instances.

---

### Pitfall 5: Plaintext AI API Keys in Database

**What goes wrong:** `aiFallbackApiKey` is stored and retrieved as plaintext while `aiApiKeyEncrypted` uses AES-256-GCM encryption. Any database read — backup file, misconfigured query, SQL injection, compromised analytics tool — exposes live third-party API keys (Groq, Gemini, etc.) for every tenant who configured a fallback key.

**Why it happens:** The encryption pattern already existed for the primary key. The fallback field was added later and the encryption step was simply omitted.

**Consequences:**
- Third-party API key exposure leads to unexpected billing charges on the tenant's account.
- Groq/Gemini key theft can be used to generate content under the tenant's identity.
- If the key has organization-level permissions, broader account access is possible.
- CONCERNS.md also notes the key is returned in API responses — it is also leaked over the wire to anyone who can read API traffic.

**Warning signs:**
- `chatbot/service.ts` contains `aiFallbackApiKey: input.aiFallbackApiKey?.trim()` without an `encrypt()` call.
- Database `chatbot_config` table shows a readable API key string in the `ai_fallback_api_key` column.
- API response for chatbot config includes the raw key.

**Prevention strategy:**
1. Encrypt on write: replace the trim-only assignment with `encrypt(input.aiFallbackApiKey.trim(), config.API_ENCRYPTION_KEY)`.
2. Decrypt on read: add `decrypt(row.aiFallbackApiKey, config.API_ENCRYPTION_KEY)` in `getConfig()`.
3. Never return decrypted keys in API responses — return a masked value (`sk-...****`) for display only.
4. Run a one-time migration to encrypt existing plaintext rows at deployment time.

**Which phase should address it:** Security hardening phase. The CONCERNS.md "Quick Wins" section already identifies this as a minimal-diff fix.

**Severity if ignored:** HIGH — direct financial and reputational impact on tenants. Discovered during any security audit or breach disclosure.

---

### Pitfall 6: Authentication Bypass Active in Non-Development Environments

**What goes wrong:** When `ENABLE_AUTH` is not explicitly set to `"true"`, the auth plugin assigns `PLATFORM_OWNER` permissions to all requests with a hardcoded actor ID. This bypass is not scoped to `NODE_ENV=development` — a staging, preview, or QA deployment that omits the env var is fully open to anyone who can reach the network.

**Why it happens:** The bypass was added for convenience during development. The guard condition checks `ENABLE_AUTH` rather than `NODE_ENV`, making it easy to accidentally ship to non-development environments.

**Consequences:**
- A misconfigured staging deployment is fully accessible — no auth, all permissions, including platform owner endpoints.
- Preview deployments from CI/CD pipelines (common in Vercel, Render, Railway) may have the bypass active.
- An attacker who discovers the staging URL gets full admin access without credentials.

**Warning signs:**
- `ENABLE_AUTH` not in the required env vars section of deployment config.
- Staging deployment responds to API calls without any Authorization header.
- `apps/api/src/plugins/auth.ts` shows the bypass assigns `PLATFORM_OWNER` role.

**Prevention strategy:**
1. Change the bypass condition to: `if (config.ENABLE_AUTH !== 'true' && config.NODE_ENV === 'development')`. This makes it impossible to activate outside local development.
2. Add `ENABLE_AUTH` to the required env var list for any non-development deployment in CI/CD.
3. Add a startup assertion: if `NODE_ENV !== 'development'` and `ENABLE_AUTH !== 'true'`, log a fatal error and exit.

**Which phase should address it:** Security hardening phase, immediately. This is a pre-launch blocker.

**Severity if ignored:** CRITICAL — complete authentication bypass in any environment that omits the env var. Full platform takeover without credentials.

---

## Moderate Pitfalls

Mistakes in this category cause reliability degradation, data inconsistency, or hard-to-debug production failures.

---

### Pitfall 7: Session Timeout Race Conditions with BullMQ Delayed Jobs

**What goes wrong:** The 10-minute inactivity timeout pattern — schedule a delayed job, cancel it if a message arrives, reschedule — has multiple race conditions in BullMQ. The most dangerous: a new message arrives and triggers the cancellation of the timeout job at the same moment the job transitions from `delayed` to `active`. BullMQ cannot cancel an already-active job. Result: the timeout fires, sends the "Still there?" message, and the session is marked `inativa` — while the customer just sent a message.

A second race: if the API process restarts during the delay window, the in-process session Map is lost. The BullMQ job is still in Redis and will fire correctly, but the handler will find no session in memory and either crash, create a duplicate session, or silently drop the timeout.

**Why it happens:**
- BullMQ's `deduplication` mode with `simple` strategy silently drops a new trigger if a job is already processing. A new message canceling an active timeout job falls into this gap.
- The current `conversationSessions` Map is in-process memory. It does not survive API restarts (CONCERNS.md confirms this).
- BullMQ has a confirmed bug (issue #2876) where job schedulers can create duplicate tasks during crash-loop restarts.

**Warning signs:**
- Customers report receiving "Are you still there?" messages immediately after sending a message.
- Sessions that should be active appear as `inativa` in the database.
- After an API restart, some sessions have no in-memory state but pending BullMQ timeout jobs still fire.
- Multiple timeout messages sent to the same customer for one session.

**Prevention strategy:**
1. Store session state in Redis or PostgreSQL, not only in-process Maps. At minimum, store `lastMessageAt` and `sessionState` in Redis with the instance+JID as key. This survives restarts.
2. When processing a timeout job, always check `lastMessageAt` from Redis before taking action. If a message was received within the last N seconds, skip the timeout action and reschedule.
3. Use BullMQ's `jobId` deduplication with an explicit job ID per session (e.g., `timeout:instanceId:jid`). Removing a job by known ID is more reliable than queue scanning.
4. Handle the "job already active" case explicitly: catch `NotAllowed` / job-not-found errors on removal and do not treat them as fatal.
5. Add an idempotency check before sending the "still there?" message: verify the session is actually in `aguardando_cliente` state in the persistent store.

**Which phase should address it:** The "Ciclo de Vida da Sessão" phase. Must be designed with persistence in mind from the start, not retrofitted.

**Severity if ignored:** HIGH — customers harassed with incorrect inactivity messages. Sessions incorrectly closed lose active conversations. Tenant support load spikes.

---

### Pitfall 8: Worker Thread Crash Leaves Instance in Stale CONNECTED State

**What goes wrong:** When a Baileys worker thread exits with a non-zero code (crash), the InstanceOrchestrator logs it and removes the worker from its Map but does not update the instance status in PostgreSQL to `DISCONNECTED`. The UI shows the instance as `CONNECTED`. Operators believe the instance is working; messages queue up and silently fail; no alert is sent.

**Why it happens:** CONCERNS.md documents this exactly: the `exit` event handler resolves pending RPC requests with 503 but does not call `prisma.instance.update()`. The status remains whatever it was when the worker was healthy.

**Consequences:**
- Silent message delivery failures accumulate in the queue.
- Tenant has no observable signal that their WhatsApp instance is down.
- Auto-reconnect does not trigger because no reconnect logic is wired to the `exit` event (only to Baileys connection events emitted from a live socket).
- In a multi-tenant environment, multiple crashed workers may go unnoticed for hours.

**Warning signs:**
- Worker exit logged but instance status not updated in DB.
- BullMQ `send-message` jobs failing with 503 but no instance status change visible in UI.
- `heartbeat` Redis keys for the instance stop refreshing while DB status remains `CONNECTED`.

**Prevention strategy:**
1. In the `exit` event handler for non-zero exit codes:
   - Update `instance.status = 'DISCONNECTED'` in PostgreSQL immediately.
   - Emit a platform alert via `PlatformAlertService`.
   - Schedule a reconnect attempt with exponential backoff (cap at 5 retries, then require manual intervention).
2. Use the existing Redis heartbeat mechanism as a dead-man's switch: if a heartbeat is missed for more than 2 intervals, mark the instance disconnected from a separate health-check loop.
3. Expose a "last heartbeat" timestamp in the instance status API so the UI can show "Last seen X minutes ago" even if the status is stale.

**Which phase should address it:** The instance reliability / "Ciclo de Vida" phase. Should be addressed before any tenant runs a production instance.

**Severity if ignored:** HIGH — silent operational failures. Tenants miss inbound messages and fail to deliver outbound messages with no observable indicator.

---

### Pitfall 9: Admin Command False Positives — Treating Client Messages as Commands

**What goes wrong:** The admin of a tenant communicates with the system via WhatsApp (the same channel as clients). Admin identification is based on phone number matching against `aprendizadoContinuo.verifiedPhone`. If this check is fragile or misconfigured, clients whose messages happen to match command patterns get treated as admin commands. Conversely, admin messages get treated as client inputs and go through the chatbot pipeline, potentially triggering lead extraction, escalation workflows, or learning feedback loops against the admin's own words.

**Why it happens:** CONCERNS.md flags admin identification as fragile. The `verifiedPhone` field is tied to the `aprendizadoContinuo` module — when that module is disabled, the verification data may not be loaded, causing the admin check to return false for the real admin. Additionally, phone number normalization (E.164 vs. local format vs. JID format) can cause mismatches even when the number is correct.

**Consequences:**
- Admin commands ("envie o contrato para o cliente X") are processed as client requests, extracting "X" as a lead name, routing to FAQ agent, and generating a confused reply.
- Client messages ("pode encerrar") accidentally trigger session management commands.
- If the learning module processes an admin's question as a client question, the system may add it to the knowledge base as something clients ask, polluting future responses.
- Security: if admin commands include sensitive instructions ("send document to user at path X"), a client spoofing the admin number could trigger them.

**Warning signs:**
- Logs show admin JID going through `ChatbotService.process()` instead of the admin path.
- Admin receives automated chatbot responses to their own messages.
- "Escalate to admin" notifications are sent to the admin for messages the admin themselves sent.
- `verifiedPhone` is null or empty in module config when admin identification is checked.

**Prevention strategy:**
1. Decouple admin identification from the `aprendizadoContinuo` module. Store admin phone numbers in a dedicated `TenantAdmin` table (or as a top-level tenant config field). The learning module should read from this central source, not own it.
2. Normalize phone numbers to E.164 at both storage time and comparison time. Use a single utility function everywhere — never compare raw strings from different sources.
3. Admin check should be the first gate in the message processing pipeline, before any chatbot logic runs. If `isAdmin(jid) === true`, route to admin handler and return. Never fall through to chatbot pipeline.
4. Log the admin check result (matched / not-matched / module-disabled) at debug level for every message. This makes false positives immediately visible.
5. When the `aprendizadoContinuo` module is disabled, admin identification must still work. The module's optional flag must not affect this core lookup.

**Which phase should address it:** The "Admin do Tenant via WhatsApp" phase. Admin identity is foundational to all admin command features.

**Severity if ignored:** HIGH — admin commands are a new capability being built. Building it on top of a fragile identity check means every admin action is unreliable. Also a security concern if the admin path has elevated privileges.

---

### Pitfall 10: Continuous Learning Knowledge Contamination

**What goes wrong:** The `aprendizadoContinuo` module asks the admin to answer questions the bot couldn't handle, then incorporates those answers into the knowledge base. This creates several degradation vectors:

1. **Ambiguous admin replies:** The admin says "tell them we're closed on weekends" in response to a question about holiday hours. The system incorporates this as a fact. Next time the question is asked on a Monday, the bot says "we're closed on weekends" — technically true, but contextually wrong.
2. **Conflicting answers:** The admin answers the same question differently on two separate days. Both answers enter the knowledge base. The AI synthesizes them into a contradictory statement.
3. **Admin meta-comments ingested as facts:** The admin replies "I'll handle this one myself" or "this is a weird question" — and the system learns that as an answer to the original question.
4. **Garbage escalation:** Every unanswered question gets escalated. At high volume, admins get notification fatigue and start giving lazy or incorrect answers.

**Why it happens:** There is no validation layer between "admin replied" and "this is now knowledge." The module trusts that any reply to an escalation notification is a valid answer to the original question. Real conversations are more complex — the admin's reply window may overlap with other conversations; they may be replying to a different context.

**Warning signs:**
- Knowledge base grows rapidly with contradictory entries.
- Bot gives different answers to the same question on different days.
- Admin reports "I replied to that but the bot is still saying the wrong thing" or "the bot is saying things I never told it to say."
- Escalation notifications are frequently ignored (>40% non-response rate) — indicator of admin fatigue.

**Prevention strategy:**
1. Add a confirmation step before ingesting admin knowledge: after receiving an admin reply, echo it back as "Got it: [answer]. Should I add this to my knowledge? Reply YES to confirm." This catches meta-comments and mis-contextualized replies.
2. Implement a conflict detection check: before adding new knowledge, run a similarity search against existing knowledge entries. If a conflicting entry exists, alert the admin instead of silently overriding.
3. Limit the escalation window: if an admin does not respond within 4 hours, mark the question as `unanswered` and do not re-ask until the next day. Prevent repeated escalation for the same question pattern.
4. Make all ingested knowledge auditable: log every addition with source (admin JID, original question, admin answer, timestamp). Provide a UI to review and delete incorrect knowledge entries.
5. Apply a confidence threshold: knowledge from a single admin answer starts at LOW confidence. Promote to HIGH only after the admin confirms or after the answer is used successfully N times without client complaint.

**Which phase should address it:** The "Aprendizado Contínuo — Polimento" phase. The confirmation step is the highest-priority addition.

**Severity if ignored:** MEDIUM-HIGH — knowledge base degrades over time. Bot becomes less reliable the longer it runs. Customer complaints increase while the root cause is invisible to operators.

---

### Pitfall 11: Raw SQL Tenant Schema Migrations Cause Silent Schema Drift

**What goes wrong:** Tenant schemas are created and migrated via raw SQL strings in `tenant-schema.ts` using `$executeRawUnsafe`. The file contains 30+ `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements. When a column is added, it is added only to new tenants going forward. Existing tenants who were provisioned before the migration was added do not get the column — unless someone manually runs the migration against their schema. There is no migration history table per tenant, so there is no way to know which tenants have which schema version.

**Why it happens:** This is the "easy path" for multi-tenant schema management — it avoids Prisma migration complexity for dynamic schemas. The `IF NOT EXISTS` guard makes it feel safe. But `IF NOT EXISTS` only prevents errors on re-run; it does not guarantee all tenants have all columns.

**Consequences:**
- Prisma queries against a tenant schema throw `column does not exist` errors for tenants provisioned before a column was added.
- The bug is hard to reproduce in development (dev tenant is always fully current).
- Data saved by one code version cannot be read by the current version for older tenants.

**Warning signs:**
- Prisma errors mentioning specific column names in production but not in development.
- Errors that affect only some tenants, not all.
- The raw SQL file has grown to include `ADD COLUMN IF NOT EXISTS` statements for fields that have been in the codebase for months.

**Prevention strategy:**
1. Add a `schema_migrations` table to every tenant schema at provisioning time, tracking which migration versions have been applied.
2. Implement a `runMigrations(tenantId)` function that checks the migration table and runs only unapplied migrations in order.
3. Run `runMigrations()` on every API startup for all registered tenants (or lazily per-tenant on first access).
4. Until this is built: add a startup check that queries each tenant schema for the most recently added column. Log a critical warning for any tenant missing it.

**Which phase should address it:** Should be addressed in the infrastructure/reliability phase, before the column set grows further. Every new feature that adds a column increases the drift risk.

**Severity if ignored:** HIGH — new features silently fail for long-standing tenants. Hard to diagnose in production. Can corrupt data if code assumes a column exists and falls back incorrectly.

---

## Minor Pitfalls

Known issues that degrade quality but do not cause data loss or security failures.

---

### Pitfall 12: Silent Redis Failures Mask Deduplication Breakdowns

**What goes wrong:** Redis operations for deduplication, anti-spam, and escalation tracking all use `.catch(() => null)` error suppression. If Redis becomes unavailable (restart, OOM, network partition), all these guards silently return "no duplicate found" — so duplicate messages are sent to clients, duplicate escalation notifications go to admins, and rate limits are not enforced. The system continues to "work" but with degraded correctness.

**Prevention:** Replace `.catch(() => null)` with `.catch((err) => { logger.warn({ err }, "redis:op:failed"); return null; })`. Add a Redis health check to the `/health` endpoint. Consider circuit-breaking Redis-dependent flows during outages.

**Which phase:** Quick win — can be done in any phase. CONCERNS.md already flags this.

**Severity if ignored:** MEDIUM — duplicate sends are a trust issue with clients. Admin notification spam causes fatigue.

---

### Pitfall 13: Schedulers Starting Before Server Is Ready

**What goes wrong:** `startSchedulers()` is called inside `buildApp()` before `app.listen()`. If the HTTP server fails to start (port in use, config error), the scheduler intervals are already running and cannot be stopped cleanly because `stopSchedulers()` is not wired to the `onClose` hook.

**Prevention:** Move `startSchedulers()` to after `app.listen()` resolves. Add `stopSchedulers()` to `onClose`.

**Which phase:** Quick win. CONCERNS.md already flags this. One function call move.

**Severity if ignored:** LOW — causes zombie intervals on failed startups. Mainly a development and testing annoyance. Could cause issues in blue-green deployments.

---

### Pitfall 14: Unbounded In-Memory Session Map Under Load

**What goes wrong:** `conversationSessions` is a `Map` that holds full session history objects and grows until the 30-minute GC interval. At 1,000+ concurrent conversations per instance, this becomes significant heap pressure. In a multi-instance, multi-tenant deployment, this scales linearly with instance count.

**Prevention:** Implement an LRU-bounded Map (similar to the existing `TenantPrismaRegistry` pattern already in the codebase). Cap at a configurable maximum (e.g., 500 sessions per instance). Evict LRU sessions to Redis for retrieval if needed.

**Which phase:** The "Ciclo de Vida da Sessão" phase — when the session data model is formalized.

**Severity if ignored:** MEDIUM — memory pressure causes GC pauses and eventual OOM on high-volume instances.

---

### Pitfall 15: API Keys and Tokens in Query String Parameters

**What goes wrong:** The auth plugin accepts `?accessToken=` and `?apiKey=` in query strings. These values appear in: server access logs, browser history, upstream proxy logs, and any third-party analytics or APM tool that captures URLs. A key leaked in a log file is effectively compromised.

**Prevention:** Remove query string auth fallback except for WebSocket upgrade endpoints where header-based auth is architecturally impossible. For WebSockets, scope the query param to the `/ws` upgrade path only.

**Which phase:** Security hardening phase.

**Severity if ignored:** MEDIUM — token leakage via logs is a known attack vector. Less severe than the other security issues but still a compliance concern.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| CRM — LID/JID display | Storing LID as phone number corrupts contact permanently | Normalize at ingestion, not only at display |
| CRM — Contact history pagination | N+1 query explosion as contact count grows | Fix SQL before scaling — already in CONCERNS.md |
| Admin commands via WhatsApp | Admin identified via wrong module dependency | Centralize admin identity, decouple from learning module |
| Ciclo de Vida — 10-min timeout | BullMQ race condition on delayed job cancellation | Use Redis for session state, not in-process Map |
| Ciclo de Vida — session states | Worker crash leaves stale CONNECTED status | Wire status update to worker `exit` event |
| Aprendizado Contínuo | Unvalidated admin answers contaminate knowledge | Add confirmation step before ingestion |
| Tenant schema migrations | Schema drift for older tenants | Migration tracking table per tenant |
| Security hardening | CORS, auth bypass, plaintext keys are pre-launch blockers | Address all three before first real client |
| Production deployment | Session files in repository | Move to volume path, add to .gitignore immediately |
| Instance reliability | Account ban has no observable signal | Log all Baileys DisconnectReason codes, alert on ban codes |

---

## Sources

- Baileys GitHub issues — LID/JID: https://github.com/WhiskeySockets/Baileys/issues/1718 and https://github.com/WhiskeySockets/Baileys/issues/2142
- Baileys production auth state guidance: https://baileys.wiki/docs/intro/ and https://github.com/openclaw/openclaw/issues/9544
- Baileys ban prevention community findings: https://github.com/kobie3717/baileys-antiban and https://github.com/WhiskeySockets/Baileys/issues/1869
- Baileys disconnect issues: https://github.com/WhiskeySockets/Baileys/issues/2337 and https://github.com/WhiskeySockets/Baileys/issues/2110
- BullMQ delayed job drift: https://github.com/taskforcesh/bullmq/issues/2534 and https://github.com/taskforcesh/bullmq/issues/2876
- BullMQ deduplication gap: https://github.com/taskforcesh/bullmq/issues/3427
- OWASP CORS/CSRF: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- CORS Node.js security analysis: https://snyk.io/blog/security-implications-cors-node-js/
- CORS misconfiguration 2026: https://blog.cybersamir.com/cors-misconfiguration-explained-2026/
- Multi-tenant WhatsApp isolation: https://wasenderapi.com/blog/how-to-build-a-white-label-whatsapp-marketing-platform-infrastructure-architecture-guide
- Chatbot knowledge degradation: https://workhub.ai/chatbots-fail-in-customer-service/ and https://dialzara.com/blog/reasons-chatbots-break-fixes
- False positive intent detection: https://dl.acm.org/doi/fullHtml/10.1145/3582768.3582798
- Internal codebase analysis: `.planning/codebase/CONCERNS.md` (2026-04-10)
