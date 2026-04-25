commit 016901129c0f4b9deee89cf508165552cbb95db6
Author: Codex Local <codex-local@infracode.dev>
Date:   Fri Apr 24 23:11:13 2026 -0500

    test(08-02): add failing tests for escalation confirmation gate (APR-02, APR-04)
    
    - 5 test cases covering confirmation gate two-phase ingestion
    - Test 1: admin reply triggers echo; knowledgeService.save NOT called immediately
    - Test 2: admin SIM triggers knowledgeService.save and deletes Redis key
    - Test 3: admin 'ok' does NOT trigger knowledgeService.save
    - Test 4: admin 'claro' does NOT trigger knowledgeService.save
    - Test 5: Redis confirmation key has TTL=600 after first admin reply

diff --git a/apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts b/apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts
index dc159cf..d83c1ef 100644
--- a/apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts
+++ b/apps/api/src/modules/chatbot/__tests__/escalation-confirmation-gate.test.ts
@@ -1,12 +1,275 @@
-import { describe, it } from 'vitest';
-// Stub — will fail until Plan 02 refactors EscalationService.
-// Tests are written against the post-refactor interface.
+import { describe, it, expect, vi, beforeEach } from 'vitest';
 import { EscalationService } from '../escalation.service.js';
 
+// ---------------------------------------------------------------------------
+// Helpers / mocks
+// ---------------------------------------------------------------------------
+
+function makeMockPrisma() {
+  const conversation = {
+    findFirst: vi.fn(),
+    findMany: vi.fn(),
+    update: vi.fn(),
+    updateMany: vi.fn(),
+    count: vi.fn(),
+  };
+  return {
+    conversation,
+    contact: { upsert: vi.fn() },
+    message: { create: vi.fn(), findFirst: vi.fn() },
+  };
+}
+
+function makeMockRedis() {
+  const store = new Map<string, string>();
+  const ttls = new Map<string, number>();
+
+  const redis = {
+    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
+      // Support: set(key, value, 'EX', ttl) and set(key, value, 'EX', ttl, 'NX')
+      const argStr = args.join(',').toUpperCase();
+      const exIdx = args.indexOf('EX');
+      if (exIdx !== -1 && typeof args[exIdx + 1] === 'number') {
+        ttls.set(key, args[exIdx + 1] as number);
+      }
+      const isNX = argStr.includes('NX');
+      if (isNX && store.has(key)) return null;
+      store.set(key, value);
+      return 'OK';
+    }),
+    get: vi.fn(async (key: string) => store.get(key) ?? null),
+    del: vi.fn(async (key: string) => {
+      if (store.has(key)) {
+        store.delete(key);
+        ttls.delete(key);
+        return 1;
+      }
+      return 0;
+    }),
+    getdel: vi.fn(async (key: string) => {
+      const v = store.get(key) ?? null;
+      store.delete(key);
+      return v;
+    }),
+    _store: store,
+    _ttls: ttls,
+  };
+
+  return redis;
+}
+
+function makeSvc(overrides?: {
+  redis?: ReturnType<typeof makeMockRedis> | null;
+  knowledgeSave?: ReturnType<typeof vi.fn>;
+  prisma?: ReturnType<typeof makeMockPrisma>;
+  chatbotSynthesize?: ReturnType<typeof vi.fn>;
+}) {
+  const prisma = overrides?.prisma ?? makeMockPrisma();
+  const redisOrNull = overrides?.redis !== undefined ? overrides.redis : makeMockRedis();
+  // In all tests that directly call redis.*, redis is the non-null mock. Cast to non-null for TS.
+  const redis = redisOrNull as ReturnType<typeof makeMockRedis>;
+
+  const knowledgeSaveFn = overrides?.knowledgeSave ?? vi.fn().mockResolvedValue({
+    id: 'k-1',
+    instanceId: 'inst-1',
+    question: 'q',
+    answer: 'a',
+    rawAnswer: 'raw',
+    taughtBy: 'admin',
+    createdAt: new Date().toISOString(),
+  });
+
+  const knowledgeService = { save: knowledgeSaveFn } as unknown as import('../knowledge.service.js').KnowledgeService;
+  const tenantPrismaRegistry = {
+    getClient: vi.fn().mockResolvedValue(prisma),
+  } as unknown as import('../../../lib/database.js').TenantPrismaRegistry;
+
+  const chatbotSynthesize = overrides?.chatbotSynthesize ?? vi.fn().mockImplementation(
+    async (_t: string, _i: string, question: string, answer: string) => ({ question, answer })
+  );
+
+  const svc = new EscalationService({
+    tenantPrismaRegistry,
+    knowledgeService,
+    redis: redisOrNull as unknown as import('ioredis').Redis ?? undefined,
+  });
+
+  // inject chatbotService with synthesizeKnowledgeEntry
+  svc.setChatbotService({
+    synthesizeKnowledgeEntry: chatbotSynthesize,
+  } as unknown as import('../service.js').ChatbotService);
+
+  // inject a platformAlertService so that sendAdminMessage can be captured
+  const sendAdminMessage = vi.fn().mockResolvedValue(undefined);
+  svc.setPlatformAlertService({
+    sendTrackedInstanceAlert: vi.fn().mockResolvedValue({
+      delivered: true,
+      externalMessageId: 'msg-1',
+      remoteJid: '551199999999@s.whatsapp.net',
+    }),
+    sendAdminMessage,
+  } as unknown as import('../../../modules/platform/alert.service.js').PlatformAlertService);
+
+  return {
+    svc,
+    redis,
+    prisma,
+    knowledgeSaveFn,
+    chatbotSynthesize,
+    sendAdminMessage,
+    tenantPrismaRegistry,
+  };
+}
+
+// ---------------------------------------------------------------------------
+// A typical paused conversation that processAdminReply will find
+// ---------------------------------------------------------------------------
+const TENANT_ID = 'tenant-1';
+const INSTANCE_ID = 'inst-1';
+const ADMIN_PHONE = '5511999990001';
+const CONVERSATION_ID = 'conv-1';
+
+function pausedConversation() {
+  return {
+    id: CONVERSATION_ID,
+    pendingClientConversationId: CONVERSATION_ID,
+    pendingClientJid: '5511988880001@s.whatsapp.net',
+    pendingClientQuestion: 'Como funciona o plano?',
+  };
+}
+
+// ---------------------------------------------------------------------------
+// Tests
+// ---------------------------------------------------------------------------
+
 describe('EscalationService — Confirmation Gate (APR-02, APR-04)', () => {
-  it.todo('admin reply triggers confirmation echo; knowledgeService.save NOT called immediately');
-  it.todo('admin follow-up "SIM" triggers knowledgeService.save and deletes Redis key');
-  it.todo('admin follow-up "ok" does NOT trigger knowledgeService.save');
-  it.todo('admin follow-up "claro" does NOT trigger knowledgeService.save');
-  it.todo('Redis confirmation key has TTL=600 after first admin reply');
+
+  it('admin reply triggers confirmation echo; knowledgeService.save NOT called immediately', async () => {
+    const { svc, prisma, knowledgeSaveFn } = makeSvc();
+
+    // First call: admin sends first answer → should echo, not save
+    prisma.conversation.findFirst.mockResolvedValueOnce(pausedConversation());
+    prisma.conversation.update.mockResolvedValue({});
+
+    const result = await svc.processAdminReply(
+      TENANT_ID,
+      INSTANCE_ID,
+      'O plano é mensal com renovação automática.',
+      CONVERSATION_ID,
+      ADMIN_PHONE,
+    );
+
+    // Should return null (or a specific "pending" result) — NOT a full savedKnowledgeId result yet
+    // The key contract: knowledgeService.save must NOT be called
+    expect(knowledgeSaveFn).not.toHaveBeenCalled();
+
+    // Result indicates it is waiting for confirmation (null or specific marker)
+    // Per plan: "Return early after sending the echo" — we treat null as the expected return
+    expect(result).toBeNull();
+  });
+
+  it('admin follow-up "SIM" triggers knowledgeService.save and deletes Redis key', async () => {
+    const { svc, prisma, redis, knowledgeSaveFn } = makeSvc();
+
+    // Seed the Redis confirmation key as if Phase 1 already happened
+    const confirmationKey = `confirmation:${INSTANCE_ID}:${ADMIN_PHONE}`;
+    const pendingEntry = {
+      tenantId: TENANT_ID,
+      instanceId: INSTANCE_ID,
+      question: 'Como funciona o plano?',
+      synthesizedAnswer: 'O plano é mensal com renovação automática.',
+      rawAnswer: 'O plano é mensal com renovação automática.',
+      conversationId: CONVERSATION_ID,
+      adminJid: `${ADMIN_PHONE}@s.whatsapp.net`,
+    };
+    await redis.set(confirmationKey, JSON.stringify(pendingEntry));
+
+    // Admin replies "SIM"
+    const result = await svc.processAdminReply(
+      TENANT_ID,
+      INSTANCE_ID,
+      'SIM',
+      null,
+      ADMIN_PHONE,
+    );
+
+    // knowledgeService.save MUST be called
+    expect(knowledgeSaveFn).toHaveBeenCalledOnce();
+    expect(knowledgeSaveFn).toHaveBeenCalledWith(
+      TENANT_ID,
+      INSTANCE_ID,
+      pendingEntry.question,
+      pendingEntry.synthesizedAnswer,
+      pendingEntry.rawAnswer,
+      pendingEntry.adminJid,
+    );
+
+    // Redis key MUST be deleted
+    const remaining = await redis.get(confirmationKey);
+    expect(remaining).toBeNull();
+  });
+
+  it('admin follow-up "ok" does NOT trigger knowledgeService.save', async () => {
+    const { svc, redis, knowledgeSaveFn, prisma } = makeSvc();
+
+    // Seed confirmation key
+    const confirmationKey = `confirmation:${INSTANCE_ID}:${ADMIN_PHONE}`;
+    await redis.set(confirmationKey, JSON.stringify({
+      tenantId: TENANT_ID,
+      instanceId: INSTANCE_ID,
+      question: 'q',
+      synthesizedAnswer: 'a',
+      rawAnswer: 'raw',
+      conversationId: CONVERSATION_ID,
+      adminJid: `${ADMIN_PHONE}@s.whatsapp.net`,
+    }));
+
+    // Admin replies "ok" (not SIM)
+    await svc.processAdminReply(TENANT_ID, INSTANCE_ID, 'ok', null, ADMIN_PHONE);
+
+    expect(knowledgeSaveFn).not.toHaveBeenCalled();
+  });
+
+  it('admin follow-up "claro" does NOT trigger knowledgeService.save', async () => {
+    const { svc, redis, knowledgeSaveFn } = makeSvc();
+
+    const confirmationKey = `confirmation:${INSTANCE_ID}:${ADMIN_PHONE}`;
+    await redis.set(confirmationKey, JSON.stringify({
+      tenantId: TENANT_ID,
+      instanceId: INSTANCE_ID,
+      question: 'q',
+      synthesizedAnswer: 'a',
+      rawAnswer: 'raw',
+      conversationId: CONVERSATION_ID,
+      adminJid: `${ADMIN_PHONE}@s.whatsapp.net`,
+    }));
+
+    await svc.processAdminReply(TENANT_ID, INSTANCE_ID, 'claro', null, ADMIN_PHONE);
+
+    expect(knowledgeSaveFn).not.toHaveBeenCalled();
+  });
+
+  it('Redis confirmation key has TTL=600 after first admin reply', async () => {
+    const { svc, prisma, redis } = makeSvc();
+
+    // First call: admin sends first answer
+    prisma.conversation.findFirst.mockResolvedValueOnce(pausedConversation());
+    prisma.conversation.update.mockResolvedValue({});
+
+    await svc.processAdminReply(
+      TENANT_ID,
+      INSTANCE_ID,
+      'O plano é mensal com renovação automática.',
+      CONVERSATION_ID,
+      ADMIN_PHONE,
+    );
+
+    // Verify the confirmation key was set with TTL=600
+    const confirmationKey = `confirmation:${INSTANCE_ID}:${ADMIN_PHONE}`;
+    const stored = await redis.get(confirmationKey);
+    expect(stored).not.toBeNull();
+
+    const ttl = redis._ttls.get(confirmationKey);
+    expect(ttl).toBe(600);
+  });
 });
