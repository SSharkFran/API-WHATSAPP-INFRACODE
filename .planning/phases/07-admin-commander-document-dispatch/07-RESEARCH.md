# Phase 7: Admin Commander & Document Dispatch — Research

**Researched:** 2026-04-20
**Domain:** WhatsApp admin command routing, Baileys document dispatch, audit logging, tenant panel UI
**Confidence:** HIGH (all core claims verified against live codebase)

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CMD-01 | Admin can send prefixed commands (`/contrato`, `/proposta`, `/status`) via WhatsApp | `admin.command` event already emitted in service.ts:2398; `AdminCommandHandler` is the new subscriber |
| CMD-02 | Admin can send natural-language commands — classified by LLM | `AdminCommandService.handleCommand()` already exists with 18 Groq tool-call tools; Phase 7 extends it with document-dispatch tools |
| CMD-03 | Document send command: system identifies client, builds personalized message, sends PDF | Baileys worker already has `case "document"` handler; `resolveMediaBuffer` already supports URL fetch |
| CMD-04 | Message auto-generated with client name and document context | String template interpolation (same pattern as `renderTemplate()` in worker:512) |
| CMD-05 | Log every admin action: who, when, client, document, message, send status | `AdminActionLog` table does NOT exist yet — new migration + new service needed |
| CMD-06 | Admin can ask about system status in free text and receive clear reply | `status_instancia` tool already exists in `AdminCommandService`; `/status` and `/resumo` prefix routes to it |
| DOC-01 | Chatbot can send documents (PDF, contract, proposal) during automated flow | `buildMessageContent` case `"document"` already wired in baileys worker; `DocumentSentEvent` already defined on `InstanceEventBus` |
| DOC-02 | Send via Baileys with explicit `mimetype: 'application/pdf'` and `fileName` | Worker line 556–561 already does this via `resolveMediaBuffer`; `mime-types` package already installed |
| DOC-03 | File referenced by URL — not in-memory buffer for large files | `resolveMediaBuffer` already fetches URL via `fetch(media.url)` (worker:460–469); use local `file://` or absolute path with URL |
| DOC-04 | Max size enforcement: alert if file > 5 MB before sending | Not yet implemented; add `fs.stat` check in document dispatch before calling `sendMessage` |
</phase_requirements>

---

## Summary

Phase 7 builds on top of substantial existing infrastructure. The `AdminCommandService` (at `apps/api/src/modules/chatbot/admin-command.service.ts`) already implements a full Groq tool-calling loop with 18 tools covering status queries, conversation management, and message dispatch. The `InstanceEventBus` already emits `admin.command` events for every admin message. The Baileys worker already handles `document` payloads with URL-based media resolution and `mime-types`.

The primary new work in this phase is: (1) an `AdminCommandHandler` that subscribes to `admin.command` bus events and routes to the existing `AdminCommandService` with new document-dispatch tools; (2) document template lookup from instance config and file-size gating; (3) an `AdminActionLog` table (new migration + write service) to record every action; and (4) a read-only panel page showing the action history.

A critical discovery: the existing `AdminCommandService.handleCommand()` is already called from `service.ts:3390` but only for `isVerifiedAprendizadoContinuoAdminSender` (not all admins identified by `AdminIdentityService`). Plan 7.1 must reconcile this gating — the new `AdminCommandHandler` subscribing to `admin.command` events must be the universal entry point, replacing the inline call site.

**Primary recommendation:** Phase 7 is primarily wiring and extension, not greenfield. The most risky task is the admin routing reconciliation (ensuring ALL admin messages route through `AdminCommandHandler`, never through `ChatbotService.process()`). The `AdminActionLog` table is straightforward via the established migration pattern.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@whiskeysockets/baileys` | `^6.7.18` | WhatsApp document send | Already installed; `sock.sendMessage` with `{document: Buffer}` is the only option |
| `mime-types` | `^3.0.1` | Resolve PDF mimetype | Already installed; avoids hardcoded strings |
| `bullmq` | `^5.58.5` | Queue for async document dispatch | Already used for session timeouts; avoids blocking message pipeline |
| `pino` | `^9.8.0` | Structured logging in all services | Project standard — all new services use it |
| `vitest` | `^4.1.4` | Unit tests | Project standard — `npm test` = `vitest run` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `ioredis` | `^5.7.0` | Redis for admin JID cache lookup | Already used; read cached admin JID for sender verification |
| `zod` | `^3.25.76` | Input validation on new API routes | Already used everywhere for schema validation |
| Node.js `fs/promises` | built-in | File stat for 5 MB size check | Use `stat(filePath).size` before sending |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Buffer-based document send (current) | URL-based Baileys send (`{document: {url: ...}}`) | Roadmap says use URL; but codebase already resolves URL to Buffer via `resolveMediaBuffer` — no behavior change needed, just pass correct path |
| `pdfkit` | `@react-pdf/renderer` | `pdfkit` = Node-only, simpler for server-side; `@react-pdf/renderer` = React components, better for complex layouts. DOC-01 does NOT require personalized PDF generation (templates are pre-existing files) — no PDF library needed this phase |
| Inline AdminCommandService call (current) | Event bus subscriber pattern | Event bus is the established decoupling pattern (Phase 4.4); inline call is the legacy anti-pattern to eliminate |

**Installation:** No new packages needed. `mime-types` is already installed.

---

## Architecture Patterns

### Recommended Project Structure
```
apps/api/src/modules/instances/
├── admin-command.handler.ts    # NEW — subscribes to admin.command bus event
├── admin-action-log.service.ts # NEW — writes AdminActionLog rows
├── admin-identity.service.ts   # EXISTING — Phase 3 product
├── service.ts                  # EXISTING — emit admin.command, remove inline handleCommand call
apps/api/src/lib/
├── run-migrations.ts           # ADD migration for AdminActionLog table
apps/panel/app/(tenant)/tenant/
├── historico-acoes/            # NEW — action history panel page
│   └── page.tsx
```

### Pattern 1: AdminCommandHandler subscribes to InstanceEventBus
**What:** A dedicated class subscribes to `admin.command` events from `InstanceEventBus`, parses prefix commands (Tier 1) or routes to `AdminCommandService.handleCommand()` (Tier 2).
**When to use:** Every admin message that arrives as an `admin.command` event.
**Example:**
```typescript
// Source: apps/api/src/lib/instance-events.ts (AdminCommandEvent interface)
export class AdminCommandHandler {
  constructor(private deps: AdminCommandHandlerDeps) {
    deps.eventBus.on('admin.command', (e) => {
      const event = e as AdminCommandEvent;
      setImmediate(() => void this.handle(event).catch(err =>
        deps.logger.warn({ err }, '[AdminCommandHandler] error')
      ));
    });
  }

  private async handle(event: AdminCommandEvent): Promise<void> {
    const text = event.command?.trim() ?? '';
    // Tier 1: prefix matching
    if (text.startsWith('/status')) { await this.handleStatusCommand(event); return; }
    if (text.startsWith('/resumo')) { await this.handleResumoCommand(event); return; }
    if (/^\/contrato\s+/i.test(text)) { await this.handleDocumentCommand(event, 'contrato'); return; }
    if (/^\/proposta\s+/i.test(text)) { await this.handleDocumentCommand(event, 'proposta'); return; }
    if (/^\/encerrar\s+/i.test(text)) { await this.handleEncerrarCommand(event); return; }
    // Tier 2: LLM free-text via existing AdminCommandService
    await this.deps.adminCommandService.handleCommand({
      tenantId: event.tenantId,
      instanceId: event.instanceId,
      text,
      adminPhone: event.fromJid,
      sendResponse: this.makeSendResponse(event),
      sendMessageToClient: this.makeSendMessageToClient(event),
    });
  }
}
```

### Pattern 2: Document Dispatch via existing Baileys worker path
**What:** Document send flows through `InstanceOrchestrator.sendMessage()` with `type: 'document'` — the worker already handles this. No new Baileys socket access needed.
**When to use:** Every document send triggered by admin command.
**Example:**
```typescript
// Source: apps/api/src/modules/instances/baileys-session.worker.ts:556-561
// Existing handler — NO CHANGES NEEDED in worker
case "document":
  return {
    document: await resolveMediaBuffer(payload.media),
    mimetype: payload.media.mimeType,
    fileName: payload.media.fileName ?? "documento"
  };

// New dispatch code in AdminCommandHandler:
// 1. Stat the file (DOC-04 gating)
const { size } = await stat(filePath);
if (size > 5 * 1024 * 1024) {
  await sendResponse(`⚠️ Arquivo excede 5 MB — verifique o documento antes de enviar`);
  return;
}
// 2. Send via InstanceOrchestrator.sendMessage (goes through worker, not direct sock)
await deps.instanceOrchestrator.sendMessage(tenantId, instanceId, {
  to: contactJid,
  type: 'document',
  media: {
    url: `file://${absoluteFilePath}`,   // resolveMediaBuffer handles file:// or http://
    mimeType: mime.lookup(filePath) || 'application/pdf',
    fileName: `Contrato - ${clientName}.pdf`,
    caption: `Olá ${clientName}, segue o ${documentType} conforme combinado.`,
  }
});
```

**CRITICAL FINDING:** `resolveMediaBuffer` only handles `base64` or HTTP `url` (via `fetch()`). A `file://` URL will NOT work with `fetch()`. The document dispatch must either:
- Option A: Read the file to Buffer with `fs.readFile()` and encode as base64 before calling `sendMessage`
- Option B: Extend `resolveMediaBuffer` to handle `file://` paths by detecting the protocol

Option A (base64) is simpler and avoids touching the worker. The 5 MB check still happens before encoding. [VERIFIED: codebase inspection of baileys-session.worker.ts:455-472]

### Pattern 3: AdminActionLog via Migration + Direct Raw SQL
**What:** New `AdminActionLog` table added via versioned migration in `run-migrations.ts`. Writes done via `$executeRawUnsafe` (same pattern as all tenant schema writes — no Prisma schema for this table yet).
**When to use:** After every admin command is processed (success or failure).

### Pattern 4: Panel Page follows Existing Metrics Pattern
**What:** The `historico-acoes/page.tsx` follows the same `async function Page()` Server Component pattern as `metrics/page.tsx`, calling a `getTenantActionHistory()` function in `panel/lib/api.ts`.
**When to use:** The action history read path.

### Anti-Patterns to Avoid
- **Calling `sock.sendMessage()` directly from AdminCommandHandler:** The Baileys socket lives in a worker thread — it is only accessible via `InstanceOrchestrator.sendMessage()` RPC. Never reach for `sock` outside the worker.
- **Bypassing `AdminIdentityService` for command authorization:** All `admin.command` events are already gated behind `isAdminOrInstanceSender` in `service.ts:2247`. Do NOT add a second identity check in `AdminCommandHandler` — trust the event bus gate.
- **Keeping the inline `adminCommandService.handleCommand()` call at service.ts:3390:** This legacy call site only runs for `isVerifiedAprendizadoContinuoAdminSender` (a subset of admins). After Plan 7.1, the event bus subscriber is the universal handler. The legacy call site must be removed.
- **PDF generation in Phase 7:** The roadmap says "decide between pdfkit and @react-pdf/renderer at phase start". The answer is: neither. Phase 7 sends pre-existing template files from disk. PDF generation is a Phase 8+ concern.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Groq LLM free-text classification | Custom classifier | `AdminCommandService.handleCommand()` (already built) | 18-tool Groq tool-call loop already exists |
| MIME type detection | `if (ext === 'pdf') return 'application/pdf'` | `mime.lookup(filePath)` from `mime-types` (already installed) | Handles all file types, covers edge cases |
| Admin message routing | New if/else blocks in service.ts | `InstanceEventBus` `admin.command` event subscription | Decoupling seam established in Phase 4.4 |
| Metrics aggregation for `/status` | New SQL queries | `status_instancia` tool in `AdminCommandService` + `getTodayMetrics()` in tenant service | Already implemented in Phase 6 |
| File fetch for URL media | Custom fetch wrapper | `resolveMediaBuffer()` already in worker | Battle-tested with 20s timeout |
| Tenant schema migration | Manual ALTER TABLE | `MIGRATIONS[]` array in `run-migrations.ts` | Auto-applied on startup for all tenants |

**Key insight:** This phase is primarily wiring 4 independent capabilities that are mostly already built. The trap is rebuilding things that exist.

---

## Common Pitfalls

### Pitfall 1: Legacy inline adminCommandService call not removed
**What goes wrong:** Admin messages get processed TWICE — once by the legacy call at service.ts:3390 (for `isVerifiedAprendizadoContinuoAdminSender`) and once by the new event bus subscriber.
**Why it happens:** The Phase 4.4 event bus wiring emits `admin.command` for ALL `isAdminOrInstanceSender` (service.ts:2397), but the old inline call is a more restrictive subset handler that was never removed.
**How to avoid:** In Plan 7.1, explicitly remove the inline `adminCommandService.handleCommand()` block at service.ts:3388–3421 after confirming the event bus handler covers it.
**Warning signs:** Admin receives duplicate responses; metrics show double command execution.

### Pitfall 2: `file://` URL in resolveMediaBuffer fails silently
**What goes wrong:** Admin sends `/contrato João` — command succeeds but João never receives the PDF.
**Why it happens:** `resolveMediaBuffer` calls `fetch(media.url)` — Node's `fetch` does not support `file://` protocol by default.
**How to avoid:** Use `fs.readFile()` + base64 encode OR send `{ base64: data.toString('base64') }` in the media payload. Verify with a test that actually calls `resolveMediaBuffer` with a file path.
**Warning signs:** `Falha ao baixar midia: TypeError: Failed to parse URL` in logs.

### Pitfall 3: AdminActionLog migration version collision
**What goes wrong:** Migration fails on startup because a version string conflicts with an existing migration.
**Why it happens:** Last migration in `run-migrations.ts` is `2026-04-19-041-contact-phone-nullable`. The new migrations for `AdminActionLog` and `ConversationMetric` must use a date after `2026-04-19`.
**How to avoid:** Use `2026-04-20-042-admin-action-log` as the next version. Increment the sequence number (042, 043...) for each migration.
**Warning signs:** `Migration infrastructure failed for tenant` on startup.

### Pitfall 4: Contact name lookup returns multiple results
**What goes wrong:** Admin sends `/contrato João` — system finds 3 contacts named João and either errors or sends to the wrong one.
**Why it happens:** Name search on `contact.displayName` is fuzzy; multiple matches are common.
**How to avoid:** When multiple contacts match, respond to admin with a disambiguation list: "Encontrei 3 contatos com esse nome: João Silva (+55 11...), João Oliveira (+55 21...). Qual deles?". Do not auto-select silently.
**Warning signs:** Document sent to wrong client; no disambiguation flow.

### Pitfall 5: AdminActionLog write blocks message pipeline
**What goes wrong:** Slow DB write in `AdminActionLog` delays the admin's response by 500ms+.
**Why it happens:** Synchronous `await prisma.$executeRawUnsafe(INSERT)` inside the command handler.
**How to avoid:** Use `setImmediate()` or a fire-and-forget pattern for the audit log write (same pattern as `SessionMetricsCollector`). Log write errors via `logger.warn` — never bubble them to the admin.
**Warning signs:** Admin command response latency increases; DB write errors crash commands.

### Pitfall 6: Document size check after Buffer allocation
**What goes wrong:** A 10 MB PDF is read into memory, THEN the size check fails — wasting memory and time.
**Why it happens:** Check implemented after `readFile()` call.
**How to avoid:** Use `fs.stat(filePath).size` BEFORE reading the file. Check size first, reject, then never read.
**Warning signs:** Memory spikes before "file too large" error appears.

---

## Code Examples

Verified patterns from live codebase:

### AdminActionLog migration entry (follow established pattern)
```typescript
// Source: apps/api/src/lib/run-migrations.ts (pattern from existing entries)
{
  version: "2026-04-20-042-admin-action-log",
  description: "Create AdminActionLog table for Phase 7 audit trail",
  sql: (schema) => `
    CREATE TABLE IF NOT EXISTS ${quoteSchema(schema)}."AdminActionLog" (
      "id" TEXT PRIMARY KEY,
      "triggeredByJid" TEXT NOT NULL,
      "actionType" TEXT NOT NULL,
      "targetContactJid" TEXT,
      "documentName" TEXT,
      "messageText" TEXT,
      "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `
},
{
  version: "2026-04-20-043-admin-action-log-index",
  description: "Index AdminActionLog by createdAt for panel queries",
  sql: (schema) =>
    `CREATE INDEX IF NOT EXISTS "idx_${schema}_admin_action_log_created"
     ON ${quoteSchema(schema)}."AdminActionLog" ("createdAt" DESC);`
},
```

### Emitting document.sent event (already defined in event bus)
```typescript
// Source: apps/api/src/lib/instance-events.ts (DocumentSentEvent interface)
// After successful document send:
this.eventBus.emit('document.sent', {
  type: 'document.sent',
  tenantId,
  instanceId,
  remoteJid: contactJid,
  sessionId: null,  // session may not exist for admin-initiated sends
});
```

### Admin command event structure (live in production)
```typescript
// Source: apps/api/src/modules/instances/service.ts:2397-2404
// Already emitted — AdminCommandHandler subscribes to this:
if (isAdminOrInstanceSender) {
  this.eventBus.emit('admin.command', {
    type: 'admin.command',
    tenantId,
    instanceId: instance.id,
    command: rawTextInput,
    fromJid: event.remoteJid,
  });
}
```

### File size check before document send
```typescript
// Source: Node.js built-in (no library needed)
import { stat } from 'node:fs/promises';

const MAX_DOC_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const { size } = await stat(filePath);
if (size > MAX_DOC_SIZE_BYTES) {
  await sendResponse(
    `⚠️ Arquivo excede 5 MB (${(size / 1024 / 1024).toFixed(1)} MB) — verifique o documento antes de enviar`
  );
  return;
}
```

### Document send via base64 (workaround for file:// limitation)
```typescript
// Source: apps/api/src/modules/instances/baileys-session.worker.ts:455-458 (resolveMediaBuffer)
// resolveMediaBuffer handles base64 directly — use this for local files:
import { readFile } from 'node:fs/promises';
import mime from 'mime-types';

const fileBuffer = await readFile(absoluteFilePath);
const base64 = fileBuffer.toString('base64');
const mimeType = mime.lookup(absoluteFilePath) || 'application/pdf';

await deps.instanceOrchestrator.sendMessage(tenantId, instanceId, {
  to: contactJid,
  type: 'document',
  media: {
    base64,
    mimeType,
    fileName: `Contrato - ${clientName}.pdf`,
    caption: `Olá ${clientName}, segue o ${documentType} conforme combinado.`,
  }
});
```

### Panel action history page (follow metrics page pattern)
```typescript
// Source: apps/panel/app/(tenant)/tenant/metrics/page.tsx (exact pattern to follow)
export const dynamic = "force-dynamic";

export default async function TenantActionHistoryPage() {
  const history = await getTenantActionHistory();
  // ... render table
}
```

---

## Runtime State Inventory

> Rename/refactor phase detection: NOT applicable. This is a greenfield capability phase.

None — no existing runtime state, stored keys, or OS-registered state references Phase 7 concepts. The `AdminActionLog` table is a new table; no existing data needs migration.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Inline `adminCommandService.handleCommand()` in service.ts | Event bus subscriber pattern | Phase 4.4 introduced the bus; Phase 7 completes the migration | Eliminates direct coupling; admin routing is now observable |
| Direct `sock.sendMessage()` calls | `InstanceOrchestrator.sendMessage()` RPC via worker thread | Architecture from project start | Admin code never needs socket access |
| Hard-coded `aprendizadoContinuo` guard for admin commands | `isAdminOrInstanceSender` from `AdminIdentityService` | Phase 3 extraction | All admins identified, not just learning module admins |

**Deprecated/outdated:**
- `isVerifiedAprendizadoContinuoAdminSender` as gate for `adminCommandService.handleCommand()`: This was a legacy guard. Phase 7 replaces it with the universal event bus handler.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Document templates are pre-existing PDF files on disk (no generation needed) | Standard Stack | If personalized PDF generation is required, `pdfkit` must be added — adding ~2 days of work |
| A2 | `file://` URLs are not supported by Node's built-in `fetch()` | Common Pitfalls, Code Examples | If Node 22+ added `file://` support, base64 encoding workaround is unnecessary but harmless |
| A3 | Document template config lives in `chatbotConfig` JSONB (instance config, not a separate table) | Architecture Patterns | If templates need a dedicated table, a new migration is needed |

---

## Open Questions

1. **Where are document templates stored?**
   - What we know: `chatbotConfig.aiSettings` is a JSONB field; instance config has JSONB columns
   - What's unclear: Is there an existing `documentTemplates` config key, or does Plan 7.2 define the schema?
   - Recommendation: Plan 7.2 should define the config structure (e.g., `chatbotConfig.modules.documentDispatch.templates: [{name, filePath, caption}]`) and add a migration to persist it.

2. **Should `AdminCommandHandler` run in-process or as a separate module?**
   - What we know: All other services (`SessionLifecycleService`, `SessionMetricsCollector`) are in-process event bus subscribers
   - What's unclear: Nothing — follow the established pattern
   - Recommendation: In-process, same as all other event bus subscribers.

3. **Should `/status` and `/resumo` bypass the Groq call and respond directly?**
   - What we know: `status_instancia` tool exists in `AdminCommandService`; calling Groq for a simple status command adds ~500ms latency
   - What's unclear: Whether the admin prefers the Groq-mediated response (with nicer formatting) or a direct response
   - Recommendation: Tier 1 prefix commands (`/status`, `/resumo`) skip Groq and call the data layer directly. This matches the CMD-01 design intent ("explicit commands").

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `mime-types` | DOC-02 mimetype lookup | Yes | `^3.0.1` | — (already in package.json) |
| `fs/promises` (Node built-in) | DOC-04 file size check | Yes | Node 22 | — |
| Groq API | CMD-02 LLM classification | Yes | via `GroqKeyRotator` (existing) | Falls back to `FALLBACK: OUTRO` classification |
| Redis | Admin JID cache read | Yes | via `ioredis ^5.7.0` | — |
| PostgreSQL tenant schema | AdminActionLog writes | Yes | via `TenantPrismaRegistry` | — |

**Missing dependencies with no fallback:** None.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.4 |
| Config file | `apps/api/vitest.config.ts` |
| Quick run command | `cd apps/api && npm test -- --run` |
| Full suite command | `cd apps/api && npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CMD-01 | Prefix `/status` returns status response | unit | `vitest run src/modules/instances/__tests__/admin-command.handler.test.ts` | ❌ Wave 0 |
| CMD-01 | Prefix `/contrato João` triggers document dispatch | unit | same | ❌ Wave 0 |
| CMD-02 | Free-text "como estamos?" routes to AdminCommandService | unit | same | ❌ Wave 0 |
| CMD-03 | Document send: finds contact, sends PDF with personalized caption | unit | same | ❌ Wave 0 |
| CMD-04 | Caption contains `{clientName}` substituted correctly | unit | same | ❌ Wave 0 |
| CMD-05 | AdminActionLog row written after every command | unit | `vitest run src/modules/instances/__tests__/admin-action-log.service.test.ts` | ❌ Wave 0 |
| CMD-06 | `/status` returns connected status + session count | unit | `vitest run src/modules/instances/__tests__/admin-command.handler.test.ts` | ❌ Wave 0 |
| DOC-01 | `document.sent` event emitted after document dispatch | unit | same | ❌ Wave 0 |
| DOC-02 | `mimeType` is `'application/pdf'` not hardcoded | unit | same | ❌ Wave 0 |
| DOC-03 | Local file read as base64 (not in-memory HTTP buffer) | unit | same | ❌ Wave 0 |
| DOC-04 | File > 5 MB aborts send and alerts admin | unit | same | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cd apps/api && npm test -- --run`
- **Per wave merge:** `cd apps/api && npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/api/src/modules/instances/__tests__/admin-command.handler.test.ts` — covers CMD-01, CMD-02, CMD-03, CMD-04, CMD-06, DOC-01, DOC-02, DOC-03, DOC-04
- [ ] `apps/api/src/modules/instances/__tests__/admin-action-log.service.test.ts` — covers CMD-05

*(Both test files must be created in Wave 0 before any implementation. Follow exact pattern of `session-metrics-collector.test.ts` and `daily-summary.service.test.ts` for mock setup.)*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | `AdminIdentityService` is the gate — all `admin.command` events already verified |
| V3 Session Management | no | N/A |
| V4 Access Control | yes | Event bus only emits `admin.command` after `isAdminOrInstanceSender` confirmed (service.ts:2247) |
| V5 Input Validation | yes | Prefix commands: regex match; LLM path: `AdminCommandService` already validates tool args; contact name: sanitize before DB query |
| V6 Cryptography | no | No new encrypted fields |

### Known Threat Patterns for WhatsApp Admin Commands

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Client spoofing admin commands | Spoofing | `AdminIdentityService.resolve()` gate before `admin.command` emitted — already in place |
| Path traversal via document filename | Tampering | Validate `filePath` is within configured `DATA_DIR`; reject paths with `../` |
| LLM prompt injection via client name | Tampering | `AdminCommandService` already uses `<message>` delimiters (same pattern as `classifyIntent`); contact names from DB, not free text |
| 5 MB bypass via race condition | Tampering | Check size immediately before reading; use a single atomic read sequence |
| Admin action log forgery | Repudiation | Log `fromJid` from the verified event (not from the text body); JID is source-of-truth |

---

## Sources

### Primary (HIGH confidence)
- Live codebase — `apps/api/src/modules/chatbot/admin-command.service.ts` (full 1,515-line file read)
- Live codebase — `apps/api/src/lib/instance-events.ts` (AdminCommandEvent, DocumentSentEvent interfaces)
- Live codebase — `apps/api/src/modules/instances/service.ts` lines 2397-2404 (admin.command emit), 3388-3421 (legacy inline call)
- Live codebase — `apps/api/src/modules/instances/baileys-session.worker.ts` lines 455-561 (resolveMediaBuffer, buildMessageContent)
- Live codebase — `apps/api/src/lib/run-migrations.ts` (migration pattern, last version = 041)
- Live codebase — `apps/api/src/lib/tenant-schema.ts` (ConversationSession baseline table — no AdminActionLog yet)
- Live codebase — `apps/api/package.json` (dependencies: mime-types ^3.0.1 confirmed)
- Live codebase — `apps/api/vitest.config.ts` (test framework config)

### Secondary (MEDIUM confidence)
- Node.js docs: `fs/promises.stat()` returns `size` in bytes — used for DOC-04 size check [ASSUMED from training — standard Node API, no change since Node 14]

### Tertiary (LOW confidence)
None — all claims verified directly against codebase.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified against live `package.json`
- Architecture: HIGH — all patterns verified against live codebase files
- Pitfalls: HIGH — pitfall 1/2/3 verified by reading actual code; pitfall 4/5/6 based on established patterns

**Research date:** 2026-04-20
**Valid until:** 2026-05-20 (stable stack; low churn)
