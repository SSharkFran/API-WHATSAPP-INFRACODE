import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the future DocumentDispatchService module — it does not exist yet.
// This prevents "Cannot find module" from aborting the whole suite.
vi.mock("../document-dispatch.service.js", () => ({
  DocumentDispatchService: class {
    constructor(_deps: unknown) {}
    async dispatch(
      _event: unknown,
      _documentType: string,
      _clientName: string,
      _sendResponse: (msg: string) => Promise<void>
    ): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { DocumentDispatchService } from "../document-dispatch.service.js";

// ---------------------------------------------------------------------------
// Stub deps
// CRITICAL: sendResponse is NOT in deps — it is the 4th param to dispatch()
// ---------------------------------------------------------------------------

function makeDeps() {
  return {
    eventBus: { emit: vi.fn(), on: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    dataDir: "/tmp/test-data",
    getTenantDb: vi.fn().mockReturnValue({
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getDocumentTemplates: vi.fn().mockResolvedValue([]),
    // NOTE: sendResponse is NOT here — it is the 4th param to dispatch()
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-abc";
const INSTANCE_ID = "instance-xyz";
const ADMIN_JID = "5511999887766@s.whatsapp.net";

function makeEvent(command: string) {
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

describe("DocumentDispatchService", () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: DocumentDispatchService;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    service = new DocumentDispatchService(deps as never);
  });

  // DOC-01: reads file as base64, sends document message
  it("sends document with base64 content derived from readFile", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);

    // When DocumentDispatchService is implemented, it should:
    // 1. Call stat() to check file size
    // 2. Call readFile() and convert to base64
    // 3. Call sendMessage with { type: 'document', media: { base64: ... } }
    expect(true).toBe(false); // TODO: implement after DocumentDispatchService is built
    // Stub: await service.dispatch(makeEvent('/contrato João'), 'contrato', 'João Silva', sendResponse);
    // expect(deps.sendMessage).toHaveBeenCalledWith(
    //   expect.objectContaining({ media: expect.objectContaining({ base64: expect.stringMatching(/^[A-Za-z0-9+/]/) }) })
    // );
  });

  // DOC-02: uses mime.lookup(filePath) for mimeType
  it("uses mime.lookup(filePath) for mimeType", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);

    expect(true).toBe(false); // TODO: implement after DocumentDispatchService is built
    // Stub: expect mimeLookup was called with file path ending in '.pdf' or similar
    // Stub: expect media.mimeType equals result of mime.lookup(...)
  });

  // DOC-02: personalizes fileName as `{DocumentType} - {ClientName}.pdf`
  it("personalizes fileName as `{DocumentType} - {ClientName}.pdf`", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);

    expect(true).toBe(false); // TODO: implement after DocumentDispatchService is built
    // Stub: await service.dispatch(makeEvent('/contrato João'), 'contrato', 'João Silva', sendResponse);
    // expect(deps.sendMessage).toHaveBeenCalledWith(
    //   expect.objectContaining({ media: expect.objectContaining({ fileName: 'Contrato - João Silva.pdf' }) })
    // );
  });

  // DOC-03: personalizes caption with client name
  it("personalizes caption with client name", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);

    expect(true).toBe(false); // TODO: implement after DocumentDispatchService is built
    // Stub: await service.dispatch(makeEvent('/contrato João'), 'contrato', 'João Silva', sendResponse);
    // expect(deps.sendMessage).toHaveBeenCalledWith(
    //   expect.objectContaining({ media: expect.objectContaining({ caption: expect.stringContaining('João Silva') }) })
    // );
  });

  // DOC-04: rejects file > 5_242_880 bytes before readFile
  it("rejects file > 5_242_880 bytes before readFile", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);

    // stat() would return a file size > 5 MB
    // readFile should NOT be called
    // sendResponse (4th param) should be called with alert text about file size
    expect(true).toBe(false); // TODO: implement after DocumentDispatchService is built
    // Stub: deps.stat.mockResolvedValue({ size: 6_000_000 });
    // await service.dispatch(makeEvent('/contrato João'), 'contrato', 'João Silva', sendResponse);
    // expect(deps.readFile).not.toHaveBeenCalled();
    // expect(sendResponse).toHaveBeenCalledWith(expect.stringContaining('5 MB'));
  });
});

// Wave 0 — RED state intentional
