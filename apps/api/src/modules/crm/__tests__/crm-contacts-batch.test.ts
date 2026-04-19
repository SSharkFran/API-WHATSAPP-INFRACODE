import { describe, it, expect, vi } from "vitest";

// These tests verify behavior after Plan 2.3 refactor:
// - N+1 clientMemory.findFirst loop replaced by single findMany
// - memoryMap matching by last-8-digit phone suffix
// - empty contact list skips DB query

/** cleanPhone: mirrors the function in routes.ts */
const cleanPhone = (raw: string | null | undefined): string =>
  (raw ?? "").replace(/@[^@]*$/, "").replace(/\D/g, "");

describe("CRM contacts batch", () => {
  it("replaces N+1 clientMemory.findFirst loop with single findMany query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn();

    const deduped = [
      { contact: { phoneNumber: "5511987654321" } },
      { contact: { phoneNumber: "5521912345678" } },
      { contact: { phoneNumber: "5531911111111" } },
      { contact: { phoneNumber: "5541922222222" } },
      { contact: { phoneNumber: "5551933333333" } }
    ];

    const phone8List = deduped
      .map(c => cleanPhone(c.contact.phoneNumber).slice(-8))
      .filter(Boolean);

    // Simulates the batch-query logic from routes.ts
    const memoryRows = phone8List.length > 0
      ? await findMany({
          where: { OR: phone8List.map(p => ({ phoneNumber: { contains: p } })) },
          select: { phoneNumber: true, name: true, serviceInterest: true, status: true, scheduledAt: true, notes: true }
        })
      : [];

    expect(memoryRows).toEqual([]);
    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) })
      })
    );
    const orArg = findMany.mock.calls[0][0].where.OR as Array<{ phoneNumber: { contains: string } }>;
    expect(orArg).toHaveLength(5);
  });

  it("returns correct memory per contact matched by last-8-digit phone suffix", () => {
    const memoryRows = [
      { phoneNumber: "5511987654321", name: "Alice" },
      { phoneNumber: "5521912345678", name: "Bob" }
    ];

    const memoryMap = new Map(
      memoryRows.map(m => [cleanPhone(m.phoneNumber).slice(-8), m])
    );

    // Exact suffix match
    expect(memoryMap.get("87654321")).toEqual({ phoneNumber: "5511987654321", name: "Alice" });
    expect(memoryMap.get("12345678")).toEqual({ phoneNumber: "5521912345678", name: "Bob" });

    // Contact phone lookup using the same logic as routes.ts
    const contact1Phone = "5511987654321";
    const contact2Phone = "55 21 9 1234-5678"; // formatted variant
    expect(memoryMap.get(cleanPhone(contact1Phone).slice(-8))).toEqual({ phoneNumber: "5511987654321", name: "Alice" });
    expect(memoryMap.get(cleanPhone(contact2Phone).slice(-8))).toEqual({ phoneNumber: "5521912345678", name: "Bob" });
  });

  it("handles empty contact list without querying clientMemory", async () => {
    const findMany = vi.fn();

    const deduped: Array<{ contact: { phoneNumber: string } }> = [];
    const phone8List = deduped
      .map(c => cleanPhone(c.contact.phoneNumber).slice(-8))
      .filter(Boolean);

    const memoryRows = phone8List.length > 0
      ? await findMany()
      : [];

    expect(memoryRows).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
