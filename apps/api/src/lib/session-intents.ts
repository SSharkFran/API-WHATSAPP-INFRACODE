// ---------------------------------------------------------------------------
// SESS-09: Static closure phrase list (stub)
// Phase 5 will replace this with a Groq LLM pre-pass classifier.
// Extracted to a pure utility to avoid circular imports between
// InstanceOrchestrator (service.ts) and SessionLifecycleService.
// ---------------------------------------------------------------------------

const CLOSURE_PHRASES = [
  'obrigado',
  'obrigada',
  'era só isso',
  'pode encerrar',
  'até mais',
  'tchau',
  'valeu',
  'foi isso',
  'pode fechar',
  'isso é tudo',
  'finalizei',
  'terminei',
  'não preciso mais',
];

/**
 * Returns true if the given text contains a closure phrase that indicates
 * the client wants to end the session.
 *
 * Normalization: lowercased + NFD diacritics stripped for accent-insensitive matching.
 * Phase 5 will replace this stub with a Groq LLM pre-pass classifier.
 */
export function recognizeCloseIntent(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return CLOSURE_PHRASES.some((phrase) => {
    const normalizedPhrase = phrase
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    return normalized.includes(normalizedPhrase);
  });
}
