import type { Redis } from "ioredis";

const incrementExpiringCounterLua = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
else
  local ttl = redis.call("TTL", KEYS[1])
  if ttl < 0 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
  end
end
return current
`;

/**
 * Incrementa um contador Redis e garante TTL atomico no mesmo script.
 */
export const incrementExpiringCounter = async (
  redis: Redis,
  key: string,
  ttlSeconds: number
): Promise<number> => Number(await redis.eval(incrementExpiringCounterLua, 1, key, String(ttlSeconds)));
