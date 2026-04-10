# Technology Stack Research — Production Hardening

**Project:** Infracode WhatsApp SaaS CRM
**Milestone:** Production quality finalization
**Researched:** 2026-04-10
**Overall confidence:** MEDIUM-HIGH

This is a subsequent milestone. The core stack (TypeScript, Fastify, Next.js, BullMQ, Redis,
PostgreSQL, Prisma, Baileys) is already decided and is not re-evaluated here. This document
covers the four open technical questions that inform how to build the missing features correctly.

---

## Area 1: Session Lifecycle State Machine

### Recommendation: Pure TypeScript enum + BullMQ deduplication. No XState.

**Rationale:**

The session lifecycle has five states: `ativa`, `aguardando_cliente`, `confirmacao_enviada`,
`encerrada`, `inativa`. This is a simple linear flow with two timed transitions (10-minute
inactivity, confirmation timeout). It does not require a general-purpose state machine library.

XState v5 is excellent for complex state charts with parallel states, guards, and actions — but
it adds ~50 KB, a new programming model that is foreign to this codebase, and significant
conceptual overhead for what amounts to a small enum with two BullMQ delayed jobs. Confidence:
HIGH that XState is overkill here.

### Session State in PostgreSQL

Store the session state as a typed enum column on the `Sessao` (or `Session`) table in the
tenant schema. Add `startedAt`, `endedAt`, `lastActivityAt`, and `durationSeconds` columns on
the same record. This is the source of truth.

```sql
CREATE TYPE session_status AS ENUM (
  'ativa',
  'aguardando_cliente',
  'confirmacao_enviada',
  'encerrada',
  'inativa'
);
```

```typescript
// packages/types/src/session.ts
export type SessionStatus =
  | 'ativa'
  | 'aguardando_cliente'
  | 'confirmacao_enviada'
  | 'encerrada'
  | 'inativa';

export const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  ativa:                ['aguardando_cliente', 'encerrada'],
  aguardando_cliente:   ['ativa', 'confirmacao_enviada', 'encerrada'],
  confirmacao_enviada:  ['ativa', 'inativa', 'encerrada'],
  encerrada:            [],
  inativa:              ['ativa'],
};

export function isValidTransition(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}
```

In-memory state (which session is currently open per contact) is NOT kept in the
`InstanceOrchestrator` Map. It is always read from PostgreSQL. The Map already tracks running
Worker Threads — adding per-contact session state there would make the god-class worse.

### Timeout Handling via BullMQ Deduplication (Debounce Pattern)

BullMQ v5 has a native deduplication feature with `extend: true` and `replace: true` options.
This is exactly the pattern needed for inactivity timeouts that reset on each new message.

```typescript
// When a message arrives on an active session:
await sessionTimeoutQueue.add(
  'session-inactivity-check',
  { tenantId, instanceId, contactJid, sessionId },
  {
    deduplication: {
      id: `session-timeout:${sessionId}`,
      ttl: 10 * 60 * 1000,    // 10 minutes — matches the TTL
      extend: true,            // Resets the clock on each new activity
      replace: true,           // Overwrites stale data with current message context
    },
    delay: 10 * 60 * 1000,    // Process 10 minutes after last activity
  },
);
```

When this job finally fires (no activity for 10 minutes):
1. Read current session status from DB
2. If status is `ativa` or `aguardando_cliente`: transition to `aguardando_cliente`, send
   confirmation message, enqueue a second smaller delayed job for the confirmation timeout
   (e.g., 5 minutes) — then if no reply, transition to `inativa`
3. Update `lastActivityAt` and `status` in DB

**Known BullMQ issue to watch:** Issue #2534 (delayed jobs not moving to waiting after several
days) and the `Missing lock for job ... moveToDelayed` error (Issue #3295) are real but rare.
Mitigation: keep `commandTimeout` at 30 000 ms and ensure the BullMQ worker is always running
(dedicated process or at minimum the existing `@infracode/worker`).

Do NOT use `job.changeDelay()` for resetting timeouts. It requires scanning `getDelayed()` to
find the job by data, which is O(n) and breaks at scale. The deduplication approach is O(1).

### No In-Memory Session State

Do not store `activeSession: Map<contactJid, SessionStatus>` anywhere in process memory. This
state is lost on every API restart (which happens during deploys). PostgreSQL is the session
store. Redis is only for the BullMQ queue backend, not for session state storage.

---

## Area 2: Extracting Domain Logic from InstanceOrchestrator

### Recommendation: Domain Events via Node.js EventEmitter + typed event bus. Strangler Fig
applied at the method boundary, not at the service boundary.

**Rationale:**

The Strangler Fig at the service boundary (new `SessionService`, `AdminCommandService`, etc.
talking to `InstanceOrchestrator` via REST calls or process messages) is architecturally correct
for microservices but is overkill here — you are not extracting to separate processes. The target
is a better-organized monolith within the same API process.

The right pattern for a 5 000-line service in a TypeScript monorepo is:

1. **Identify seams** — lines in the file where responsibility clearly changes. In
   `InstanceOrchestrator` these are: session lifecycle logic, admin command handling, document
   sending, daily summary dispatch, and inbound message routing.

2. **Extract to dedicated classes, not files.** Create `SessionManager`, `AdminCommandHandler`,
   `DocumentSender` as classes that receive their dependencies via constructor injection, the same
   pattern already used by `AuthService`, `ChatbotService`, etc.

3. **Wire through a typed EventEmitter** — `InstanceOrchestrator` emits typed domain events
   rather than calling extracted services directly. This breaks the coupling without requiring the
   orchestrator to know about the extracted services.

### Typed Event Bus Pattern

```typescript
// apps/api/src/lib/instance-events.ts
import { EventEmitter } from 'node:events';

export interface InstanceEvents {
  'message.inbound': {
    tenantId: string;
    instanceId: string;
    contactJid: string;
    message: WAMessage;
    isAdmin: boolean;
  };
  'session.activity': {
    tenantId: string;
    instanceId: string;
    contactJid: string;
    sessionId: string;
  };
  'session.close_intent_detected': {
    tenantId: string;
    instanceId: string;
    contactJid: string;
    sessionId: string;
    utterance: string;
  };
  'admin.command': {
    tenantId: string;
    instanceId: string;
    rawText: string;
    adminJid: string;
  };
}

// Type-safe wrapper around Node.js EventEmitter
export class InstanceEventBus extends EventEmitter {
  emitTyped<K extends keyof InstanceEvents>(event: K, payload: InstanceEvents[K]): boolean {
    return this.emit(event, payload);
  }

  onTyped<K extends keyof InstanceEvents>(
    event: K,
    listener: (payload: InstanceEvents[K]) => void,
  ): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }
}
```

### Extraction Sequence (Safest Order)

Phase 1 — No behavioral change, just reorganize:
- Move all session state DB read/write into `SessionManager` class
- `InstanceOrchestrator` still holds the only instance of `SessionManager`
- No external callers change

Phase 2 — Wire EventEmitter:
- `InstanceOrchestrator` emits `session.activity` on every inbound message
- `SessionManager` subscribes and handles timeout job upsert
- Existing direct calls removed from orchestrator one by one

Phase 3 — Extract `AdminCommandHandler`:
- After Phase 1 and 2 are stable in production

**Never do:** Rename the `InstanceOrchestrator` class or move the file in Phase 1 or 2. Import
paths across the entire codebase refer to it. Rename only after all callers go through the event
bus or through the extracted service interfaces.

### The "Shadow" Technique for Validation

Before cutting over to extracted logic, run both the old and new code path in parallel, log
disagreements, and assert they produce identical DB writes for 1–2 days in staging. Only then
remove the old path. This is well-established for this style of incremental refactoring.

---

## Area 3: Admin-as-System-Interface via WhatsApp

### Recommendation: Single canonical identifier resolution on every inbound message. Prefix-based
command parsing with AI fallback for natural language queries about system status.

**The Core Problem: Admin Identification is Fragile**

The existing system identifies the admin via `aprendizadoContinuo.verifiedPhone`. The failure
mode is: the inbound `remoteJid` arrives as `@lid` (WhatsApp's linked-device anonymized ID)
which does not match the stored phone number.

**Reliable Admin Detection**

1. At connection time (when Baileys `connection.update` fires with `open`): query
   `sock.onWhatsApp(adminPhone)` — this returns the JID for the admin's phone. Store it in
   Redis: `SET instance:${instanceId}:admin_jid ${resolvedJid}` with no TTL (cleared on
   disconnect).

2. When a message arrives with `@lid` in `remoteJid`: attempt resolution via
   `sock.signalRepository.lidMapping` (available in Baileys as `getPNForLID`). If resolved,
   compare the E.164 number to the stored admin phone.

3. Never trust `message.key.fromMe` alone for admin detection on multi-device setups. Always
   resolve and compare against the stored admin phone.

```typescript
// Canonical check — call this once per inbound message
async function isAdminMessage(
  remoteJid: string,
  sock: WASocket,
  instanceAdminJid: string,  // from Redis at connection time
  adminPhone: string,
): Promise<boolean> {
  if (remoteJid === instanceAdminJid) return true;
  // Attempt LID resolution
  if (remoteJid.endsWith('@lid')) {
    const pn = await sock.signalRepository.lidMapping?.getPNForLID?.(remoteJid);
    if (pn) {
      const normalized = pn.replace(/\D/g, '');
      return adminPhone.replace(/\D/g, '').endsWith(normalized)
          || normalized.endsWith(adminPhone.replace(/\D/g, ''));
    }
  }
  return false;
}
```

Confidence: MEDIUM. The `getPNForLID` API exists in Baileys (confirmed via GitHub issue #1718
and #1554) but the mapping is only populated after the device exchange handshake completes.
There is a window after connection where it may return undefined. Calling `onWhatsApp()` at
connection time is the reliable fallback.

### Command Parsing for Admin Messages

Use a two-tier approach:

**Tier 1: Prefix matching for explicit commands**
```
/status          → system status report
/contrato [nome] → send contract to client
/proposta [nome] → send proposal
/resumo          → today's metrics summary
/encerrar [nome] → close session for contact
```

Why prefixes: deterministic, O(1) match, no AI latency, no misclassification.

**Tier 2: AI intent detection for free-text admin queries**

When no prefix matches, pass the message to a lightweight AI prompt:
```
You are a WhatsApp bot admin assistant. The admin sent: "{text}"
Classify the intent as one of:
  - SYSTEM_STATUS_QUERY (asking how the system is working)
  - DOCUMENT_SEND (asking to send a document to a client)
  - METRICS_QUERY (asking about numbers, counts, sessions)
  - UNRECOGNIZED
Return JSON: { intent: string, target?: string }
```

Use Groq for this — it is already wired in and has sub-200ms latency on single-turn prompts.

**Admin message vs client message must be decided before any chatbot processing.** If the
message is from the admin, the chatbot pipeline is not called. Route to `AdminCommandHandler`
instead. This check must happen in `InstanceOrchestrator` before the call to
`ChatbotService.process()`.

---

## Area 4: Document Sending via Baileys

### Recommendation: Always use URL-based sending for files stored in the filesystem or cloud.
Use Buffer only when generating documents in-memory (e.g., dynamically generated PDFs).

### Confirmed Baileys API (MEDIUM confidence — from official guide and npm package docs)

```typescript
// From URL (file on disk or remote HTTP URL)
await sock.sendMessage(contactJid, {
  document: { url: './contracts/contrato-joao.pdf' },  // or https://...
  mimetype: 'application/pdf',
  fileName: 'Contrato - João Silva.pdf',
  caption: 'Segue o contrato conforme combinado.',     // optional
});

// From Buffer (for generated/dynamic documents)
await sock.sendMessage(contactJid, {
  document: pdfBuffer,  // Buffer
  mimetype: 'application/pdf',
  fileName: 'Proposta Comercial.pdf',
});
```

`mimetype` is NOT optional for documents — it is required. Without it, WhatsApp may render the
file as a generic attachment without preview or wrong icon.

`fileName` controls what the recipient sees in their chat. Always set it. Use the client's name
in the filename for personalization: `Contrato - ${clientName}.pdf`.

`caption` renders below the document card — use it for the personalized message ("Olá João,
segue o contrato..."). This replaces the need for a separate text message before the document.

### File Size Limits

| Media Type | Hard Limit | Recommended |
|------------|-----------|-------------|
| Documents (PDF, DOCX, etc.) | 64 MB | Under 5 MB |
| Images | 64 MB | Under 64 KB |
| Video | 64 MB | Under 10 MB |

Source: WhatsApp Business API documentation via quickreply.ai (MEDIUM confidence).

The "up to 2 GB" figure cited elsewhere refers to WhatsApp's P2P consumer file transfer (phone
to phone), NOT the Business API / Baileys path. The Baileys upload path goes through WhatsApp
media servers and the effective limit is 64 MB. Contracts and PDFs should be well under this;
flag anything over 20 MB as a UX problem (slow upload, poor mobile experience) not a technical
blocker.

### Stream vs Buffer vs URL

Baileys documentation states: "It is recommended to use Stream or URL to save memory; Baileys
never loads the entire buffer into memory when using URL — it streams and encrypts the media."

For documents stored in the local filesystem: use `{ url: absolutePath }`.
For documents fetched from a remote source: use `{ url: remoteHttpsUrl }`.
For dynamically generated PDFs: generate into a Buffer, pass directly.
Never read a file to a Buffer just to pass it to `sendMessage` — it holds the entire file in
the Worker Thread's heap, which matters at scale.

### Admin-Initiated Document Send Flow

```
Admin: "/contrato João Silva"
  ↓
AdminCommandHandler.parse() → { intent: 'DOCUMENT_SEND', clientName: 'João Silva' }
  ↓
Look up contact by name in tenant DB → { contactJid, canonicalName }
  ↓
Find document template for 'contrato' in instance config
  ↓
Optionally: generate personalized PDF (e.g., with pdfkit or a template fill)
  ↓
sock.sendMessage(contactJid, { document: ..., mimetype, fileName, caption })
  ↓
Record in AdminActionLog: { triggeredBy: adminJid, type: 'document_send',
                            clientJid: contactJid, documentName, timestamp }
```

Do NOT send document to the admin's chat and the client's chat simultaneously unless explicitly
requested. The admin already sees the system response confirming the send.

### Known Issues

- **Issue #880** (WhiskeySockets/Baileys): Files downloaded as "Invalid-File" in WhatsApp
  Desktop. Cause: missing or incorrect `mimetype`. Mitigation: always set `mimetype` explicitly
  from the `mime-types` package (already in your stack) rather than hardcoding the string.
- **Issue #1199**: Media preview not showing. Unrelated to documents; affects images/video
  thumbnails only.
- There is no known reliable way to track whether the recipient actually received the document
  (only delivery receipt, not read receipt for documents).

---

## Summary: Decisions Table

| Area | Decision | Key Reason |
|------|----------|------------|
| Session state store | PostgreSQL enum column | Survives restarts; Redis queue for timeouts only |
| Session timeout mechanism | BullMQ deduplication with `extend: true` | O(1) reset on activity, native to existing stack |
| State machine library | None (plain enum + transition validation) | XState is overkill for 5 states |
| God-class extraction strategy | Domain events via typed EventEmitter, class extraction | Safe incremental extraction within same process |
| Extraction order | SessionManager first, AdminCommandHandler second | Session is the largest seam; admin is next |
| Admin identification | `onWhatsApp()` at connect time → Redis cache + LID fallback | Most reliable resolution available in Baileys |
| Admin command parsing | Prefix commands + Groq AI for free-text | Deterministic for structured commands, AI for queries |
| Document send API | `sock.sendMessage` with `{ url }` for disk files, Buffer for generated | Memory efficiency; Baileys streams URL-based sends |
| `mimetype` for PDF | `'application/pdf'` (required, not optional for documents) | Without it files render incorrectly |
| Document size limit | 64 MB hard limit; recommend under 5 MB | WhatsApp media server limit; > 5 MB degrades mobile UX |

---

## Open Questions / Gaps

1. **LID resolution timing**: The window between Baileys `connection.update: open` and the
   signal repository being populated with LID mappings is unclear. If the first admin message
   arrives in this window, it may misclassify. Need to instrument and observe in staging.

2. **PDF generation**: If personalized contracts need to be generated on the fly (not just
   template files), a PDF library is needed. `pdfkit` (MIT, zero native deps) or
   `@react-pdf/renderer` (if templates are React-based) are the two options. Not researched
   here — this is a phase-specific decision when the document feature is implemented.

3. **BullMQ deduplication `ttl` vs `delay` interaction**: The deduplication TTL and the job
   delay are set to the same value (10 minutes) in the pattern above. It is not confirmed in
   official docs whether a job deduplication entry can outlive its TTL if the job is still in
   the delayed state. Test in staging with a short timeout before deploying to production.

4. **Natural language close-intent detection**: Detecting "obrigado", "era só isso" as session
   close signals is listed in PROJECT.md requirements. The current `OrchestratorAgent` may
   already handle this via intent classification. Verify whether an explicit `CLOSE_INTENT`
   route needs to be added to `IntentRouter` or if `GeneralAgent` already returns a close
   signal.

---

## Sources

- BullMQ Deduplication: https://docs.bullmq.io/guide/jobs/deduplication
- BullMQ Delayed Jobs: https://docs.bullmq.io/guide/jobs/delayed
- BullMQ Issue #2534 (delayed jobs): https://github.com/taskforcesh/bullmq/issues/2534
- BullMQ Issue #3295 (lock error): https://github.com/taskforcesh/bullmq/issues/3295
- Domain Events in TypeScript (Khalil Stemmler): https://khalilstemmler.com/articles/typescript-domain-driven-design/chain-business-logic-domain-events/
- Strangler Fig Pattern: https://ruchitsuthar.com/blog/software-craftsmanship/refactoring-legacy-systems-strangler-fig/
- Baileys LID issue #1718: https://github.com/WhiskeySockets/Baileys/issues/1718
- Baileys LID issue #1554: https://github.com/WhiskeySockets/Baileys/issues/1554
- Baileys document sending: https://blog.pallysystems.com/2025/12/04/whatsapp-automation-using-baileys-js-a-complete-guide/
- WhatsApp media size limits: https://help.quickreply.ai/portal/en/kb/articles/what-are-the-media-file-size-limits-and-aspect-ratio-in-whatsapp-business-api
- Baileys sending messages guide: https://guide.whiskeysockets.io/docs/tutorial-basics/sending-messages/
