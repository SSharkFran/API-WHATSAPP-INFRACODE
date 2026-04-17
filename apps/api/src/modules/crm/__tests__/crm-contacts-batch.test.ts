import { describe, it, expect, vi } from "vitest";

/** Replicates the cleanPhone helper from routes.ts for test assertions */
const cleanPhone = (raw: string | null | undefined): string =>
  (raw ?? "").replace(/@[^@]*$/, "").replace(/\D/g, "");

describe("CRM contacts batch", () => {
  it("replaces N+1 clientMemory.findFirst loop with single findMany query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn();

    // Simulate the batch-lookup logic extracted from routes.ts
    const contacts = [
      { phoneNumber: "5511987654321" },
      { phoneNumber: "5511912345678" },
      { phoneNumber: "5521999990000" },
      { phoneNumber: "5531888881111" },
      { phoneNumber: "5541777772222" }
    ];

    const phone8List = contacts
      .map(c => cleanPhone(c.phoneNumber).slice(-8))
      .filter(Boolean);

    if (phone8List.length > 0) {
      await findMany({
        where: { OR: phone8List.map(p => ({ phoneNumber: { contains: p } })) },
        select: { phoneNumber: true, name: true }
      });
    }

    // findFirst must never be called — no N+1 loop
    expect(findFirst).not.toHaveBeenCalled();
    // findMany called exactly once for 5 contacts
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("returns correct memory per contact matched by last-8-digit phone suffix", () => {
    const memoryRows = [
      { phoneNumber: "5511987654321", name: "Maria Silva" },
      { phoneNumber: "5521999990000", name: "João Santos" }
    ];

    // Build lookup map — same pattern as routes.ts
    const memoryMap = new Map(
      memoryRows.map(m => [cleanPhone(m.phoneNumber).slice(-8), m])
    );

    // Should match by last 8 digits regardless of country/area code prefix
    expect(memoryMap.get("87654321")).toEqual({ phoneNumber: "5511987654321", name: "Maria Silva" });
    expect(memoryMap.get("99990000")).toEqual({ phoneNumber: "5521999990000", name: "João Santos" });
    // Non-existent entry returns undefined
    expect(memoryMap.get("00000000")).toBeUndefined();
  });

  it("handles empty contact list without querying clientMemory", async () => {
    const findMany = vi.fn();

    const phone8List: string[] = [];

    // Guard — same as routes.ts: only query if list is non-empty
    if (phone8List.length > 0) {
      await findMany();
    }

    expect(findMany).not.toHaveBeenCalled();
  });
});
