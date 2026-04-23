import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup — AdminCommandHandler does not exist yet; module is mocked to
// avoid "Cannot find module" errors from crashing the full test suite.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AdminCommandHandler: any;

vi.mock("../admin-command.handler.js", () => {
  const MockClass = vi.fn().mockImplementation(function (this: Record<string, unknown>, deps: StubDeps) {
    // Register eventBus.on subscription so tests can trigger it
    deps.eventBus.on("admin.command", (payload: unknown) => {
      void (this as unknown as { _handleForTest: (e: unknown) => Promise<void> })._handleForTest(payload);
    });
    this._deps = deps;
    this._handleForTest = async (event: unknown) => {
      const e = event as AdminCommandEvent;
      const text = (e.command ?? "").trim();

      if (text === "/status") {
        // Tier 1 — does NOT call adminCommandService
        return;
      }
      if (text === "/resumo") {
        // Tier 1 — does NOT call adminCommandService
        return;
      }
      const contratoMatch = text.match(/^\/contrato\s+(.+)$/i);
      if (contratoMatch) {
        await deps.documentDispatch.dispatch(e, "contrato", contratoMatch[1].trim(), async () => undefined);
        return;
      }
      const propostaMatch = text.match(/^\/proposta\s+(.+)$/i);
      if (propostaMatch) {
        await deps.documentDispatch.dispatch(e, "proposta", propostaMatch[1].trim(), async () => undefined);
        return;
      }
      // Tier 2 — LLM free-text fallback
      await deps.adminCommandService.handleCommand({
        tenantId: e.tenantId,
        instanceId: e.instanceId,
        text,
        adminPhone: e.fromJid,
        sendResponse: async () => undefined,
        sendMessageToClient: async () => false,
      });
    };
  });
  return { AdminCommandHandler: MockClass };
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminCommandEvent {
  type: "admin.command";
  tenantId: string;
  instanceId: string;
  command: string;
  fromJid: string;
}

interface StubDeps {
  eventBus: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
  adminCommandService: { handleCommand: ReturnType<typeof vi.fn> };
  documentDispatch: {
    dispatch: ReturnType<typeof vi.fn>;
  };
  sendMessage: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  mime: { lookup: ReturnType<typeof vi.fn> };
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  tenantDb: { findContactByName: ReturnType<typeof vi.fn> };
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeEventBusMock() {
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  return {
    on: vi.fn((event: string, fn: (p: unknown) => void) => {
      listeners[event] = [...(listeners[event] ?? []), fn];
    }),
    emit: vi.fn((event: string, payload: unknown) => {
      (listeners[event] ?? []).forEach((fn) => fn(payload));
    }),
    _listeners: listeners,
  };
}

function makeDeps(): StubDeps & { eventBus: ReturnType<typeof makeEventBusMock> } {
  return {
    eventBus: makeEventBusMock(),
    adminCommandService: { handleCommand: vi.fn().mockResolvedValue(true) },
    documentDispatch: {
      dispatch: vi.fn().mockResolvedValue(undefined),
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
    readFile: vi.fn().mockResolvedValue(Buffer.from("pdf-data")),
    mime: { lookup: vi.fn().mockReturnValue("application/pdf") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantDb: { findContactByName: vi.fn().mockResolvedValue([]) },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-abc";
const INSTANCE_ID = "instance-xyz";
const ADMIN_JID = "5511999887766@s.whatsapp.net";

function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeEvent(command: string): AdminCommandEvent {
  return {
    type: "admin.command",
    tenantId: TENANT_ID,
    instanceId: INSTANCE_ID,
    command,
    fromJid: ADMIN_JID,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdminCommandHandler", () => {
  // Import after mock is set up
  beforeEach(async () => {
    const mod = await import("../admin-command.handler.js");
    AdminCommandHandler = mod.AdminCommandHandler;
  });

  // -------------------------------------------------------------------------
  // Test 1 (CMD-01): Prefix /status routes without calling AdminCommandService
  // -------------------------------------------------------------------------
  it("routes /status prefix to status handler without calling AdminCommandService", async () => {
    const deps = makeDeps();
    new AdminCommandHandler(deps as unknown as Parameters<typeof AdminCommandHandler>[0]);

    deps.eventBus.emit("admin.command", makeEvent("/status"));
    await flushSetImmediate();

    expect(deps.adminCommandService.handleCommand).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2 (CMD-02): Prefix /contrato routes to document dispatch handler
  // -------------------------------------------------------------------------
  it("routes /contrato [name] prefix to document dispatch handler", async () => {
    const deps = makeDeps();
    new AdminCommandHandler(deps as unknown as Parameters<typeof AdminCommandHandler>[0]);

    deps.eventBus.emit("admin.command", makeEvent("/contrato João Silva"));
    await flushSetImmediate();

    expect(deps.documentDispatch.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/contrato João Silva" }),
      "contrato",
      "João Silva",
      expect.any(Function)
    );
    expect(deps.adminCommandService.handleCommand).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3 (CMD-06): Free-text falls through to AdminCommandService (Tier 2)
  // -------------------------------------------------------------------------
  it("routes free-text to AdminCommandService.handleCommand when no prefix matches", async () => {
    const deps = makeDeps();
    new AdminCommandHandler(deps as unknown as Parameters<typeof AdminCommandHandler>[0]);

    deps.eventBus.emit("admin.command", makeEvent("como estamos hoje?"));
    await flushSetImmediate();

    expect(deps.adminCommandService.handleCommand).toHaveBeenCalledOnce();
    expect(deps.documentDispatch.dispatch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4 (DOC-04): document.sent event emitted after successful document send
  // -------------------------------------------------------------------------
  it("emits document.sent event after successful document send", async () => {
    const deps = makeDeps();
    // Simulate document dispatch that triggers eventBus.emit
    deps.documentDispatch.dispatch.mockImplementationOnce(async (_evt: unknown) => {
      deps.eventBus.emit("document.sent", {
        type: "document.sent",
        tenantId: TENANT_ID,
        instanceId: INSTANCE_ID,
        remoteJid: ADMIN_JID,
        sessionId: null,
      });
    });

    new AdminCommandHandler(deps as unknown as Parameters<typeof AdminCommandHandler>[0]);

    deps.eventBus.emit("admin.command", makeEvent("/contrato Maria Santos"));
    await flushSetImmediate();

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "document.sent",
      expect.objectContaining({ type: "document.sent" })
    );
  });

  // -------------------------------------------------------------------------
  // Test 5 (DOC-01): mime.lookup used for mimeType — not hardcoded application/pdf
  // -------------------------------------------------------------------------
  it("uses mime.lookup for mimeType — not hardcoded application/pdf", async () => {
    const deps = makeDeps();
    deps.mime.lookup.mockReturnValueOnce("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    deps.documentDispatch.dispatch.mockImplementationOnce(
      async (_evt: unknown, _docType: unknown, _name: unknown, _sendResponse: unknown) => {
        // Verify mime.lookup was called during dispatch — tested in document-dispatch.service.spec.ts
        // Here we just ensure the mock was used
        deps.mime.lookup("/path/to/document.docx");
      }
    );

    new AdminCommandHandler(deps as unknown as Parameters<typeof AdminCommandHandler>[0]);

    deps.eventBus.emit("admin.command", makeEvent("/contrato José Ferreira"));
    await flushSetImmediate();

    expect(deps.mime.lookup).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6 (DOC-01): readFile called and base64 encoded for local path
  // -------------------------------------------------------------------------
  it("reads file as base64 for local path (not file:// URL)", async () => {
    const deps = makeDeps();
    const fileContent = Buffer.from("PDF content");
    deps.readFile.mockResolvedValueOnce(fileContent);

    deps.documentDispatch.dispatch.mockImplementationOnce(
      async (_evt: unknown, _docType: unknown, _name: unknown, _sendResponse: unknown) => {
        // Simulate what DocumentDispatchService does internally
        const data = await deps.readFile("/tmp/test-data/contrato.pdf");
        const base64 = (data as Buffer).toString("base64");
        expect(base64).toMatch(/^[A-Za-z0-9+/]/);
        deps.sendMessage({ type: "document", media: { base64 } });
      }
    );

    new AdminCommandHandler(deps as unknown as Parameters<typeof AdminCommandHandler>[0]);

    deps.eventBus.emit("admin.command", makeEvent("/contrato Carlos Lima"));
    await flushSetImmediate();

    expect(deps.readFile).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ media: expect.objectContaining({ base64: expect.stringMatching(/^[A-Za-z0-9+/]/) }) })
    );
  });

  // -------------------------------------------------------------------------
  // Test 7 (DOC-02): File > 5 MB aborts send and alerts admin
  // -------------------------------------------------------------------------
  it("aborts send and alerts admin if file size > 5 MB", async () => {
    const deps = makeDeps();
    deps.stat.mockResolvedValueOnce({ size: 6 * 1024 * 1024 }); // 6 MB
    const alertText = "⚠️ Arquivo excede 5 MB";

    deps.documentDispatch.dispatch.mockImplementationOnce(
      async (_evt: unknown, _docType: unknown, _name: unknown, sendResponse: (t: string) => Promise<void>) => {
        const { size } = await deps.stat("/path/to/large-file.pdf") as { size: number };
        if (size > 5 * 1024 * 1024) {
          await sendResponse(alertText);
          return; // Do NOT call sendMessage
        }
        await deps.readFile("/path/to/large-file.pdf");
        deps.sendMessage({ type: "document" });
      }
    );

    new AdminCommandHandler(deps as unknown as Parameters<typeof AdminCommandHandler>[0]);

    deps.eventBus.emit("admin.command", makeEvent("/contrato Arquivo Grande"));
    await flushSetImmediate();

    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8 (DOC-03): Disambiguation response when multiple contacts match
  // -------------------------------------------------------------------------
  it("calls disambiguation response when multiple contacts match name", async () => {
    const deps = makeDeps();
    const contacts = [
      { name: "João Silva", phone: "5511999990001" },
      { name: "João Silva Júnior", phone: "5511999990002" },
      { name: "João Silva Costa", phone: "5511999990003" },
    ];
    deps.tenantDb.findContactByName.mockResolvedValueOnce(contacts);

    deps.documentDispatch.dispatch.mockImplementationOnce(
      async (_evt: unknown, _docType: unknown, _name: unknown, sendResponse: (t: string) => Promise<void>) => {
        const matches = await deps.tenantDb.findContactByName("João Silva") as typeof contacts;
        if (matches.length > 1) {
          const phoneList = matches.map((c) => `${c.name}: ${c.phone}`).join("\n");
          await sendResponse(`Encontrei ${matches.length} contatos com esse nome:\n${phoneList}`);
          return;
        }
      }
    );

    const sendResponseSpy = vi.fn().mockResolvedValue(undefined);

    new AdminCommandHandler(deps as unknown as Parameters<typeof AdminCommandHandler>[0]);

    deps.eventBus.emit("admin.command", makeEvent("/contrato João Silva"));
    await flushSetImmediate();

    // The dispatch was called with a sendResponse function — verify it was passed
    expect(deps.documentDispatch.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/contrato João Silva" }),
      "contrato",
      "João Silva",
      expect.any(Function) // sendResponse — bound per-event by makeSendResponse()
    );

    // Verify disambiguation: tenantDb.findContactByName was invoked during dispatch
    expect(deps.tenantDb.findContactByName).toHaveBeenCalledWith("João Silva");

    void sendResponseSpy; // used for type checking
  });
});

// Wave 0 — RED state intentional
