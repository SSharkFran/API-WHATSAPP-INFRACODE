import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import baileys from "@whiskeysockets/baileys";
import type { AnyMessageContent, WASocket } from "@whiskeysockets/baileys";
import type { MessageType, SendMessagePayload } from "@infracode/types";
import QRCode from "qrcode";
import { resolveReconnectDelay } from "../../lib/backoff.js";
import { useSqliteAuthState } from "./baileys-auth-store.js";
import {
  DECRYPT_FAILURE_BURST_THRESHOLD,
  createDecryptFailureBurstDetector
} from "./decrypt-failure-burst.js";

const {
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  makeWASocket,
  proto
} = baileys;

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
  type: "pause" | "shutdown" | "logout";
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
      participant?: string | null;
    };
    message?: Record<string, unknown> | null;
    messageStubType?: number | null;
    messageStubParameters?: unknown[] | null;
    pushName?: string | null;
  }>;
}

interface ChatMappingPayload {
  id?: string | null;
  pnJid?: string | null;
  lidJid?: string | null;
}

const init = workerData as WorkerInitPayload;
let socket: WASocket | null = null;
let saveCreds: (() => Promise<void>) | null = null;
let closeAuthStore: (() => void) | null = null;
let reconnectAttempts = 0;
let stopping = false;
let reconnectPromise: Promise<void> | null = null;
let reconnectToken = 0;
let activeStartPromise: Promise<void> | null = null;
let socketGeneration = 0;
let decryptFailureRecoveryPromise: Promise<void> | null = null;
const store = makeInMemoryStore({});
const RESOLVED_JID_CACHE_TTL_MS = 5 * 60 * 1000;
const resolvedJidCache = new Map<string, { jid: string; timeout: NodeJS.Timeout }>();
const lidToPhoneJidCache = new Map<string, string>();
const decryptFailureBurstDetector = createDecryptFailureBurstDetector();

const clearResolvedJidCache = (): void => {
  for (const entry of resolvedJidCache.values()) {
    clearTimeout(entry.timeout);
  }

  resolvedJidCache.clear();
};

const clearLidToPhoneJidCache = (): void => {
  lidToPhoneJidCache.clear();
};

const getCachedResolvedJid = (phoneNumber: string): string | null => resolvedJidCache.get(phoneNumber)?.jid ?? null;

const normalizeJidCacheKey = (jid?: string | null): string | null => {
  const trimmed = jid?.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/:\d+(?=@)/, "");
};

const rememberLidToPhoneJid = (lid?: string | null, jid?: string | null): void => {
  const lidKey = normalizeJidCacheKey(lid);
  const phoneJid = normalizeJidCacheKey(jid);

  if (!lidKey || !phoneJid) {
    return;
  }

  lidToPhoneJidCache.set(lidKey, phoneJid);
};

const resolveSenderJid = (jid?: string | null): string | null => {
  const normalized = normalizeJidCacheKey(jid);

  if (!normalized) {
    return null;
  }

  return lidToPhoneJidCache.get(normalized) ?? normalized;
};

const setCachedResolvedJid = (phoneNumber: string, jid: string): void => {
  const existing = resolvedJidCache.get(phoneNumber);

  if (existing) {
    clearTimeout(existing.timeout);
  }

  const timeout = setTimeout(() => {
    resolvedJidCache.delete(phoneNumber);
  }, RESOLVED_JID_CACHE_TTL_MS);
  timeout.unref?.();

  resolvedJidCache.set(phoneNumber, {
    jid,
    timeout
  });
};

const clearPendingReconnect = (): void => {
  reconnectToken += 1;
  reconnectPromise = null;
};

const scheduleReconnect = async (message: string): Promise<void> => {
  if (stopping) {
    return;
  }

  if (reconnectAttempts >= 5) {
    emitStatus("DISCONNECTED", message);
    return;
  }

  if (reconnectPromise) {
    log("info", "Reconexao ja agendada para a instancia, ignorando disparo duplicado", {
      attempt: reconnectAttempts,
      message
    });
    return reconnectPromise;
  }

  const token = ++reconnectToken;
  const backoffMs = resolveReconnectDelay(reconnectAttempts);
  reconnectAttempts += 1;
  emitStatus("DISCONNECTED", message);
  log("warn", "Tentando reiniciar o worker da instancia", {
    attempt: reconnectAttempts,
    backoffMs,
    message
  });
  reconnectPromise = (async () => {
    await delay(backoffMs);

    if (stopping || token !== reconnectToken) {
      return;
    }

    await startSocket();
  })().finally(() => {
    if (token === reconnectToken) {
      reconnectPromise = null;
    }
  });

  return reconnectPromise;
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

const normalizeBaileysContext = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(input)) {
    if (raw instanceof Error) {
      output[key] = raw.message;
      continue;
    }

    if (raw && typeof raw === "object") {
      const nested = raw as Record<string, unknown>;
      if (nested.message && typeof nested.message === "string") {
        output[key] = nested.message;
        continue;
      }
    }

    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      output[key] = raw;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
};

const scheduleDecryptFailureRecovery = (recentFailures: number): void => {
  if (stopping || decryptFailureRecoveryPromise) {
    return;
  }

  decryptFailureRecoveryPromise = (async () => {
    log("warn", "Rajada de falhas de decrypt detectada, reiniciando o socket", {
      instanceId: init.instanceId,
      recentFailures,
      threshold: DECRYPT_FAILURE_BURST_THRESHOLD
    });

    try {
      await disconnectSocket();
    } catch (error) {
      log("warn", "Falha ao encerrar socket apos rajada de decrypt", {
        error: error instanceof Error ? error.message : "unknown",
        instanceId: init.instanceId
      });
    }

    try {
      await scheduleReconnect("Rajada de Bad MAC detectada");
    } catch (error) {
      log("error", "Falha ao agendar reconexao apos rajada de decrypt", {
        error: error instanceof Error ? error.message : "unknown"
      });
    }
  })().finally(() => {
    decryptFailureRecoveryPromise = null;
  });
};

const recordDecryptFailureSignal = (message: string, context?: Record<string, unknown>): void => {
  const result = decryptFailureBurstDetector.recordSignal(message, context);

  if (result.shouldRecover) {
    scheduleDecryptFailureRecovery(result.failureCount);
  }
};

interface BaileysLoggerLike {
  level: string;
  child: () => BaileysLoggerLike;
  trace: (obj?: unknown, msg?: string) => void;
  debug: (obj?: unknown, msg?: string) => void;
  info: (obj?: unknown, msg?: string) => void;
  warn: (obj?: unknown, msg?: string) => void;
  error: (obj?: unknown, msg?: string) => void;
  fatal: (obj?: unknown, msg?: string) => void;
}

const createBaileysLogger = (): BaileysLoggerLike => {
  const forward = (level: "info" | "warn" | "error", obj?: unknown, msg?: string): void => {
    const message = typeof obj === "string" ? obj : msg ?? "Evento do Baileys";
    const context = normalizeBaileysContext(typeof obj === "string" ? undefined : obj) ?? {};
    context.instanceId = init.instanceId;
    log(level, message, context);
    recordDecryptFailureSignal(message, context);
  };

  const logger = {
    level: "info",
    child: () => logger,
    trace: (obj?: unknown, msg?: string) => forward("info", obj, msg),
    debug: (obj?: unknown, msg?: string) => forward("info", obj, msg),
    info: (obj?: unknown, msg?: string) => forward("info", obj, msg),
    warn: (obj?: unknown, msg?: string) => forward("warn", obj, msg),
    error: (obj?: unknown, msg?: string) => forward("error", obj, msg),
    fatal: (obj?: unknown, msg?: string) => forward("error", obj, msg)
  };

  return logger;
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

const unwrapIncomingMessageContent = (
  rawMessage?: Record<string, unknown> | null
): Record<string, unknown> | null => {
  if (!rawMessage || typeof rawMessage !== "object") {
    return null;
  }

  const wrapperCandidates = [
    rawMessage.ephemeralMessage,
    rawMessage.viewOnceMessage,
    rawMessage.viewOnceMessageV2,
    rawMessage.viewOnceMessageV2Extension,
    rawMessage.documentWithCaptionMessage,
    rawMessage.editedMessage,
    rawMessage.deviceSentMessage
  ];

  for (const candidate of wrapperCandidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const nestedMessage =
      "message" in candidate && candidate.message && typeof candidate.message === "object"
        ? (candidate.message as Record<string, unknown>)
        : null;

    if (!nestedMessage) {
      continue;
    }

    return unwrapIncomingMessageContent(nestedMessage) ?? nestedMessage;
  }

  return rawMessage;
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

const emitChatPhoneMapping = (chat: ChatMappingPayload | null | undefined): void => {
  if (!chat) {
    return;
  }

  const lid =
    typeof chat.lidJid === "string" && chat.lidJid.trim()
      ? chat.lidJid.trim()
      : typeof chat.id === "string" && chat.id.endsWith("@lid")
        ? chat.id
        : null;
  const jid =
    typeof chat.pnJid === "string" && chat.pnJid.trim()
      ? chat.pnJid.trim()
      : typeof chat.id === "string" && /@(s\.whatsapp\.net|c\.us)$/i.test(chat.id)
        ? chat.id
        : null;

  if (!lid || !jid) {
    return;
  }

  rememberLidToPhoneJid(lid, jid);

  parentPort?.postMessage({
    type: "chat-phone-mapping",
    lid,
    jid
  });
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

  throw new Error("Media payload missing both base64 and url");
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
  clearResolvedJidCache();
  clearLidToPhoneJidCache();
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
  if (activeStartPromise) {
    return activeStartPromise;
  }

  const currentStartPromise = (async () => {
    try {
      stopping = false;
      decryptFailureBurstDetector.reset();
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
      const generation = ++socketGeneration;
      const nextSocket = makeWASocket({
        auth: authState.state,
        browser: ["InfraCode", "Chrome", "1.0.0"],
        logger: createBaileysLogger() as never,
        printQRInTerminal: false,
        syncFullHistory: false,
        ...(versionData.version ? { version: versionData.version } : {})
      });
      socket = nextSocket;
      store.bind(nextSocket.ev);

      const isStaleSocketEvent = (): boolean => socket !== nextSocket || generation !== socketGeneration;

      nextSocket.ev.on("creds.update", async () => {
        if (isStaleSocketEvent()) {
          return;
        }

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
          if (isStaleSocketEvent()) {
            return;
          }

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
            decryptFailureBurstDetector.reset();
            clearPendingReconnect();
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
          if (isStaleSocketEvent()) {
            return;
          }

          const { messages } = payload as UpsertMessageEvent;
          for (const message of messages) {
            if (!message.key.remoteJid) {
              continue;
            }

            if (message.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
              const stubReason = Array.isArray(message.messageStubParameters)
                ? message.messageStubParameters
                    .filter((value: unknown): value is string => typeof value === "string")
                    .join(" | ")
                : undefined;

              log("warn", "Mensagem recebida como ciphertext no worker", {
                instanceId: init.instanceId,
                remoteJid: message.key.remoteJid,
                externalMessageId: message.key.id ?? undefined,
                stubReason
              });
              recordDecryptFailureSignal("failed to decrypt message", {
                externalMessageId: message.key.id ?? undefined,
                remoteJid: message.key.remoteJid,
                reason: stubReason ?? "ciphertext_stub"
              });
              continue;
            }

            if (!message.message) {
              continue;
            }

            const normalizedMessage =
              unwrapIncomingMessageContent(message.message as Record<string, unknown>) ??
              (message.message as Record<string, unknown>);
            const serializedPayload = serializeIncomingPayload(normalizedMessage);
            const participantJid = normalizeJidCacheKey(message.key.participant);
            const baseSenderJid =
              participantJid ??
              (message.key.fromMe
                ? normalizeJidCacheKey(socket?.user?.id ?? null)
                : normalizeJidCacheKey(message.key.remoteJid));
            const senderJid = resolveSenderJid(baseSenderJid) ?? normalizeJidCacheKey(message.key.remoteJid);

            parentPort?.postMessage({
              type: "inbound-message",
              remoteJid: message.key.remoteJid,
              senderJid,
              externalMessageId: message.key.id,
              payload: {
                ...serializedPayload,
                pushName: message.pushName ?? null
              },
              messageType: detectMessageType(normalizedMessage),
              rawMessage: normalizedMessage,
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

      nextSocket.ev.on("chats.phoneNumberShare", ({ lid, jid }) => {
        if (isStaleSocketEvent()) {
          return;
        }

        rememberLidToPhoneJid(lid, jid);

        parentPort?.postMessage({
          type: "phone-number-share",
          lid,
          jid
        });
      });

      nextSocket.ev.on("messaging-history.set", ({ chats }) => {
        if (isStaleSocketEvent()) {
          return;
        }

        for (const chat of chats) {
          emitChatPhoneMapping(chat as ChatMappingPayload);
        }
      });

      nextSocket.ev.on("chats.upsert", (chats) => {
        if (isStaleSocketEvent()) {
          return;
        }

        for (const chat of chats) {
          emitChatPhoneMapping(chat as ChatMappingPayload);
        }
      });

      nextSocket.ev.on("chats.update", (chats) => {
        if (isStaleSocketEvent()) {
          return;
        }

        for (const chat of chats) {
          emitChatPhoneMapping(chat as ChatMappingPayload);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha inesperada ao iniciar o worker";
      log("error", "Falha ao iniciar o socket da instancia", {
        error: message
      });
      try {
        await scheduleReconnect(message);
      } catch (reconnectError) {
        log("error", "Falha ao agendar reconexao apos erro de inicializacao", {
          error: reconnectError instanceof Error ? reconnectError.message : "unknown"
        });
      }
    }
  })();

  activeStartPromise = currentStartPromise;

  try {
    await currentStartPromise;
  } finally {
    if (activeStartPromise === currentStartPromise) {
      activeStartPromise = null;
    }
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
    const normalizedPhone = payload.to.replace(/[^\d]/g, "");

    if (!jid.endsWith("@g.us") && !jid.endsWith("@lid")) {
      const cachedResolvedJid = normalizedPhone ? getCachedResolvedJid(normalizedPhone) : null;

      if (cachedResolvedJid) {
        resolvedJid = cachedResolvedJid;
      } else if (payload.targetJid?.trim()) {
        resolvedJid = payload.targetJid.trim();
        if (normalizedPhone) {
          setCachedResolvedJid(normalizedPhone, resolvedJid);
        }
      } else {
        try {
          const onWhatsAppResult = await activeSocket.onWhatsApp(payload.to);
          const result = Array.isArray(onWhatsAppResult) ? onWhatsAppResult[0] : undefined;
          if (result?.exists && result.jid) {
            resolvedJid = result.jid;
            if (normalizedPhone) {
              setCachedResolvedJid(normalizedPhone, resolvedJid);
            }
            log("info", `JID resolvido via onWhatsApp: ${resolvedJid}`);
          }
        } catch {
          log("warn", "Falha ao resolver JID via onWhatsApp, usando JID padrao");
        }
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
  clearPendingReconnect();

  if (command.type === "logout") {
    try {
      await socket?.logout();
    } catch (error) {
      log("warn", "Falha ao executar logout do Baileys", {
        error: error instanceof Error ? error.message : "unknown"
      });
    }
  }

  await disconnectSocket();
  closeAuthStore?.();

  if (command.type === "pause") {
    emitStatus("PAUSED");
  } else {
    emitStatus("DISCONNECTED");
  }

  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log("error", "Promise rejeitada sem tratamento no worker", {
    reason: message
  });
});

startSocket().catch((error) => {
  log("error", "Falha nao tratada ao iniciar o socket", {
    error: error instanceof Error ? error.message : String(error)
  });
});
