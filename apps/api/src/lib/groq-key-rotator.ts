interface KeyEntry {
  key: string;
  failCount: number;
  nextAvailableAt: number;
}

const COOLDOWN_429_MS = 15_000;
const BLACKLIST_AFTER_FAILS = 4;
const BLACKLIST_COOLDOWN_MS = 120_000;

/**
 * Gerencia um pool de chaves de API do GROQ com rotacao automatica
 * em caso de rate limit (429) ou erros consecutivos.
 */
export class GroqKeyRotator {
  private readonly entries: KeyEntry[];

  public constructor(keys: string[]) {
    this.entries = keys
      .map((k) => k.trim())
      .filter(Boolean)
      .map((key) => ({ key, failCount: 0, nextAvailableAt: 0 }));
  }

  public get size(): number {
    return this.entries.length;
  }

  /**
   * Retorna as chaves disponiveis (sem cooldown ativo) em ordem de disponibilidade.
   * Chaves em cooldown sao puladas.
   */
  public availableKeys(): string[] {
    const now = Date.now();
    return this.entries
      .filter((e) => e.nextAvailableAt <= now)
      .map((e) => e.key);
  }

  public reportSuccess(key: string): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry) return;
    entry.failCount = 0;
    entry.nextAvailableAt = 0;
  }

  public reportFailure(key: string, status: number): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry) return;

    entry.failCount += 1;
    const now = Date.now();

    if (status === 429) {
      entry.nextAvailableAt = now + COOLDOWN_429_MS;
    } else {
      const multiplier = Math.min(entry.failCount, BLACKLIST_AFTER_FAILS);
      entry.nextAvailableAt = now + COOLDOWN_429_MS * multiplier;
    }

    if (entry.failCount >= BLACKLIST_AFTER_FAILS) {
      entry.nextAvailableAt = now + BLACKLIST_COOLDOWN_MS;
    }

    console.warn(
      `[groq-rotator] key ...${key.slice(-6)} falhou status=${status} failCount=${entry.failCount} ` +
      `cooldown=${Math.round((entry.nextAvailableAt - now) / 1000)}s`
    );
  }
}
