commit e95c1c3f628bcd23395c7a8b4e4469527d094143
Author: Codex Local <codex-local@infracode.dev>
Date:   Fri Apr 24 23:11:29 2026 -0500

    feat(08-02): implement confirmation gate in EscalationService.processAdminReply()
    
    - Add PendingConfirmationEntry interface for Redis-backed confirmation state
    - Add normalizeConfirmation() helper (NFD normalize, lowercase, trim)
    - Phase 1: admin reply -> Redis key confirmation:${instanceId}:${adminPhone} EX 600 + echo sent
    - Phase 2: admin SIM -> atomic redis.del() returns 1 -> knowledgeService.save() called
    - Non-SIM replies in Phase 2 silently dropped (casual replies like 'ok', 'claro')
    - 4-hour escalation window: set escalation:window:${instanceId}:${conversationId} EX 14400 on notifyAdmin
    - Add recoverExpiredEscalations() for server restart recovery (Pitfall 3)
    - Add adminPhone optional param to processAdminReply() and _processAdminReplyInternal()
    - Legacy path (no Redis) preserves direct knowledgeService.save() behavior

diff --git a/apps/api/src/modules/chatbot/escalation.service.ts b/apps/api/src/modules/chatbot/escalation.service.ts
index 2fa41a6..e12a9bf 100644
--- a/apps/api/src/modules/chatbot/escalation.service.ts
+++ b/apps/api/src/modules/chatbot/escalation.service.ts
@@ -14,6 +14,16 @@ interface EscalationServiceDeps {
   webhookService?: WebhookService;
 }
 
+interface PendingConfirmationEntry {
+  tenantId: string;
+  instanceId: string;
+  question: string;
+  synthesizedAnswer: string;
+  rawAnswer: string;
+  conversationId: string | null;
+  adminJid: string;
+}
+
 interface EscalationContext {
   tenantId: string;
   instanceId: string;
@@ -224,6 +234,13 @@ export class EscalationService {
       }
 
       this.trackAdminAlertRouting(result.externalMessageId, result.remoteJid, ctx.conversationId);
+      // Janela de 4 horas: se admin nao responder dentro deste TTL, a escalacao pode ser marcada
+      // como sem resposta via recoverExpiredEscalations() na inicializacao do servidor.
+      void this.redis?.set(
+        `escalation:window:${ctx.instanceId}:${ctx.conversationId}`,
+        "1",
+        "EX", 14400 // 4 horas em segundos
+      ).catch(() => null);
       this.scheduleEscalationRetry(ctx);
       const existingAdminContact = await prisma.contact.findUnique({
         where: {
@@ -296,15 +313,34 @@ export class EscalationService {
     }
   }
 
+  /**
+   * Normaliza input do admin para comparacao com "sim".
+   * Remove acentos, converte para lowercase, faz trim.
+   */
+  private normalizeConfirmation(input: string): string {
+    return input
+      .normalize("NFD")
+      .replace(/[\u0300-\u036f]/g, "")
+      .toLowerCase()
+      .trim();
+  }
+
   /**
    * Processa resposta do admin, aprende e retorna dados para responder o cliente.
-   * Retorna null se nao houver conversa pausada aguardando resposta.
+   *
+   * Implementa gate de confirmacao em duas fases (APR-02, APR-04):
+   * - Fase 1: Admin envia resposta → sistema envia eco de confirmacao, NAO escreve no KB
+   * - Fase 2: Admin responde "SIM" → sistema ingere no KB atomicamente via Redis DEL
+   *
+   * Retorna null se nao houver conversa pausada aguardando resposta, ou se a resposta
+   * estiver aguardando confirmacao (Fase 1) ou for descartada (nao-SIM na Fase 2).
    */
   public async processAdminReply(
     tenantId: string,
     instanceId: string,
     adminRawAnswer: string,
-    targetConversationId?: string | null
+    targetConversationId?: string | null,
+    adminPhone?: string | null
   ): Promise<{
     clientJid: string;
     clientQuestion: string;
@@ -312,6 +348,61 @@ export class EscalationService {
     conversationId: string;
     savedKnowledgeId: string;
   } | null> {
+    // ── Fase 2: verificar se ha confirmacao pendente para este admin ──────────
+    if (this.redis && adminPhone) {
+      const confirmationKey = `confirmation:${instanceId}:${adminPhone}`;
+      const pending = await this.redis.get(confirmationKey).catch(() => null);
+      if (pending) {
+        const normalized = this.normalizeConfirmation(adminRawAnswer);
+        if (normalized.startsWith("sim")) {
+          // Atomico: DEL retorna 1 se a chave existia — previne dupla ingestao
+          const deleted = await this.redis.del(confirmationKey).catch(() => 0);
+          if (deleted === 1) {
+            try {
+              const entry: PendingConfirmationEntry = JSON.parse(pending);
+              const savedKnowledge = await this.knowledgeService.save(
+                entry.tenantId,
+                entry.instanceId,
+                entry.question,
+                entry.synthesizedAnswer,
+                entry.rawAnswer,
+                entry.adminJid
+              );
+              void this.webhookService?.enqueueEvent({
+                tenantId: entry.tenantId,
+                instanceId: entry.instanceId,
+                eventType: "knowledge.learned",
+                payload: {
+                  id: savedKnowledge.id,
+                  question: savedKnowledge.question,
+                  answer: savedKnowledge.answer,
+                  taughtBy: savedKnowledge.taughtBy,
+                  createdAt: savedKnowledge.createdAt
+                }
+              }).catch(() => null);
+              console.log(`[escalation] confirmacao SIM recebida — conhecimento salvo id=${savedKnowledge.id}`);
+              // Envia confirmacao ao admin
+              void this.platformAlertService?.sendTrackedInstanceAlert(
+                entry.tenantId,
+                entry.instanceId,
+                adminPhone,
+                "Conhecimento adicionado com sucesso!"
+              ).catch(() => null);
+            } catch (err) {
+              console.error("[escalation] erro ao salvar conhecimento apos confirmacao SIM:", err);
+            }
+          } else {
+            console.debug("[escalation] confirmacao SIM ignorada — chave ja processada (duplo evento Baileys)");
+          }
+        } else {
+          console.debug(`[escalation] resposta admin descartada (nao-SIM: "${adminRawAnswer}") — aguardando confirmacao`);
+        }
+        // Sempre retorna null neste caminho — a Fase 2 nao produz um resultado de resposta ao cliente
+        return null;
+      }
+    }
+
+    // ── Fase 1: sem confirmacao pendente — processar como nova resposta a escalacao ──
     // Lock distribuído via Redis para garantir processamento atômico.
     // Evita duplicatas causadas por eventos duplicados do Baileys ou processamento paralelo.
     const lockKey = `escalation:reply-lock:${instanceId}:${targetConversationId ?? "any"}`;
@@ -324,7 +415,7 @@ export class EscalationService {
     }
 
     try {
-      return await this._processAdminReplyInternal(tenantId, instanceId, adminRawAnswer, targetConversationId);
+      return await this._processAdminReplyInternal(tenantId, instanceId, adminRawAnswer, targetConversationId, adminPhone);
     } finally {
       if (this.redis) {
         await this.redis.del(lockKey).catch(() => null);
@@ -336,7 +427,8 @@ export class EscalationService {
     tenantId: string,
     instanceId: string,
     adminRawAnswer: string,
-    targetConversationId?: string | null
+    targetConversationId?: string | null,
+    adminPhone?: string | null
   ): Promise<{
     clientJid: string;
     clientQuestion: string;
@@ -382,6 +474,44 @@ export class EscalationService {
         }))
       : { question: clientQuestion, answer: adminRawAnswer };
 
+    // ── Gate de confirmacao (APR-02, APR-04) ─────────────────────────────────
+    // Fase 1: em vez de salvar imediatamente, armazena em Redis e envia eco ao admin.
+    // A ingestao so ocorre quando admin responde "SIM" (Fase 2, tratada em processAdminReply).
+    if (this.redis && adminPhone) {
+      const adminJid = adminPhone.includes("@") ? adminPhone : `${adminPhone}@s.whatsapp.net`;
+      const pendingEntry: PendingConfirmationEntry = {
+        tenantId,
+        instanceId,
+        question: synthesized.question,
+        synthesizedAnswer: synthesized.answer,
+        rawAnswer: adminRawAnswer,
+        conversationId: pausedConversation.pendingClientConversationId ?? pausedConversation.id,
+        adminJid
+      };
+      const confirmationKey = `confirmation:${instanceId}:${adminPhone}`;
+      await this.redis.set(
+        confirmationKey,
+        JSON.stringify(pendingEntry),
+        "EX",
+        600
+      ).catch(() => null);
+
+      // Envia eco de confirmacao ao admin
+      const echoMessage = `Entendido: ${synthesized.answer}. Devo adicionar isso ao conhecimento do sistema? Responda SIM para confirmar.`;
+      void this.platformAlertService?.sendTrackedInstanceAlert(
+        tenantId,
+        instanceId,
+        adminPhone,
+        echoMessage
+      ).catch(() => null);
+
+      console.log(`[escalation] resposta do admin recebida — aguardando confirmacao SIM (confirmation:${instanceId}:${adminPhone})`);
+
+      // Retorna null — ingestao pendente de confirmacao
+      return null;
+    }
+
+    // ── Caminho legado sem Redis: ingere diretamente (sem gate) ──────────────
     const savedKnowledge = await this.knowledgeService.save(
       tenantId,
       instanceId,
@@ -1059,6 +1189,48 @@ export class EscalationService {
     this.escalationRetryMap.set(ctx.conversationId, { timer, ctx });
   }
 
+  /**
+   * Recupera escalacoes cujo TTL Redis de 4 horas expirou (Pitfall 3 — restart do servidor).
+   * Marca as conversas como nao respondidas se a chave escalation:window nao existir mais.
+   * Deve ser chamado na inicializacao do servico apos reconexao do Redis.
+   */
+  public async recoverExpiredEscalations(
+    tenantId: string,
+    instanceId: string
+  ): Promise<number> {
+    if (!this.redis) return 0;
+    const prisma = await this.tenantPrismaRegistry.getClient(tenantId);
+
+    const awaitingConversations = await prisma.conversation.findMany({
+      where: { instanceId, awaitingAdminResponse: true },
+      select: { id: true }
+    });
+
+    if (awaitingConversations.length === 0) return 0;
+
+    let expiredCount = 0;
+    for (const conv of awaitingConversations) {
+      const windowKey = `escalation:window:${instanceId}:${conv.id}`;
+      const exists = await this.redis.get(windowKey).catch(() => "1"); // assume alive on error
+      if (!exists) {
+        // Redis key expirou — janela de 4h ultrapassada sem resposta do admin
+        await prisma.conversation.update({
+          where: { id: conv.id },
+          data: {
+            awaitingAdminResponse: false,
+            pendingClientQuestion: null,
+            pendingClientJid: null,
+            pendingClientConversationId: null
+          }
+        }).catch(() => null);
+        expiredCount++;
+        console.log(`[escalation] escalacao expirada (4h) marcada como sem resposta: ${conv.id}`);
+      }
+    }
+
+    return expiredCount;
+  }
+
   private async sendEscalationReminder(ctx: EscalationContext): Promise<void> {
     try {
       const prisma = await this.tenantPrismaRegistry.getClient(ctx.tenantId);
