import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs/promises at module level — ESM modules cannot be spied on
// after import. This is the correct vitest pattern for node built-ins.
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
  readFile: vi.fn().mockResolvedValue(Buffer.from("pdf-content")),
}));

import { DocumentDispatchService } from "../document-dispatch.service.js";
import { stat, readFile } from "node:fs/promises";

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

const singleContact = [
  { id: "1", displayName: "João Silva", phoneNumber: null, rawJid: "5511999990001@s.whatsapp.net" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DocumentDispatchService", () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: DocumentDispatchService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fs mocks to defaults
    vi.mocked(stat).mockResolvedValue({ size: 1024 } as never);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("pdf-content") as never);

    deps = makeDeps();
    service = new DocumentDispatchService(deps as never);
  });

  // DOC-01: returns "no contact" message when 0 contacts found
  it("sends 'no contact found' response when contact lookup returns empty", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);
    deps.getTenantDb.mockReturnValue({
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    });

    await service.dispatch(makeEvent("/contrato João"), "contrato", "João Silva", sendResponse);

    expect(sendResponse).toHaveBeenCalledWith(
      expect.stringContaining("Nenhum contato encontrado")
    );
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  // DOC-02: disambiguation when multiple contacts match
  it("sends disambiguation list when multiple contacts match name", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);
    deps.getTenantDb.mockReturnValue({
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        { id: "1", displayName: "João Silva", phoneNumber: "5511999990001", rawJid: null },
        { id: "2", displayName: "João Silva Júnior", phoneNumber: "5511999990002", rawJid: null },
      ]),
    });

    await service.dispatch(makeEvent("/contrato João"), "contrato", "João", sendResponse);

    expect(sendResponse).toHaveBeenCalledWith(
      expect.stringContaining("2 contatos")
    );
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  // DOC-04: rejects file > 5_242_880 bytes before readFile
  it("rejects file > 5_242_880 bytes before readFile", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);
    deps.getTenantDb.mockReturnValue({
      $queryRawUnsafe: vi.fn().mockResolvedValue(singleContact),
    });
    deps.getDocumentTemplates.mockResolvedValue([
      { name: "contrato", filePath: "/tmp/test-data/large-file.pdf" },
    ]);
    vi.mocked(stat).mockResolvedValue({ size: 6_000_000 } as never);

    await service.dispatch(makeEvent("/contrato João"), "contrato", "João Silva", sendResponse);

    expect(stat).toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.stringContaining("5 MB")
    );
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  // DOC-01: reads file as base64, sends document message
  it("sends document with base64 content derived from readFile", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);
    deps.getTenantDb.mockReturnValue({
      $queryRawUnsafe: vi.fn().mockResolvedValue(singleContact),
    });
    deps.getDocumentTemplates.mockResolvedValue([
      { name: "contrato", filePath: "/tmp/test-data/contrato.pdf" },
    ]);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("pdf-content") as never);

    await service.dispatch(makeEvent("/contrato João"), "contrato", "João Silva", sendResponse);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      TENANT_ID,
      INSTANCE_ID,
      expect.objectContaining({
        type: "document",
        media: expect.objectContaining({
          base64: expect.stringMatching(/^[A-Za-z0-9+/]/),
        }),
      })
    );
  });

  // DOC-02: personalizes fileName as `{DocumentType} - {ClientName}.pdf`
  it("personalizes fileName as `{DocumentType} - {ClientName}.pdf`", async () => {
    const sendResponse = vi.fn().mockResolvedValue(undefined);
    deps.getTenantDb.mockReturnValue({
      $queryRawUnsafe: vi.fn().mockResolvedValue(singleContact),
    });
    deps.getDocumentTemplates.mockResolvedValue([
      { name: "contrato", filePath: "/tmp/test-data/contrato.pdf" },
    ]);

    await service.dispatch(makeEvent("/contrato João"), "contrato", "João Silva", sendResponse);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      TENANT_ID,
      INSTANCE_ID,
      expect.objectContaining({
        media: expect.objectContaining({
          fileName: "Contrato - João Silva.pdf",
        }),
      })
    );
  });
});
