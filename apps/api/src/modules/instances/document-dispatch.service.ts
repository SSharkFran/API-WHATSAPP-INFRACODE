import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import type pino from 'pino';
import type { InstanceEventBus, AdminCommandEvent } from '../../lib/instance-events.js';

const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5 MB — DOC-04

interface DocumentTemplate {
  name: string;       // matches documentType ('contrato', 'proposta', etc.)
  filePath: string;   // absolute path to the PDF
  caption?: string;   // optional override for caption template
}

interface ContactRow {
  id: string;
  displayName: string | null;
  phoneNumber: string | null;
  rawJid: string | null;
}

export interface DocumentDispatchDeps {
  eventBus: InstanceEventBus;
  logger: pino.Logger;
  dataDir: string;   // process.env.DATA_DIR — base dir for fallback template resolution
  getTenantDb: (tenantId: string) => {
    $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T[]>;
  };
  sendMessage: (
    tenantId: string,
    instanceId: string,
    payload: {
      to: string;
      type: 'document';
      media: { base64: string; mimeType: string; fileName: string; caption: string };
    }
  ) => Promise<void>;
  getDocumentTemplates: (tenantId: string, instanceId: string) => Promise<DocumentTemplate[]>;
}

export class DocumentDispatchService {
  constructor(private readonly deps: DocumentDispatchDeps) {}

  async dispatch(
    event: AdminCommandEvent,
    documentType: string,
    clientName: string,
    sendResponse: (text: string) => Promise<void>
  ): Promise<void> {
    const { tenantId, instanceId } = event;

    // 1. Find contact by name
    const db = this.deps.getTenantDb(tenantId);
    const contacts = await db.$queryRawUnsafe<ContactRow>(
      `SELECT id, "displayName", "phoneNumber", "rawJid"
       FROM "Contact"
       WHERE LOWER("displayName") LIKE LOWER($1)
       LIMIT 6`,
      `%${clientName}%`
    );

    if (contacts.length === 0) {
      await sendResponse(`Nenhum contato encontrado com o nome "${clientName}".`);
      return;
    }

    if (contacts.length > 1) {
      const list = contacts
        .map((c, i) => `${i + 1}. ${c.displayName ?? 'Sem nome'} (${c.phoneNumber ?? c.rawJid ?? '?'})`)
        .join('\n');
      await sendResponse(
        `Encontrei ${contacts.length} contatos com esse nome:\n${list}\n\nQual deles? Responda com o número (1-${contacts.length}).`
      );
      return;
    }

    const contact = contacts[0];
    const contactJid = contact.rawJid ?? (contact.phoneNumber ? `${contact.phoneNumber}@s.whatsapp.net` : null);
    if (!contactJid) {
      await sendResponse(`Contato "${clientName}" não possui JID válido para envio.`);
      return;
    }

    // 2. Resolve document template path
    const templates = await this.deps.getDocumentTemplates(tenantId, instanceId);
    const template = templates.find((t) => t.name.toLowerCase() === documentType.toLowerCase());
    const filePath = template?.filePath ?? path.join(this.deps.dataDir, `${documentType}.pdf`);

    // 3. Size gate BEFORE reading file (DOC-04)
    let fileSize: number;
    try {
      const stats = await stat(filePath);
      fileSize = stats.size;
    } catch {
      await sendResponse(`Arquivo de ${documentType} não encontrado em ${filePath}. Verifique a configuração.`);
      return;
    }

    if (fileSize > MAX_DOC_BYTES) {
      await sendResponse(
        `⚠️ Arquivo excede 5 MB (${(fileSize / 1024 / 1024).toFixed(1)} MB) — verifique o documento antes de enviar`
      );
      return;
    }

    // 4. Read as base64 (file:// not supported by fetch — use base64 path)
    const fileBuffer = await readFile(filePath);
    const base64 = fileBuffer.toString('base64');
    const mimeType = mime.lookup(filePath) || 'application/pdf';

    // 5. Build personalized caption
    const typeCapitalized = documentType.charAt(0).toUpperCase() + documentType.slice(1);
    const contactDisplayName = contact.displayName ?? clientName;
    const captionTemplate = template?.caption ?? `Olá {clientName}, segue o {documentType} conforme combinado.`;
    const caption = captionTemplate
      .replace('{clientName}', contactDisplayName)
      .replace('{documentType}', documentType);
    const fileName = `${typeCapitalized} - ${contactDisplayName}.pdf`;

    // 6. Send via InstanceOrchestrator worker RPC
    await this.deps.sendMessage(tenantId, instanceId, {
      to: contactJid,
      type: 'document',
      media: { base64, mimeType, fileName, caption },
    });

    // 7. Emit document.sent event (deferred, non-blocking)
    setImmediate(() => {
      this.deps.eventBus.emit('document.sent', {
        type: 'document.sent',
        tenantId,
        instanceId,
        remoteJid: contactJid,
        sessionId: null,
      });
    });

    await sendResponse(`Documento "${fileName}" enviado para ${contactDisplayName} com sucesso.`);
  }
}
