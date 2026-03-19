import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import {
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  makeWASocket,
  type AnyMessageContent,
  type WASocket
} from "@whiskeysockets/baileys";
import type { MessageType, SendMessagePayload } from "@infracode/types";
import QRCode from "qrcode";
import { resolveReconnectDelay } from "../../lib/backoff.js";
import { useSqliteAuthState } from "./baileys-auth-store.js";

interface WorkerInitPayload {
  instanceId: string;
  tenantId: string;
  instanceName: string;
  authDirectory: string;
  sessionDbPath: string;
  proxyUrl?: string | null;
}

interface RpcCommand {
  type: "send-message";
  requestId: string;
  payload: SendMessagePayload;
}

interface DownloadMediaCommand {
  type: "download-media";
  requestId: string;
  rawMessage: Record<string, unknown>;
  messageKey: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
  };
}

interface LifecycleCommand {
  type: "pause" | "shutdown";
}

type IncomingCommand = RpcCommand | DownloadMediaCommand | LifecycleCommand;

interface ConnectionUpdateEvent {
  qr?: string;
  connection?: "open" | "close";
  lastDisconnect?: {
    error?: Error;
  };
}

interface UpsertMessageEvent {
  messages: Array<{
    key: {
      fromMe?: boolean | null;
      remoteJid?: string | null;
      id?: string | null;
    };
    message?: Record<string, unknown> | null;
    pushName?: string | null;
  }>;
}

const init = workerData as WorkerInitPayload;
let socket: WASocket | null = null;
let saveCreds: (() => Promise<void>) | null = null;
let closeAuthStore: (() => void) | null = null;
let reconnectAttempts = 0;
let stopping = false;
const store = makeInMemoryStore({});

const scheduleReconnect = async (message: string): Promise<void> => {
  if (stopping) {
    return;
  }

  if (reconnectAttempts >= 5) {
    emitStatus("DISCONNECTED", message);
    return;
  }

  const backoffMs = resolveReconnectDelay(reconnectAttempts);
  reconnectAttempts += 1;
  emitStatus("DISCONNECTED", message);
  log("warn", "Tentando reiniciar o worker da instancia", {
    attempt: reconnectAttempts,
    backoffMs,
    message
  });
  await delay(backoffMs);
  await startSocket();
};

const log = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void => {
  parentPort?.postMessage({
    type: "log",
    level,
    message,
    timestamp: new Date().toISOString(),
    context
  });
};

const emitStatus = (
  status: "INITIALIZING" | "QR_PENDING" | "CONNECTED" | "DISCONNECTED" | "BANNED" | "PAUSED",
  lastError?: string
): void => {
  parentPort?.postMessage({
    type: "status",
    status,
    reconnectAttempts,
    lastError
  });
};

const detectMessageType = (message: Record<string, unknown>): MessageType => {
  if ("imageMessage" in message) return "image";
  if ("videoMessage" in message) return "video";
  if ("audioMessage" in message) return "audio";
  if ("documentMessage" in message) return "document";
  if ("stickerMessage" in message) return "sticker";
  if ("locationMessage" in message) return "location";
  if ("contactMessage" in message || "contactsArrayMessage" in message) return "contact";
  if ("pollCreationMessage" in message || "pollCreationMessageV2" in message) return "poll";
  if ("listMessage" in message) return "list";
  if ("buttonsMessage" in message || "templateMessage" in message) return "buttons";
  return "text";
};

const serializeIncomingPayload = (rawMessage: Record<string, unknown>): Record<string, unknown> => {
  if ("conversation" in rawMessage) {
    return {
      text: rawMessage.conversation
    };
  }

  if ("extendedTextMessage" in rawMessage) {
    const extended = rawMessage.extendedTextMessage as { text?: string };
    return {
      text: extended.text ?? null
    };
  }

  return rawMessage;
};

const resolveMediaBuffer = async (media: { base64?: string; url?: string }): Promise<Buffer> => {
  if (media.base64) {
    return Buffer.from(media.base64, "base64");
  }

  if (media.url) {
    const response = await fetch(media.url, {
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      throw new Error(`Falha ao baixar midia: ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error("Midia ausente");
};

const convertAudioToOpus = async (inputBuffer: Buffer): Promise<Buffer> => {
  const binary = process.env.FFMPEG_PATH ?? "ffmpeg";
  const workdir = await mkdtemp(join(tmpdir(), "infracode-audio-"));
  const inputPath = join(workdir, "input.bin");
  const outputPath = join(workdir, "output.ogg");

  await writeFile(inputPath, inputBuffer);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [
      "-y",
      "-i",
      inputPath,
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-vn",
      outputPath
    ]);

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg finalizou com codigo ${code}`));
    });
  });

  const output = await readFile(outputPath);
  await rm(workdir, { recursive: true, force: true });
  return output;
};

const renderTemplate = (body: string, variables: Record<string, string>): string =>
  body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => variables[key] ?? "");

const toJid = (value: string): string => `${value.replace(/[^\d]/g, "")}@s.whatsapp.net`;

const buildMessageContent = async (payload: SendMessagePayload): Promise<AnyMessageContent> => {
  switch (payload.type) {
    case "text":
      return {
        text: payload.text
      };
    case "image":
      return {
        image: await resolveMediaBuffer(payload.media),
        caption: payload.media.caption
      };
    case "video":
      return {
        video: await resolveMediaBuffer(payload.media),
        caption: payload.media.caption
      };
    case "audio": {
      let audio = await resolveMediaBuffer(payload.media);
      let mimetype = payload.media.mimeType;
      let ptt = false;

      if (payload.media.convertToVoiceNote) {
        try {
          audio = await convertAudioToOpus(audio);
          mimetype = "audio/ogg; codecs=opus";
          ptt = true;
        } catch (error) {
          log("warn", "Falha ao converter audio com ffmpeg, enviando original", {
            error: error instanceof Error ? error.message : "unknown"
          });
        }
      }

      return {
        audio,
        mimetype,
        ptt
      };
    }
    case "document":
      return {
        document: await resolveMediaBuffer(payload.media),
        mimetype: payload.media.mimeType,
        fileName: payload.media.fileName ?? "documento"
      };
    case "sticker":
      return {
        sticker: await resolveMediaBuffer(payload.media)
      };
    case "location":
      return {
        location: {
          degreesLatitude: payload.latitude,
          degreesLongitude: payload.longitude,
          name: payload.name,
          address: payload.address
        }
      };
    case "contact":
      return {
        contacts: {
          displayName: payload.displayName,
          contacts: [{ vcard: payload.vcard }]
        }
      };
    case "poll":
      return {
        poll: {
          name: payload.title,
          values: payload.options,
          selectableCount: payload.selectableCount ?? 1
        }
      };
    case "reaction":
      return {
        react: {
          text: payload.emoji,
          key: {
            id: payload.targetMessageId,
            remoteJid: payload.targetJid ?? toJid(payload.to),
            fromMe: payload.fromMe ?? false,
            participant: payload.participant
          }
        }
      };
    case "list":
      return {
        text: payload.description,
        title: payload.title,
        footer: payload.footerText,
        buttonText: payload.buttonText,
        sections: payload.sections.map((section) => ({
          title: section.title,
          rows: section.rows.map((row) => ({
            rowId: row.id,
            title: row.title,
            description: row.description
          }))
        }))
      } as AnyMessageContent;
    case "buttons":
      return {
        text: payload.text,
        footer: payload.footerText,
        buttons: payload.buttons.slice(0, 3).map((button) => ({
          buttonId: button.id,
          buttonText: {
            displayText: button.text
          },
          type: 1
        }))
      } as AnyMessageContent;
    case "template":
      return {
        text: [renderTemplate(payload.body, payload.variables), payload.footerText].filter(Boolean).join("\n\n")
      };
  }
};

const disconnectSocket = async (): Promise<void> => {
  if (!socket) {
    return;
  }

  try {
    socket.ev.removeAllListeners("connection.update");
    socket.ev.removeAllListeners("creds.update");
    socket.ev.removeAllListeners("messages.upsert");
    socket.ws.close();
  } catch {
    // noop
  }

  socket = null;
};

const handleConnectionClose = async (error?: Error): Promise<void> => {
  if (stopping) {
    return;
  }

  const statusCode = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
  const loggedOut = statusCode === DisconnectReason.loggedOut;

  if (loggedOut) {
    emitStatus("BANNED", error?.message ?? "Sessao encerrada pelo WhatsApp");
    return;
  }

  await scheduleReconnect(error?.message ?? "Limite de reconexao excedido");
};

const startSocket = async (): Promise<void> => {
  try {
    stopping = false;
    emitStatus("INITIALIZING");
    await disconnectSocket();
    closeAuthStore?.();
    closeAuthStore = null;
    saveCreds = null;

    const authState = await useSqliteAuthState(init.sessionDbPath);
    saveCreds = authState.saveCreds;
    closeAuthStore = authState.close;

    if (init.proxyUrl) {
      log("warn", "Proxy configurado para a instancia, mas o adaptador HTTP/SOCKS5 nao foi habilitado neste build", {
        proxyUrl: init.proxyUrl
      });
    }

    const versionData = await fetchLatestBaileysVersion().catch(() => ({
      version: undefined
    }));

    const nextSocket = makeWASocket({
      auth: authState.state,
      browser: ["InfraCode", "Chrome", "1.0.0"],
      printQRInTerminal: false,
      syncFullHistory: false,
      ...(versionData.version ? { version: versionData.version } : {})
    });
    socket = nextSocket;
    store.bind(nextSocket.ev);

    nextSocket.ev.on("creds.update", async () => {
      try {
        await saveCreds?.();
      } catch (error) {
        log("error", "Falha ao salvar credenciais do Baileys", {
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    });

    nextSocket.ev.on("connection.update", async (update: unknown) => {
      try {
        const event = update as ConnectionUpdateEvent;
        if (event.qr) {
          const qrCodeBase64 = await QRCode.toDataURL(event.qr);
          emitStatus("QR_PENDING");
          parentPort?.postMessage({
            type: "qr",
            qrCodeBase64,
            expiresInSeconds: 60
          });
        }

        if (event.connection === "open") {
          reconnectAttempts = 0;
          emitStatus("CONNECTED");
          log("info", "Instancia conectada com sucesso");
          parentPort?.postMessage({
            type: "profile",
            phoneNumber: socket?.user?.id?.split(":")[0]?.split("@")[0] ?? null,
            avatarUrl: null
          });
        }

        if (event.connection === "close") {
          await handleConnectionClose(event.lastDisconnect?.error as Error | undefined);
        }
      } catch (error) {
        log("error", "Falha ao processar evento de conexao do Baileys", {
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    });

    nextSocket.ev.on("messages.upsert", async (payload: unknown) => {
      try {
        const { messages } = payload as UpsertMessageEvent;
        for (const message of messages) {
          if (message.key.fromMe || !message.key.remoteJid || !message.message) {
            continue;
          }

          parentPort?.postMessage({
            type: "inbound-message",
            remoteJid: message.key.remoteJid,
            externalMessageId: message.key.id,
            payload: {
              ...serializeIncomingPayload(message.message as Record<string, unknown>),
              pushName: message.pushName ?? null
            },
            messageType: detectMessageType(message.message as Record<string, unknown>),
            rawMessage: message.message as Record<string, unknown>,
            messageKey: {
              remoteJid: message.key.remoteJid,
              id: message.key.id,
              fromMe: message.key.fromMe
            }
          });
        }
      } catch (error) {
        log("error", "Falha ao processar mensagem recebida no worker", {
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha inesperada ao iniciar o worker";
    log("error", "Falha ao iniciar o socket da instancia", {
      error: message
    });
    await scheduleReconnect(message);
  }
};

const handleSendMessage = async (command: RpcCommand): Promise<void> => {
  try {
    const activeSocket = socket;

    if (!activeSocket || !activeSocket.user) {
      throw new Error("Instancia nao conectada");
    }

    const payload = command.payload;
    const jid = payload.targetJid ?? toJid(payload.to);
    let resolvedJid = jid;
    if (!jid.endsWith("@g.us") && !jid.endsWith("@lid")) {
      try {
        const onWhatsAppResult = await activeSocket.onWhatsApp(payload.to);
        const result = Array.isArray(onWhatsAppResult) ? onWhatsAppResult[0] : undefined;
        if (result?.exists && result.jid) {
          resolvedJid = result.jid;
          log("info", `JID resolvido via onWhatsApp: ${resolvedJid}`);
        }
      } catch {
        log("warn", "Falha ao resolver JID via onWhatsApp, usando JID padrao");
      }
    }
    const mentionJids = payload.mentionNumbers?.map((number) => toJid(number)) ?? [];

    if (payload.simulateTypingMs && payload.simulateTypingMs > 0) {
      await activeSocket.presenceSubscribe(resolvedJid);
      await activeSocket.sendPresenceUpdate("composing", resolvedJid);
      await delay(payload.simulateTypingMs);
      await activeSocket.sendPresenceUpdate("paused", resolvedJid);
    }

    const content = await buildMessageContent(payload);

    if (mentionJids.length > 0) {
      Object.assign(content as Record<string, unknown>, { mentions: mentionJids });
    }

    const sendOptions =
      payload.replyToMessageId
        ? {
            quoted: {
              key: {
                id: payload.replyToMessageId,
                remoteJid: resolvedJid,
                fromMe: false
              },
              message: {}
            }
          }
        : undefined;

    if (resolvedJid.endsWith("@g.us")) {
      try {
        await activeSocket.groupMetadata(resolvedJid);
      } catch (error) {
        log("warn", "Falha ao sincronizar metadados do grupo antes do envio", {
          error: error instanceof Error ? error.message : "unknown",
          jid: resolvedJid
        });
      }
    }

    const result = await activeSocket.sendMessage(resolvedJid, content, sendOptions);

    if (!result) {
      throw new Error("Baileys nao retornou confirmacao de envio");
    }

    if (payload.markAsRead) {
      await activeSocket.readMessages([result.key]);
    }

    parentPort?.postMessage({
      type: "rpc-result",
      requestId: command.requestId,
      data: {
        externalMessageId: result.key.id ?? null,
        remoteJid: result.key.remoteJid ?? resolvedJid
      }
    });
  } catch (error) {
    parentPort?.postMessage({
      type: "rpc-error",
      requestId: command.requestId,
      error: {
        message: error instanceof Error ? error.message : "Falha ao enviar mensagem"
      }
    });
  }
};

const handleDownloadMedia = async (command: DownloadMediaCommand): Promise<void> => {
  try {
    if (!socket) {
      throw new Error("Instancia nao conectada");
    }

    const audioMsg = command.rawMessage?.audioMessage ?? command.rawMessage?.pttMessage;
    const imageMsg = command.rawMessage?.imageMessage;

    let mediaContent: Record<string, unknown> | undefined;
    let mediaType: string;

    if (audioMsg) {
      mediaContent = audioMsg as Record<string, unknown>;
      mediaType = "audio";
    } else if (imageMsg) {
      mediaContent = imageMsg as Record<string, unknown>;
      mediaType = "image";
    } else {
      throw new Error("Mensagem nao contem midia baixavel");
    }

    const chunks: Buffer[] = [];
    const stream = await downloadContentFromMessage(
      mediaContent as never,
      mediaType as never
    );

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    const buffer = Buffer.concat(chunks);
    const base64 = buffer.toString("base64");
    const mimeType = (mediaContent?.mimetype as string | undefined) ?? null;

    parentPort?.postMessage({
      type: "rpc-result",
      requestId: command.requestId,
      data: { buffer: base64, mimeType }
    });
  } catch (error) {
    parentPort?.postMessage({
      type: "rpc-error",
      requestId: command.requestId,
      error: {
        message: error instanceof Error ? error.message : "Falha ao baixar midia"
      }
    });
  }
};

parentPort?.on("message", async (command: IncomingCommand) => {
  if (command.type === "send-message") {
    await handleSendMessage(command);
    return;
  }

  if (command.type === "download-media") {
    await handleDownloadMedia(command);
    return;
  }

  stopping = true;
  await disconnectSocket();
  closeAuthStore?.();

  if (command.type === "pause") {
    emitStatus("PAUSED");
  }

  process.exit(0);
});

void startSocket();
