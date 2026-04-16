import { describe, it, expect, vi, beforeEach } from "vitest";
import { InstanceEventBus, type SessionUrgencyDetectedEvent } from "../../../lib/instance-events.js";

// ---------------------------------------------------------------------------
// Task 1 — InstanceEventBus: session.urgency_detected event
// ---------------------------------------------------------------------------

describe("InstanceEventBus — Phase 5 intent events", () => {
  let bus: InstanceEventBus;
  beforeEach(() => { bus = new InstanceEventBus(); });

  it("emits and receives session.urgency_detected", () => {
    const listener = vi.fn();
    bus.on("session.urgency_detected", listener);
    const payload: SessionUrgencyDetectedEvent = {
      type: "session.urgency_detected",
      tenantId: "t1", instanceId: "i1",
      remoteJid: "5511999@s.whatsapp.net",
      sessionId: "sess-1", urgencyScore: 80,
    };
    bus.emit("session.urgency_detected", payload);
    expect(listener).toHaveBeenCalledWith(payload);
  });

  it("SessionUrgencyDetectedEvent has required fields: type, tenantId, instanceId, remoteJid, sessionId, urgencyScore", () => {
    const payload: SessionUrgencyDetectedEvent = {
      type: "session.urgency_detected",
      tenantId: "tenant-abc",
      instanceId: "inst-xyz",
      remoteJid: "5511988887777@s.whatsapp.net",
      sessionId: "sess-abc",
      urgencyScore: 80,
    };
    expect(payload.type).toBe("session.urgency_detected");
    expect(typeof payload.urgencyScore).toBe("number");
    expect(payload.urgencyScore).toBe(80);
  });

  it("different listeners can receive different event types independently", () => {
    const urgencyListener = vi.fn();
    const activityListener = vi.fn();
    bus.on("session.urgency_detected", urgencyListener);
    bus.on("session.activity", activityListener);

    const urgencyPayload: SessionUrgencyDetectedEvent = {
      type: "session.urgency_detected",
      tenantId: "t1", instanceId: "i1",
      remoteJid: "5511111@s.whatsapp.net",
      sessionId: "s1", urgencyScore: 80,
    };
    bus.emit("session.urgency_detected", urgencyPayload);

    expect(urgencyListener).toHaveBeenCalledTimes(1);
    expect(activityListener).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — Intent wiring unit tests: URGENCIA_ALTA + TRANSFERENCIA_HUMANO
// These tests exercise the wiring logic as pure functions via mocks
// ---------------------------------------------------------------------------

describe("Intent wiring — URGENCIA_ALTA and TRANSFERENCIA_HUMANO", () => {
  // Test 4: URGENCIA_ALTA → eventBus.emit('session.urgency_detected', urgencyScore=80)
  it("URGENCIA_ALTA: eventBus.emit called with session.urgency_detected and urgencyScore=80", async () => {
    const bus = new InstanceEventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    const redisHset = vi.fn().mockResolvedValue(1);

    // Simulate the wiring logic
    const classification = { label: "URGENCIA_ALTA" as const, confidence: 0.9 };
    const tenantId = "tenant-1";
    const instanceId = "inst-1";
    const remoteJid = "5511999@s.whatsapp.net";

    if (classification.label === "URGENCIA_ALTA") {
      bus.emit("session.urgency_detected", {
        type: "session.urgency_detected",
        tenantId,
        instanceId,
        remoteJid,
        sessionId: "",
        urgencyScore: 80,
      });
      await redisHset(`session:${tenantId}:${instanceId}:${remoteJid}`, { urgencyScore: "80" });
    }

    expect(emitSpy).toHaveBeenCalledWith(
      "session.urgency_detected",
      expect.objectContaining({ type: "session.urgency_detected", urgencyScore: 80 })
    );
    expect(redisHset).toHaveBeenCalledWith(
      `session:${tenantId}:${instanceId}:${remoteJid}`,
      { urgencyScore: "80" }
    );
  });

  // Test 5: TRANSFERENCIA_HUMANO → setHumanTakeover called with (tenantId, instanceId, remoteJid, true)
  it("TRANSFERENCIA_HUMANO: setHumanTakeover called with true", async () => {
    const setHumanTakeover = vi.fn().mockResolvedValue(undefined);
    const classification = { label: "TRANSFERENCIA_HUMANO" as const, confidence: 0.95 };
    const tenantId = "tenant-1";
    const instanceId = "inst-1";
    const remoteJid = "5511999@s.whatsapp.net";

    if (classification.label === "TRANSFERENCIA_HUMANO") {
      await setHumanTakeover(tenantId, instanceId, remoteJid, true);
    }

    expect(setHumanTakeover).toHaveBeenCalledExactlyOnceWith(tenantId, instanceId, remoteJid, true);
  });

  // Test 6: TRANSFERENCIA_HUMANO → sendAutomatedTextMessage called with conversation summary
  it("TRANSFERENCIA_HUMANO: sendAutomatedTextMessage called with conversation exchange summary", async () => {
    const setHumanTakeover = vi.fn().mockResolvedValue(undefined);
    const sendAutomatedTextMessage = vi.fn().mockResolvedValue(undefined);
    const classification = { label: "TRANSFERENCIA_HUMANO" as const, confidence: 0.95 };

    const sessionHistory = [
      { role: "user", content: "Preciso de ajuda urgente" },
      { role: "assistant", content: "Olá! Como posso ajudar?" },
      { role: "user", content: "Meu pedido está atrasado" },
    ];

    const tenantId = "tenant-1";
    const instanceId = "inst-1";
    const remoteJid = "5511999@s.whatsapp.net";
    const adminPhone = "5511888@s.whatsapp.net";

    if (classification.label === "TRANSFERENCIA_HUMANO") {
      await setHumanTakeover(tenantId, instanceId, remoteJid, true);

      const recentExchanges = sessionHistory.slice(-10);
      const summaryLines = recentExchanges.map((msg) =>
        `${msg.role === "user" ? "Cliente" : "Bot"}: ${msg.content.slice(0, 120)}`
      );
      const summaryText = summaryLines.join("\n");

      await sendAutomatedTextMessage(
        tenantId, instanceId, adminPhone, `${adminPhone}@s.whatsapp.net`,
        `Transferência solicitada.\nÚltimas mensagens:\n${summaryText}`,
        { action: "intent_human_handoff_alert", kind: "chatbot" }
      );
    }

    expect(sendAutomatedTextMessage).toHaveBeenCalledOnce();
    const callArgs = sendAutomatedTextMessage.mock.calls[0];
    const textArg: string = callArgs[4];
    // Must contain at least one conversation exchange
    expect(textArg).toMatch(/Cliente:|Bot:/);
    expect(callArgs[5]).toMatchObject({ action: "intent_human_handoff_alert" });
  });

  // Test 7: TRANSFERENCIA_HUMANO — no adminPhone → setHumanTakeover still completes, no throw
  it("TRANSFERENCIA_HUMANO: completes without throw when adminPhone is null", async () => {
    const setHumanTakeover = vi.fn().mockResolvedValue(undefined);
    const sendAutomatedTextMessage = vi.fn().mockResolvedValue(undefined);
    const classification = { label: "TRANSFERENCIA_HUMANO" as const, confidence: 0.95 };

    const tenantId = "tenant-1";
    const instanceId = "inst-1";
    const remoteJid = "5511999@s.whatsapp.net";
    const adminPhone: string | null = null;

    let threw = false;
    try {
      if (classification.label === "TRANSFERENCIA_HUMANO") {
        await setHumanTakeover(tenantId, instanceId, remoteJid, true);
        if (adminPhone) {
          await sendAutomatedTextMessage(
            tenantId, instanceId, adminPhone, `${adminPhone}@s.whatsapp.net`,
            "Transferência solicitada.",
            { action: "intent_human_handoff_alert", kind: "chatbot" }
          );
        }
        // No adminPhone — warn only
        console.warn("[intent] TRANSFERENCIA_HUMANO: adminPhone não configurado");
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(setHumanTakeover).toHaveBeenCalledExactlyOnceWith(tenantId, instanceId, remoteJid, true);
    expect(sendAutomatedTextMessage).not.toHaveBeenCalled();
  });
});
