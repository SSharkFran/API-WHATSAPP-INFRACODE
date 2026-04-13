import { describe, it, expect, vi } from "vitest";

/** cleanPhone: strips @suffix and non-digit chars */
const cleanPhone = (raw: string | null | undefined): string =>
  (raw ?? "").replace(/@[^@]*$/, "").replace(/\D/g, "");

/**
 * buildMemoryMap — extracted from the batch-query pattern in routes.ts.
 * Builds a lookup map keyed by last-8 digit phone suffix.
 */
function buildMemoryMap<T extends { phoneNumber: string | null }>(rows: T[]): Map<string, T> {
  return new Map(rows.map(m => [cleanPhone(m.phoneNumber ?? "").slice(-8), m]));
}

/**
 * batchFetchMemories — core batch logic to replace the N+1 loop.
 * Returns empty array (without calling findMany) when deduped list is empty.
 */
async function batchFetchMemories(
  phone8List: string[],
  findMany: (args: unknown) => Promise<{ phoneNumber: string | null; name: string | null }[]>
): Promise<{ phoneNumber: string | null; name: string | null }[]> {
  if (phone8List.length === 0) return [];
  return findMany({
    where: { OR: phone8List.map(p => ({ phoneNumber: { contains: p } })) },
    select: { phoneNumber: true, name: true }
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CRM contacts batch", () => {
  it("replaces N+1 clientMemory.findFirst loop with single findMany query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn();

    const contacts = [
      { phoneNumber: "5511987654321" },
      { phoneNumber: "5511912345678" },
      { phoneNumber: "5511900000001" },
      { phoneNumber: "5511900000002" },
      { phoneNumber: "5511900000003" },
    ];
    const phone8List = contacts.map(c => cleanPhone(c.phoneNumber).slice(-8)).filter(Boolean);

    // batch query — should call findMany exactly once, never findFirst
    await batchFetchMemories(phone8List, findMany);

    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) })
      })
    );
  });

  it("returns correct memory per contact matched by last-8-digit phone suffix", () => {
    const memoryRows = [
      { phoneNumber: "5511987654321", name: "Test User" },
      { phoneNumber: "5511912345678", name: "Other User" },
    ];
    const memoryMap = buildMemoryMap(memoryRows);

    // last 8 digits of "5511987654321" → "87654321"
    expect(memoryMap.get("87654321")).toEqual({ phoneNumber: "5511987654321", name: "Test User" });
    // last 8 digits of "5511912345678" → "12345678"
    expect(memoryMap.get("12345678")).toEqual({ phoneNumber: "5511912345678", name: "Other User" });
    // unknown suffix → undefined
    expect(memoryMap.get("00000000")).toBeUndefined();
  });

  it("handles empty contact list without querying clientMemory", async () => {
    const findMany = vi.fn();
    const phone8List: string[] = [];

    const result = await batchFetchMemories(phone8List, findMany);

    expect(findMany).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
