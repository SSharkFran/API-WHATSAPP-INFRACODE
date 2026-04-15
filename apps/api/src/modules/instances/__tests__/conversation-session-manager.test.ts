import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConversationSessionManager, SessionStatus } from "../conversation-session-manager.js";
import type { ConversationSession } from "../conversation-session-manager.js";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    history: [],
    leadAlreadySent: false,
    pendingInputs: [],
    pendingContext: null,
    debounceTimer: null,
    isProcessing: false,
    flushAfterProcessing: false,
    resetGeneration: 0,
    lastActivityAt: new Date(),
    ...overrides
  };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("SessionStatus enum", () => {
  it("exports all five statuses (SESS-01)", () => {
    expect(SessionStatus.ATIVA).toBe("ATIVA");
    expect(SessionStatus.AGUARDANDO_CLIENTE).toBe("AGUARDANDO_CLIENTE");
    expect(SessionStatus.CONFIRMACAO_ENVIADA).toBe("CONFIRMACAO_ENVIADA");
    expect(SessionStatus.INATIVA).toBe("INATIVA");
    expect(SessionStatus.ENCERRADA).toBe("ENCERRADA");
  });
});

describe("ConversationSessionManager", () => {
  let manager: ConversationSessionManager;

  beforeEach(() => {
    manager = new ConversationSessionManager();
  });

  afterEach(() => {
    manager.stopGc();
    manager.clearAll();
  });

  // Test 2
  it("buildKey returns {instanceId}:{remoteJid}", () => {
    expect(manager.buildKey("inst-123", "5511999@s.whatsapp.net")).toBe(
      "inst-123:5511999@s.whatsapp.net"
    );
  });

  // Test 3
  it("get() returns undefined for unknown key; returns session after set()", () => {
    const key = manager.buildKey("a", "b");
    expect(manager.get(key)).toBeUndefined();

    const session = makeSession();
    manager.set(key, session);
    expect(manager.get(key)).toBe(session);
  });

  // Test 4
  it("clear() calls clearTimeout on debounceTimer and removes entry from Map", () => {
    vi.useFakeTimers();
    const key = manager.buildKey("inst", "jid");
    const timer = setTimeout(() => {}, 99999);
    const session = makeSession({ debounceTimer: timer });
    manager.set(key, session);

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    manager.clear(key);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(manager.get(key)).toBeUndefined();
    vi.useRealTimers();
  });

  // Test 5
  it("clearAll() calls clearTimeout on all sessions with active timers", () => {
    vi.useFakeTimers();
    const timer1 = setTimeout(() => {}, 99999);
    const timer2 = setTimeout(() => {}, 99999);

    manager.set("k1", makeSession({ debounceTimer: timer1 }));
    manager.set("k2", makeSession({ debounceTimer: timer2 }));
    manager.set("k3", makeSession({ debounceTimer: null }));

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    manager.clearAll();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer2);
    expect(manager.get("k1")).toBeUndefined();
    expect(manager.get("k2")).toBeUndefined();
    expect(manager.get("k3")).toBeUndefined();
    vi.useRealTimers();
  });

  // Test 6
  it("startGc() + stopGc() — stopGc clears the interval (no leak)", () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    manager.startGc();
    manager.stopGc();

    expect(clearIntervalSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Test 7
  it("LRU cap: inserting session beyond maxSessions evicts the oldest idle session", () => {
    const small = new ConversationSessionManager({ maxSessions: 2 });

    const old = new Date(Date.now() - 10000);
    const recent = new Date(Date.now() - 1000);

    const sessionOld = makeSession({ lastActivityAt: old, isProcessing: false, debounceTimer: null });
    const sessionRecent = makeSession({ lastActivityAt: recent, isProcessing: false, debounceTimer: null });
    const sessionNew = makeSession({ lastActivityAt: new Date() });

    small.set("k-old", sessionOld);
    small.set("k-recent", sessionRecent);
    // Third insert exceeds cap — oldest idle session (k-old) must be evicted
    small.set("k-new", sessionNew);

    expect(small.get("k-old")).toBeUndefined();
    expect(small.get("k-recent")).toBeDefined();
    expect(small.get("k-new")).toBeDefined();

    small.clearAll();
  });

  // Test 8
  it("LRU cap does NOT evict a session where isProcessing=true, even if oldest", () => {
    const small = new ConversationSessionManager({ maxSessions: 2 });

    const old = new Date(Date.now() - 10000);
    const recent = new Date(Date.now() - 1000);

    // Both existing sessions: one is old but processing, one is recent and idle
    const sessionProcessing = makeSession({ lastActivityAt: old, isProcessing: true, debounceTimer: null });
    const sessionIdle = makeSession({ lastActivityAt: recent, isProcessing: false, debounceTimer: null });
    const sessionNew = makeSession({ lastActivityAt: new Date() });

    small.set("k-processing", sessionProcessing);
    small.set("k-idle", sessionIdle);
    // Third insert: k-processing is oldest but must NOT be evicted; k-idle is next candidate
    small.set("k-new", sessionNew);

    // k-processing must survive despite being oldest because isProcessing=true
    expect(small.get("k-processing")).toBeDefined();
    // k-idle is the oldest evictable candidate
    expect(small.get("k-idle")).toBeUndefined();
    expect(small.get("k-new")).toBeDefined();

    small.clearAll();
  });
});
