import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionLifecycleService } from "../session-lifecycle.service.js";
import { SessionStatus } from "../conversation-session-manager.js";
import type { SessionLifecycleServiceDeps } from "../session-lifecycle.service.js";
import type { SessionHashState } from "../session-state.service.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: "mock-job" }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSessionStateService() {
  return {
    isHumanTakeover: vi.fn().mockResolvedValue(false),
    getSessionState: vi.fn().mockResolvedValue(null as SessionHashState | null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
  };
}

function makeInstanceOrchestrator() {
  return {
    sendSessionMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLogger() {
  const child = () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child,
  });
  return { child } as unknown as import("pino").Logger;
}

function makeConfig(overrides: Partial<{ SESSION_LIFECYCLE_V2: string; SESSION_TIMEOUT_MS: string; NODE_ENV: string }> = {}) {
  return {
    SESSION_LIFECYCLE_V2: "true",
    SESSION_TIMEOUT_MS: "120000",
    NODE_ENV: "test",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SessionLifecycleServiceDeps> = {}): SessionLifecycleServiceDeps {
  return {
    redis: {} as unknown as import("ioredis").Redis,
    queue: makeQueue() as unknown as import("bullmq").Queue,
    sessionStateService: makeSessionStateService() as unknown as import("../session-state.service.js").SessionStateService,
    instanceOrchestrator: makeInstanceOrchestrator() as unknown as import("../service.js").InstanceOrchestrator,
    config: makeConfig(),
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionLifecycleService", () => {
  describe("recordActivity()", () => {
    // Test 1 (SESS-03/04): recordActivity() enqueues a job with correct deduplication options
    it("enqueues check-inactivity job with deduplication.extend=true and deduplication.replace=true (SESS-03/04)", async () => {
      const deps = makeDeps();
      const svc = new SessionLifecycleService(deps);
      const queue = deps.queue as unknown as ReturnType<typeof makeQueue>;

      await svc.recordActivity({
        sessionId: "sess-1",
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
      });

      expect(queue.add).toHaveBeenCalledTimes(1);
      const [jobName, jobData, jobOptions] = queue.add.mock.calls[0] as unknown[];
      expect(jobName).toBe("check-inactivity");
      expect((jobData as Record<string, unknown>).sessionId).toBe("sess-1");
      expect((jobData as Record<string, unknown>).tenantId).toBe("tenant-1");
      expect((jobData as Record<string, unknown>).instanceId).toBe("inst-1");
      expect((jobData as Record<string, unknown>).remoteJid).toBe("123@s.whatsapp.net");
      const opts = jobOptions as Record<string, unknown>;
      const dedup = opts.deduplication as Record<string, unknown>;
      expect(dedup.id).toBe("session-timeout:tenant-1:inst-1:123@s.whatsapp.net");
      expect(dedup.extend).toBe(true);
      expect(dedup.replace).toBe(true);
      expect(opts.delay).toBe(120000);
    });

    // Test 2 (SESS-04): calling recordActivity() twice uses same deduplication.id
    it("calling recordActivity() twice enqueues twice with the same deduplication.id (SESS-04)", async () => {
      const deps = makeDeps();
      const svc = new SessionLifecycleService(deps);
      const queue = deps.queue as unknown as ReturnType<typeof makeQueue>;

      const params = {
        sessionId: "sess-1",
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
      };

      await svc.recordActivity(params);
      await svc.recordActivity(params);

      expect(queue.add).toHaveBeenCalledTimes(2);
      const id1 = (queue.add.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
      const id2 = (queue.add.mock.calls[1] as unknown[])[2] as Record<string, unknown>;
      const dedup1 = id1.deduplication as Record<string, unknown>;
      const dedup2 = id2.deduplication as Record<string, unknown>;
      expect(dedup1.id).toBe(dedup2.id);
    });

    // Test 3 (SESS-07): recordActivity() skips queue when humanTakeover is active
    it("does NOT call queue.add() when humanTakeover is active (SESS-07)", async () => {
      const sessionStateService = makeSessionStateService();
      sessionStateService.isHumanTakeover.mockResolvedValue(true);
      const deps = makeDeps({ sessionStateService: sessionStateService as unknown as import("../session-state.service.js").SessionStateService });
      const svc = new SessionLifecycleService(deps);
      const queue = deps.queue as unknown as ReturnType<typeof makeQueue>;

      await svc.recordActivity({
        sessionId: "sess-1",
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
      });

      expect(queue.add).not.toHaveBeenCalled();
    });

    // Test 10: recordActivity() skips when feature flag is false
    it("does NOT call queue.add() when SESSION_LIFECYCLE_V2 is false (feature flag off)", async () => {
      const deps = makeDeps({ config: makeConfig({ SESSION_LIFECYCLE_V2: "false" }) });
      const svc = new SessionLifecycleService(deps);
      const queue = deps.queue as unknown as ReturnType<typeof makeQueue>;

      await svc.recordActivity({
        sessionId: "sess-1",
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
      });

      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe("processTimeoutJob()", () => {
    // Test 4 (SESS-05): ATIVA → CONFIRMACAO_ENVIADA (never directly ENCERRADA)
    it("transitions ATIVA → CONFIRMACAO_ENVIADA on first timeout (SESS-05)", async () => {
      const sessionStateService = makeSessionStateService();
      sessionStateService.getSessionState.mockResolvedValue({
        status: SessionStatus.ATIVA,
        humanTakeover: false,
        startedAt: new Date().toISOString(),
        sessionId: "sess-1",
      } as SessionHashState);

      const deps = makeDeps({ sessionStateService: sessionStateService as unknown as import("../session-state.service.js").SessionStateService });
      const svc = new SessionLifecycleService(deps);

      await svc.processTimeoutJob({
        sessionId: "sess-1",
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
      });

      expect(sessionStateService.updateStatus).toHaveBeenCalledWith(
        "tenant-1",
        "inst-1",
        "123@s.whatsapp.net",
        SessionStatus.CONFIRMACAO_ENVIADA
      );
      expect(sessionStateService.closeSession).not.toHaveBeenCalled();
    });

    // Test 5 (SESS-05): CONFIRMACAO_ENVIADA → closeSession with timeout_no_response
    it("calls closeSession with closedReason=timeout_no_response when status=CONFIRMACAO_ENVIADA (SESS-05)", async () => {
      const sessionStateService = makeSessionStateService();
      sessionStateService.getSessionState.mockResolvedValue({
        status: SessionStatus.CONFIRMACAO_ENVIADA,
        humanTakeover: false,
        startedAt: new Date().toISOString(),
        sessionId: "sess-1",
      } as SessionHashState);

      const deps = makeDeps({ sessionStateService: sessionStateService as unknown as import("../session-state.service.js").SessionStateService });
      const svc = new SessionLifecycleService(deps);

      await svc.processTimeoutJob({
        sessionId: "sess-1",
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
      });

      expect(sessionStateService.closeSession).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
        closedReason: "timeout_no_response",
      });
      expect(sessionStateService.updateStatus).not.toHaveBeenCalled();
    });

    // Test 6: ENCERRADA → no-op
    it("exits without any state change when status=ENCERRADA (safe no-op)", async () => {
      const sessionStateService = makeSessionStateService();
      sessionStateService.getSessionState.mockResolvedValue({
        status: SessionStatus.ENCERRADA,
        humanTakeover: false,
        startedAt: new Date().toISOString(),
        sessionId: "sess-1",
      } as SessionHashState);

      const deps = makeDeps({ sessionStateService: sessionStateService as unknown as import("../session-state.service.js").SessionStateService });
      const svc = new SessionLifecycleService(deps);

      await svc.processTimeoutJob({
        sessionId: "sess-1",
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
      });

      expect(sessionStateService.updateStatus).not.toHaveBeenCalled();
      expect(sessionStateService.closeSession).not.toHaveBeenCalled();
    });

    // Test 7: null state (Redis miss) → no-op (Pitfall 6)
    it("exits without any state change when Redis state is null (Pitfall 6)", async () => {
      const sessionStateService = makeSessionStateService();
      sessionStateService.getSessionState.mockResolvedValue(null);

      const deps = makeDeps({ sessionStateService: sessionStateService as unknown as import("../session-state.service.js").SessionStateService });
      const svc = new SessionLifecycleService(deps);

      await svc.processTimeoutJob({
        sessionId: "sess-1",
        tenantId: "tenant-1",
        instanceId: "inst-1",
        remoteJid: "123@s.whatsapp.net",
      });

      expect(sessionStateService.updateStatus).not.toHaveBeenCalled();
      expect(sessionStateService.closeSession).not.toHaveBeenCalled();
    });
  });

  describe("recognizeCloseIntent()", () => {
    // Test 8 (SESS-09): matches known closure phrases
    it("returns true for 'era só isso, obrigado' (SESS-09)", () => {
      const svc = new SessionLifecycleService(makeDeps());
      expect(svc.recognizeCloseIntent("era só isso, obrigado")).toBe(true);
    });

    // Test 9 (SESS-09): returns false for non-closure phrase
    it("returns false for 'qual o horário de funcionamento?' (SESS-09)", () => {
      const svc = new SessionLifecycleService(makeDeps());
      expect(svc.recognizeCloseIntent("qual o horário de funcionamento?")).toBe(false);
    });
  });
});
