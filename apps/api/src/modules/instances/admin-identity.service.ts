import { normalizePhoneNumber } from "../../lib/phone.js";

export interface AdminIdentityContext {
  isAdmin: boolean;
  isVerifiedAdmin: boolean;
  isInstanceSelf: boolean;
  isAdminSelfChat: boolean;
  canReceiveLearningReply: boolean;
  matchedAdminPhone: string | null;
  escalationConversationId: string | null;
  // Derived composite flags (for handleInboundMessage usage)
  isAdminOrInstanceSender: boolean;
  shouldBypassDirectSenderTakeover: boolean;
  isAdminLearningReply: boolean;
}

export interface AdminIdentityInput {
  remoteJid: string;
  senderJid: string | undefined;
  fromMe: boolean | null | undefined;
  rawTextInput: string;
  adminCandidatePhones: Array<string | null>;
  aprendizadoContinuoModule: {
    isEnabled: boolean;
    verificationStatus: string;
    configuredAdminPhone?: string | null;
    verifiedPhone?: string | null;
    verifiedPhones: string[];
    additionalAdminPhones?: string[] | null;
    verifiedRemoteJids: string[];
    verifiedSenderJids: string[];
  } | null;
  instanceOwnPhone: string | null;
  contactPhoneNumber: string | null;
  sharedPhoneJid: string | null;
  lastRemoteJid: string | null;
  escalationConversationId: string | null; // pre-computed by handleInboundMessage
  // phone candidates (already computed upstream)
  senderNumber: string | null;
  remoteChatNumber: string | null;
  resolvedContactNumber: string | null;
  remoteNumber: string | null;
  realPhoneFromRemoteJid: string | null;
  cleanPhoneFromRemoteJid: string;
  sharedPhoneNumberFromFields: string | null;
  lastRemoteNumber: string | null;
}

export class AdminIdentityService {
  public resolve(input: AdminIdentityInput): AdminIdentityContext {
    const {
      fromMe,
      adminCandidatePhones,
      aprendizadoContinuoModule,
      instanceOwnPhone,
      escalationConversationId,
      senderNumber,
      remoteChatNumber,
      resolvedContactNumber,
      contactPhoneNumber,
      remoteNumber,
      realPhoneFromRemoteJid,
      cleanPhoneFromRemoteJid,
      sharedPhoneNumberFromFields,
      lastRemoteNumber,
      sharedPhoneJid,
      lastRemoteJid,
      remoteJid,
      senderJid
    } = input;

    const verifiedAdminPhones: Array<string | null> =
      aprendizadoContinuoModule?.isEnabled && aprendizadoContinuoModule.verificationStatus === "VERIFIED"
        ? [
            aprendizadoContinuoModule.configuredAdminPhone ?? null,
            aprendizadoContinuoModule.verifiedPhone ?? null,
            ...aprendizadoContinuoModule.verifiedPhones,
            ...(aprendizadoContinuoModule.additionalAdminPhones ?? [])
          ]
        : [];

    const verifiedAdminJids: Array<string | null> =
      aprendizadoContinuoModule?.isEnabled && aprendizadoContinuoModule.verificationStatus === "VERIFIED"
        ? [
            ...aprendizadoContinuoModule.verifiedRemoteJids,
            ...aprendizadoContinuoModule.verifiedSenderJids
          ]
        : [];

    const adminSenderCandidates = [
      senderNumber,
      remoteChatNumber,
      resolvedContactNumber,
      normalizePhoneNumber(contactPhoneNumber ?? ""),
      remoteNumber,
      realPhoneFromRemoteJid,
      cleanPhoneFromRemoteJid,
      sharedPhoneNumberFromFields,
      lastRemoteNumber
    ];

    const matchedAdminPhone = this.findMatchingExpectedPhone(adminCandidatePhones, adminSenderCandidates);
    const matchedVerifiedAdminPhone = this.findMatchingExpectedPhone(verifiedAdminPhones, adminSenderCandidates);

    // Para mensagens fromMe (echoes), remoteJid é o destinatário — não o remetente.
    // Usar remoteJid para detectar admin sender causaria falso positivo quando o bot envia para o admin.
    const isVerifiedAprendizadoContinuoAdminSender = !fromMe && (
      Boolean(matchedVerifiedAdminPhone) ||
      this.matchesAnyExpectedJids(verifiedAdminJids, [
        remoteJid,
        senderJid,
        sharedPhoneJid,
        lastRemoteJid
      ])
    );

    const isAdminSender = Boolean(matchedAdminPhone);
    const isAdminLearningReply = Boolean(escalationConversationId && isVerifiedAprendizadoContinuoAdminSender);

    const isInstanceSender = Boolean(
      instanceOwnPhone &&
      this.phonesMatch(instanceOwnPhone, [
        senderNumber,
        remoteChatNumber,
        resolvedContactNumber,
        normalizePhoneNumber(contactPhoneNumber ?? ""),
        remoteNumber,
        realPhoneFromRemoteJid,
        cleanPhoneFromRemoteJid,
        sharedPhoneNumberFromFields,
        lastRemoteNumber
      ])
    );

    const isAdminOrInstanceSender =
      isAdminSender ||
      isVerifiedAprendizadoContinuoAdminSender ||
      isAdminLearningReply ||
      isInstanceSender;

    // IMPORTANTE: isInstanceSender NAO deve entrar aqui — echoes fromMe do proprio bot
    // podem ter awaitingAdminResponse=true ativo e disparariam aprendizado incorreto.
    const canReceiveLearningReply =
      isVerifiedAprendizadoContinuoAdminSender ||
      isAdminLearningReply;

    const isAdminSelfChat = Boolean(
      isAdminSender &&
      remoteChatNumber &&
      this.matchesAnyExpectedPhones(adminCandidatePhones, [remoteChatNumber])
    );

    const isInstanceSelfChat = Boolean(
      isInstanceSender && instanceOwnPhone && remoteChatNumber === instanceOwnPhone
    );

    // Admin verificado do aprendizadoContinuo nunca deve acionar human takeover no chat de alerta
    const isVerifiedAdminEscalationChat = Boolean(isVerifiedAprendizadoContinuoAdminSender || isAdminLearningReply);
    const shouldBypassDirectSenderTakeover = isAdminSelfChat || isInstanceSelfChat || isVerifiedAdminEscalationChat;

    return {
      isAdmin: isAdminSender,
      isVerifiedAdmin: isVerifiedAprendizadoContinuoAdminSender,
      isInstanceSelf: isInstanceSender,
      isAdminSelfChat,
      canReceiveLearningReply,
      matchedAdminPhone,
      escalationConversationId,
      isAdminOrInstanceSender,
      shouldBypassDirectSenderTakeover,
      isAdminLearningReply
    };
  }

  public buildPhoneMatchVariants(phone?: string | null): string[] {
    const normalized = normalizePhoneNumber(phone ?? "");

    if (!normalized) {
      return [];
    }

    const variants = new Set<string>([normalized]);
    const withoutCountryCode =
      normalized.startsWith("55") && normalized.length > 11 ? normalized.slice(2) : normalized;

    variants.add(withoutCountryCode);

    if (withoutCountryCode.length === 11 && withoutCountryCode[2] === "9") {
      variants.add(`${withoutCountryCode.slice(0, 2)}${withoutCountryCode.slice(3)}`);
    }

    if (normalized.startsWith("55") && withoutCountryCode.length === 11 && withoutCountryCode[2] === "9") {
      variants.add(`55${withoutCountryCode.slice(0, 2)}${withoutCountryCode.slice(3)}`);
    }

    return [...variants].filter(Boolean);
  }

  public phonesMatch(expected?: string | null, candidates: Array<string | null | undefined> = []): boolean {
    const expectedVariants = new Set(this.buildPhoneMatchVariants(expected));

    if (expectedVariants.size === 0) {
      return false;
    }

    return candidates.some((candidate) => {
      const candidateVariants = this.buildPhoneMatchVariants(candidate);
      return candidateVariants.some((variant) => expectedVariants.has(variant));
    });
  }

  public matchesAnyExpectedPhones(
    expectedPhones: Array<string | null | undefined>,
    candidates: Array<string | null | undefined> = []
  ): boolean {
    return expectedPhones.some((expectedPhone) => this.phonesMatch(expectedPhone, candidates));
  }

  public buildJidMatchVariants(jid?: string | null): string[] {
    const trimmed = jid?.trim();

    if (!trimmed) {
      return [];
    }

    const variants = new Set<string>([trimmed]);
    const withoutDeviceSuffix = trimmed.replace(/:\d+(?=@)/, "");
    variants.add(withoutDeviceSuffix);

    const localPart = withoutDeviceSuffix.split("@")[0] ?? "";
    const digits = normalizePhoneNumber(localPart);

    if (digits) {
      variants.add(digits);
      variants.add(`${digits}@s.whatsapp.net`);
      variants.add(`${digits}@c.us`);
      variants.add(`${digits}@lid`);
    }

    return [...variants].filter(Boolean);
  }

  public jidsMatch(expected?: string | null, candidates: Array<string | null | undefined> = []): boolean {
    const expectedVariants = new Set(this.buildJidMatchVariants(expected));

    if (expectedVariants.size === 0) {
      return false;
    }

    return candidates.some((candidate) => {
      const candidateVariants = this.buildJidMatchVariants(candidate);
      return candidateVariants.some((variant) => expectedVariants.has(variant));
    });
  }

  public matchesAnyExpectedJids(
    expectedJids: Array<string | null | undefined>,
    candidates: Array<string | null | undefined> = []
  ): boolean {
    return expectedJids.some((expectedJid) => this.jidsMatch(expectedJid, candidates));
  }

  public findMatchingExpectedPhone(
    expectedPhones: Array<string | null | undefined>,
    candidates: Array<string | null | undefined> = []
  ): string | null {
    for (const expectedPhone of expectedPhones) {
      if (this.phonesMatch(expectedPhone, candidates)) {
        return expectedPhone ?? null;
      }
    }

    return null;
  }
}
