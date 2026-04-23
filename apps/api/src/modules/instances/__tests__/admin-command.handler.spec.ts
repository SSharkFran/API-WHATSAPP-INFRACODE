import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the future AdminCommandHandler module — it does not exist yet.
// This prevents "Cannot find module" from aborting the whole suite.
vi.mock("../admin-command.handler.js", () => ({
  AdminCommandHandler: class {
    constructor(_deps: unknown) {}
    handleAdminCommand(_event: unknown): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { AdminCommandHandler } from "../admin-command.handler.js";

// ---------------------------------------------------------------------------
// Stub deps interface
// ---------------------------------------------------------------------------

interface StubDeps {
  eventBus: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
  adminCommandService: { handleCommand: ReturnType<typeof vi.fn> };
  documentDispatch: {
    dispatch: ReturnType<typeof vi.fn>; // (event, documentType, clientName, sendResponse) => Promise<void>
  };
  sendMessage: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;     // from 'node:fs/promises'
  readFile: ReturnType<typeof vi.fn>; // from 'node:fs/promises'
  mime: { lookup: ReturnType<typeof vi.fn> };
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  tenantDb: { findContactByName: ReturnType<typeof vi.fn> }; // returns Contact[]
}

function makeDeps(): StubDeps {
  return {
    eventBus: {
      on: vi.fn(),
      emit: vi.fn(),
    },
    adminCommandService: {
      handleCommand: vi.fn().mockResolvedValue(undefined),
    },
    documentDispatch: {
      dispatch: vi.fn().mockResolvedValue(undefined),
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1024 }), // 1 KB by default
    readFile: vi.fn().mockResolvedValue(Buffer.from("fake-pdf-content")),
    mime: {
      lookup: vi.fn().mockReturnValue("application/pdf"),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    tenantDb: {
      findContactByName: vi.fn().mockResolvedValue([]),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-abc";
const INSTANCE_ID = "instance-xyz";
const ADMIN_JID = "5511999887766@s.whatsapp.net";

function makeAdminCommandEvent(command: string) {
  return {
    type: "admin.command" as const,
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
  let deps: StubDeps;
  let handler: AdminCommandHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    handler = new AdminCommandHandler(deps as never);
  });

  // CMD-01: status prefix is routed to dedicated status handler, NOT to AdminCommandService
  it("routes /status prefix to status handler without calling AdminCommandService", async () => {
    const event = makeAdminCommandEvent("/status");

    // Trigger via handler dispatch (handler should subscribe internally)
    // Since AdminCommandHandler is mocked, test the routing logic stub:
    expect(true).toBe(false); // TODO: implement after AdminCommandHandler is built — assert handleCommand NOT called
  });

  // CMD-02: /contrato [name] routes to document dispatch handler
  it("routes /contrato [name] prefix to document dispatch handler", async () => {
    const event = makeAdminCommandEvent("/contrato João Silva");

    expect(true).toBe(false); // TODO: implement after AdminCommandHandler is built
    // Stub: expect(deps.documentDispatch.dispatch).toHaveBeenCalledWith(
    //   expect.objectContaining({ command: '/contrato João Silva' }),
    //   'contrato',
    //   'João Silva',
    //   expect.any(Function)
    // );
  });

  // CMD-06: free-text (no prefix) → AdminCommandService.handleCommand
  it("routes free-text to AdminCommandService.handleCommand when no prefix matches", async () => {
    const event = makeAdminCommandEvent("como estamos hoje?");

    expect(true).toBe(false); // TODO: implement after AdminCommandHandler is built
    // Stub: expect(deps.adminCommandService.handleCommand).toHaveBeenCalledOnce();
  });

  // DOC-03: emits document.sent event after successful document send
  it("emits document.sent event after successful document send", async () => {
    expect(true).toBe(false); // TODO: implement after AdminCommandHandler is built
    // Stub: expect(deps.eventBus.emit).toHaveBeenCalledWith('document.sent', expect.objectContaining({ type: 'document.sent' }));
  });

  // DOC-02: uses mime.lookup for mimeType — not hardcoded application/pdf
  it("uses mime.lookup for mimeType — not hardcoded application/pdf", async () => {
    expect(true).toBe(false); // TODO: implement after AdminCommandHandler is built
    // Stub: expect(deps.mime.lookup).toHaveBeenCalledWith(expect.stringContaining('.pdf'));
    // Stub: expect(result.mimeType).toBe(deps.mime.lookup.mock.results[0].value);
  });

  // DOC-01: reads file as base64 for local path (not file:// URL)
  it("reads file as base64 for local path (not file:// URL)", async () => {
    expect(true).toBe(false); // TODO: implement after AdminCommandHandler is built
    // Stub: expect(deps.readFile).toHaveBeenCalled();
    // Stub: expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ media: expect.objectContaining({ base64: expect.any(String) }) }));
  });

  // DOC-04: aborts send and alerts admin if file size > 5 MB
  it("aborts send and alerts admin if file size > 5 MB", async () => {
    deps.stat.mockResolvedValue({ size: 6 * 1024 * 1024 }); // 6 MB

    expect(true).toBe(false); // TODO: implement after AdminCommandHandler is built
    // Stub: expect(deps.sendMessage).not.toHaveBeenCalled();
    // Stub: sendResponse called with '⚠️ Arquivo excede 5 MB'
  });

  // CMD-02 disambiguation: multiple contacts match name
  it("calls disambiguation response when multiple contacts match name", async () => {
    deps.tenantDb.findContactByName.mockResolvedValue([
      { phone: "5511111111111", name: "João Silva A" },
      { phone: "5511222222222", name: "João Silva B" },
      { phone: "5511333333333", name: "João Silva C" },
    ]);

    expect(true).toBe(false); // TODO: implement after AdminCommandHandler is built
    // Stub: expect sendResponse was called with text including all 3 phone numbers
  });
});

// Wave 0 — RED state intentional
