---
phase: 07-admin-commander-document-dispatch
verified: 2026-04-23T23:59:00Z
status: gaps_found
score: 8/10 must-haves verified
overrides_applied: 0
gaps:
  - truth: "The legacy inline adminCommandService.handleCommand() call at service.ts lines 3388-3421 is removed"
    status: failed
    reason: "Legacy block still present at lines 3469-3500 in service.ts — if (finalInputText && isVerifiedAprendizadoContinuoAdminSender) { const handled = await this.adminCommandService.handleCommand(...) } is still executing for admin free-text commands, causing double-execution with AdminCommandHandler's Tier 2 path."
    artifacts:
      - path: "apps/api/src/modules/instances/service.ts"
        issue: "Lines 3469-3500 contain the exact legacy block the plan required to delete. Both AdminCommandHandler AND this inline path handle free-text admin commands when isVerifiedAprendizadoContinuoAdminSender is true."
    missing:
      - "Delete the block starting at line 3469: 'if (finalInputText && isVerifiedAprendizadoContinuoAdminSender) { const handled = await this.adminCommandService.handleCommand(...)' through the closing '}' at ~line 3500."
  - truth: "DOC-03: Arquivo referenciado por URL — não buffer em memória para arquivos grandes"
    status: failed
    reason: "Implementation uses base64 encoding (readFile into buffer, then .toString('base64')). The REQUIREMENTS.md DOC-03 states 'Arquivo referenciado por URL — não buffer em memória para arquivos grandes'. The implementation DOES load the full file into memory as a base64 string. The plan acknowledges this as a deliberate workaround (file:// not supported by fetch), but it contradicts the stated requirement."
    artifacts:
      - path: "apps/api/src/modules/instances/document-dispatch.service.ts"
        issue: "Lines 107-108: readFile(filePath) + buffer.toString('base64') — the entire file is read into memory. For files close to the 5 MB gate, this is a significant buffer."
    missing:
      - "Either: (a) accept this deviation via an override with documented rationale, OR (b) implement streaming/URL-based dispatch if Baileys supports it for local files."
human_verification:
  - test: "Verify that the legacy block at service.ts:3469 removal does not break admin correction flows that depend on isVerifiedAprendizadoContinuoAdminSender downstream"
    expected: "After removing lines 3469-3500, admin free-text commands handled solely by AdminCommandHandler; admin correction flow (extractQuotedConfirmationQuestion at line 3195) still works because it runs earlier in the same code path and returns before reaching line 3469"
    why_human: "The code path is complex — multiple if/return chains. A grep cannot confirm that no other admin behavior depends on the block at 3469 running. A developer should trace the full execution path to confirm safe removal."
---

# Phase 7: Admin Commander & Document Dispatch Verification Report

**Phase Goal:** Build an Admin Commander system — a universal event-bus subscriber that routes WhatsApp admin commands to specialized handlers — plus a Document Dispatch pipeline, AdminActionLog audit trail, and real-data /status and /resumo responses.
**Verified:** 2026-04-23T23:59:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | All admin messages route through AdminCommandHandler — no admin message enters ChatbotService.process() | VERIFIED | `eventBus.on('admin.command', ...)` subscription confirmed in admin-command.handler.ts:44. Event emitted for all `isAdminOrInstanceSender` at service.ts:2478. |
| 2 | Prefix commands (/status, /resumo, /contrato, /proposta, /encerrar) parsed without calling Groq | VERIFIED | admin-command.handler.ts:71-93 — prefix regex matching routes to specialized handlers before Tier 2 fallback. No Groq call in Tier 1 path. |
| 3 | Free-text commands reach AdminCommandService.handleCommand() via Tier 2 fallback | PARTIAL — see gap | admin-command.handler.ts:97-110 correctly routes free-text to adminCommandService. However, the legacy inline block at service.ts:3469 ALSO calls adminCommandService.handleCommand() for the same free-text commands when isVerifiedAprendizadoContinuoAdminSender is true — causing double-execution. |
| 4 | The legacy inline adminCommandService.handleCommand() call is removed | FAILED | service.ts:3469-3500 still contains: `if (finalInputText && isVerifiedAprendizadoContinuoAdminSender) { const handled = await this.adminCommandService.handleCommand(...) }` — the exact block the plan required to delete. |
| 5 | Admin sends /contrato [name] — PDF read as base64 — Baileys receives document payload with personalized caption | VERIFIED | document-dispatch.service.ts:44-139 implements full pipeline: contact lookup, size gate, readFile+base64, personalized fileName/caption, sendMessage with type:'document'. |
| 6 | File >= 5,242,880 bytes: send aborted, admin receives warning, readFile never called | VERIFIED | document-dispatch.service.ts:89-104 — `stat()` before `readFile()`, conditional abort if `fileSize > MAX_DOC_BYTES`. |
| 7 | AdminActionLog table exists in every tenant schema after API startup + every admin command produces an audit row | VERIFIED | run-migrations.ts:277-297 — migrations 042 and 043 registered. admin-action-log.service.ts has `write()` method. admin-command.handler.ts calls `deps.actionLog.write()` in every command branch (status_query, metrics_query, document_send, session_close). |
| 8 | GET /tenant/action-history responds 200 with JSON array to an authenticated request | VERIFIED | apps/api/src/modules/tenant/routes.ts:69-92 — route registered with config:{auth:"tenant"} authentication guard. Queries AdminActionLog via $queryRawUnsafe with parameterized LIMIT. |
| 9 | Panel page at /tenant/historico-acoes renders action history | VERIFIED | apps/panel/app/(tenant)/tenant/historico-acoes/page.tsx exists, TenantActionHistoryPage renders history table, calls getTenantActionHistory(). getTenantActionHistory() present in apps/panel/lib/api.ts:446. |
| 10 | Admin sends /status and receives real instance data — handleStatusCommand/handleResumoCommand stubs replaced | VERIFIED | status-query.service.ts:22-44 — getSnapshot() with Promise.all over 4 real data sources. admin-command.handler.ts:113-132 — real implementations replace stubs. grep for "Plano 7.4" returns no match. |

**Score:** 8/10 truths verified (2 failed)

### Deferred Items

None — all gaps are actionable in current phase scope.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/instances/admin-command.handler.ts` | AdminCommandHandler class with Tier 1/2 routing | VERIFIED | 172 lines. Exports AdminCommandHandler, AdminCommandHandlerDeps. eventBus.on subscription, setImmediate wrapper, all prefix routes wired. |
| `apps/api/src/modules/instances/document-dispatch.service.ts` | DocumentDispatchService with size gate, base64, disambiguation | VERIFIED | 140 lines. Exports DocumentDispatchService, DocumentDispatchDeps. Full pipeline implemented. |
| `apps/api/src/modules/instances/admin-action-log.service.ts` | AdminActionLogService with writeLog() and non-blocking error handling | VERIFIED | 112 lines. Exports AdminActionLogService, AdminActionLogDeps, AdminActionLogEntry, WriteLogOptions. setImmediate + logger.warn present. |
| `apps/api/src/modules/instances/status-query.service.ts` | StatusQueryService with getSnapshot, formatStatusMessage, formatResumoMessage | VERIFIED | 91 lines. Exports StatusQueryService, StatusQueryDeps, StatusSnapshot. Promise.all with individual .catch(). |
| `apps/api/src/lib/run-migrations.ts` | Migrations 042+043 registered | VERIFIED | Lines 277-297 contain both migration entries. Migration 041 (2026-04-19) still present. |
| `apps/api/src/modules/tenant/routes.ts` | GET /tenant/action-history route with auth | VERIFIED | Lines 69-92 — route registered with config:{auth:"tenant",tenantRoles:[...]}. Queries AdminActionLog. |
| `apps/panel/app/(tenant)/tenant/historico-acoes/page.tsx` | TenantActionHistoryPage with history table | VERIFIED | Matches plan spec exactly. DeliveryStatusBadge, formatActionType, calls getTenantActionHistory(100). |
| `apps/api/src/modules/instances/service.ts` | Legacy inline call removed, AdminCommandHandler instantiated | PARTIAL | AdminCommandHandler IS instantiated (lines 363-384) with documentDispatch, actionLog, statusQuery deps. BUT legacy block at lines 3469-3500 NOT removed. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| instance-events.ts | admin-command.handler.ts | eventBus.on('admin.command') | VERIFIED | admin-command.handler.ts:45 — `deps.eventBus.on('admin.command', ...)` |
| service.ts | admin-command.handler.ts | new AdminCommandHandler(deps) | VERIFIED | service.ts:363 — `this.adminCommandHandler = new AdminCommandHandler({...})` |
| admin-command.handler.ts | document-dispatch.service.ts | deps.documentDispatch.dispatch | VERIFIED | admin-command.handler.ts:141 — `await this.deps.documentDispatch.dispatch(event, documentType, clientName, this.makeSendResponse(event))` |
| admin-command.handler.ts | admin-action-log.service.ts | deps.actionLog.write | VERIFIED | admin-command.handler.ts:105, 117, 128, 147, 165 — write() called in every command branch |
| admin-command.handler.ts | status-query.service.ts | deps.statusQuery.getSnapshot | VERIFIED | admin-command.handler.ts:114, 125 — getSnapshot() called in handleStatusCommand and handleResumoCommand |
| historico-acoes/page.tsx | panel/lib/api.ts | getTenantActionHistory() | VERIFIED | page.tsx:2 imports getTenantActionHistory, line 40 calls it |
| panel/lib/api.ts | tenant/routes.ts | fetch GET /tenant/action-history | VERIFIED | api.ts:448 — `request<AdminActionLogEntry[]>('/tenant/action-history?limit=${limit}', "tenant")` |
| service.ts (legacy) | adminCommandService | SHOULD BE REMOVED | FAILED | service.ts:3469 — legacy `adminCommandService.handleCommand()` still called for isVerifiedAprendizadoContinuoAdminSender free-text, bypassing AdminCommandHandler's Tier 2 path |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| historico-acoes/page.tsx | history | getTenantActionHistory() → GET /tenant/action-history → $queryRawUnsafe SELECT FROM AdminActionLog | Yes — real SQL query ordered by createdAt DESC | FLOWING |
| status-query.service.ts / StatusSnapshot | instanceStatus, activeSessionCount, todayMessageCount, lastSummaryAt | workers Map (instance status), conversationSession.count (Prisma), conversation.count (Prisma), Redis GET | Yes — real data sources wired in service.ts:331-361 | FLOWING |
| document-dispatch.service.ts | contacts | $queryRawUnsafe SELECT FROM Contact WHERE LIKE | Yes — parameterized query against tenant Contact table | FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED — cannot start server or run tests without external dependencies (Prisma, Redis, WhatsApp connection). The test suite verification is the appropriate proxy.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| CMD-01 | 07-01 | Admin can send prefixed commands via WhatsApp | SATISFIED | Prefix routing in admin-command.handler.ts:71-93 |
| CMD-02 | 07-04 | Admin can send natural language commands — classified by LLM | SATISFIED | Tier 2 fallback at admin-command.handler.ts:97-110 routes free-text to adminCommandService.handleCommand(). Note: double-execution risk with legacy block. |
| CMD-03 | 07-02 | Document send: identifies client, builds personalized message, sends PDF | SATISFIED | document-dispatch.service.ts — contact lookup, personalized caption, sendMessage with document payload |
| CMD-04 | 07-02 | Personalized message with client name and document context | SATISFIED | document-dispatch.service.ts:112-118 — fileName: `{TypeCapitalized} - {displayName}.pdf`, caption template with {clientName} substitution |
| CMD-05 | 07-03 | Audit log of all admin actions: who, when, client, document, message, delivery status | SATISFIED | AdminActionLogService.write() called in every AdminCommandHandler branch. Route GET /tenant/action-history returns real rows. Panel page renders them. |
| CMD-06 | 07-04 | Admin can ask about system health and receive clear response | SATISFIED | /status → handleStatusCommand → statusQuery.getSnapshot() + formatStatusMessage(). /resumo → formatResumoMessage(). |
| DOC-01 | 07-02 | Chatbot can send documents (PDF, contrato, proposta) during automated flow | SATISFIED | document-dispatch.service.ts:120-125 — sendMessage with type:'document', media:{base64, mimeType, fileName, caption} |
| DOC-02 | 07-02 | Baileys send with explicit mimetype and fileName | SATISFIED | document-dispatch.service.ts:109 — `mime.lookup(filePath) \|\| 'application/pdf'`. fileName: `{Type} - {Client}.pdf`. |
| DOC-03 | 07-02 | File referenced by URL — NOT in-memory buffer for large files | NEEDS HUMAN | REQUIREMENTS.md: "Arquivo referenciado por URL — não buffer em memória para arquivos grandes". Implementation uses base64 (full file read into memory). Plan justifies this as necessary workaround (file:// not supported by resolveMediaBuffer fetch path). Deviation from requirement text requires explicit acceptance. |
| DOC-04 | 07-02 | Maximum size respected: alert if file > 5 MB before sending | SATISFIED | MAX_DOC_BYTES = 5*1024*1024. stat() called before readFile(). If fileSize > MAX_DOC_BYTES → sendResponse with warning, return without readFile. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| apps/api/src/modules/instances/service.ts | 3469 | Legacy adminCommandService.handleCommand() block still present (isVerifiedAprendizadoContinuoAdminSender gate) | Blocker | Double-execution of free-text admin commands — both AdminCommandHandler Tier 2 AND legacy block fire when admin sends free-text |
| apps/api/src/modules/instances/admin-command.handler.ts | 103 | `sendMessageToClient: async (_jid, _phone, _msg) => false // wired in Plan 7.2` | Warning | sendMessageToClient in Tier 2 AdminCommandService.handleCommand() always returns false — client messaging from admin LLM commands is non-functional |
| apps/api/src/modules/instances/admin-action-log.service.ts | 51-61 | writeLog() resolves immediately AND resolves again in finally block — double-resolve pattern | Warning | Promise resolves twice — harmless in JS (subsequent resolves are no-ops) but is a code smell indicating hasty implementation |

### Human Verification Required

#### 1. DOC-03 Requirement Deviation — base64 vs URL approach

**Test:** Review the REQUIREMENTS.md DOC-03 requirement against the base64 implementation in document-dispatch.service.ts.
**Expected:** Either (a) the implementation is accepted as compliant because base64 IS the only viable path for local file dispatch via Baileys, OR (b) a proper URL-based approach is investigated.
**Why human:** The requirements text says "Arquivo referenciado por URL — não buffer em memória para arquivos grandes". The implementation reads the file into memory as base64 before the 5 MB gate limit. The plan explicitly acknowledges Baileys does not support `file://` URLs in `resolveMediaBuffer`. A developer must decide: accept the deviation, update the requirement text, or find an alternative.

#### 2. Legacy block removal safety check

**Test:** Trace the full execution path in service.ts after removing lines 3469-3500. Confirm that no admin behavior (learning corrections, scheduling replies, etc.) depends on this block running after the event bus emit.
**Expected:** Safe to delete — all behaviors above line 3469 return early before reaching it, so removing it only stops the double-execution.
**Why human:** The service.ts file is large and complex (~3500 lines). The code paths are non-linear with many early returns. A developer must manually trace whether any admin flow falls through to line 3469 and depends on it running correctly, rather than being intercepted by AdminCommandHandler.

### Gaps Summary

Two gaps block full goal achievement:

**Gap 1 (Blocker): Legacy inline adminCommandService.handleCommand() NOT removed.** service.ts:3469-3500 still calls `adminCommandService.handleCommand()` for free-text commands when `isVerifiedAprendizadoContinuoAdminSender` is true. This means the Tier 2 fallback in AdminCommandHandler AND this legacy block both fire, causing double LLM calls and double audit log writes for admin free-text messages. Plan 07-01 Task 2 acceptance criteria explicitly required this block to be absent (`grep ... returns NO match`), but it was not removed.

**Gap 2 (Needs Human): DOC-03 requirement deviation.** The requirement says "referenced by URL, not in-memory buffer". The implementation uses base64 (full file read into memory). The plan acknowledges this is a known Baileys constraint but the requirement text was never updated. A developer must decide whether to accept this as a documented deviation or update the requirement.

---

_Verified: 2026-04-23T23:59:00Z_
_Verifier: Claude (gsd-verifier)_
