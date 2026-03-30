import { describe, expect, it } from "vitest";
import {
  DECRYPT_FAILURE_BURST_THRESHOLD,
  createDecryptFailureBurstDetector
} from "../src/modules/instances/decrypt-failure-burst.js";

describe("createDecryptFailureBurstDetector", () => {
  it("coalesces paired decrypt log lines into a single failure", () => {
    let now = 0;
    const detector = createDecryptFailureBurstDetector({
      now: () => now
    });

    expect(detector.recordSignal("Failed to decrypt message")).toMatchObject({
      failureCount: 1,
      matched: true,
      shouldRecover: false
    });

    now = 100;
    expect(detector.recordSignal("Session error: Bad MAC")).toMatchObject({
      failureCount: 1,
      matched: true,
      shouldRecover: false
    });

    now = 2_000;
    expect(detector.recordSignal("Session error: Bad MAC")).toMatchObject({
      failureCount: 2,
      matched: true,
      shouldRecover: false
    });
  });

  it("keeps different message ids as separate failures even inside the coalesce window", () => {
    let now = 0;
    const detector = createDecryptFailureBurstDetector({
      now: () => now
    });

    expect(
      detector.recordSignal("failed to decrypt message", {
        externalMessageId: "msg-1",
        remoteJid: "5511999999999@s.whatsapp.net"
      })
    ).toMatchObject({
      failureCount: 1,
      matched: true,
      shouldRecover: false
    });

    now = 500;
    expect(
      detector.recordSignal("failed to decrypt message", {
        externalMessageId: "msg-2",
        remoteJid: "5511888888888@s.whatsapp.net"
      })
    ).toMatchObject({
      failureCount: 2,
      matched: true,
      shouldRecover: false
    });
  });

  it("only triggers recovery after the new burst threshold is reached", () => {
    let now = 0;
    const detector = createDecryptFailureBurstDetector({
      coalesceWindowMs: 0,
      now: () => now
    });

    for (let index = 1; index < DECRYPT_FAILURE_BURST_THRESHOLD; index += 1) {
      expect(
        detector.recordSignal("failed to decrypt message", {
          externalMessageId: `msg-${index}`
        })
      ).toMatchObject({
        failureCount: index,
        matched: true,
        shouldRecover: false
      });

      now += 2_000;
    }

    expect(
      detector.recordSignal("Session error: Bad MAC", {
        externalMessageId: `msg-${DECRYPT_FAILURE_BURST_THRESHOLD}`
      })
    ).toMatchObject({
      failureCount: DECRYPT_FAILURE_BURST_THRESHOLD,
      matched: true,
      shouldRecover: true
    });
  });
});
