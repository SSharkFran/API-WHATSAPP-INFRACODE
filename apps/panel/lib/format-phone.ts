/**
 * formatPhone — client-side mirror of apps/api/src/lib/format-phone.ts
 * Identical logic. No external dependencies.
 *
 * Locked contract (CONTEXT.md decision D-FORMAT):
 *   - +55 numbers → pt-BR format
 *   - Other country codes → E.164 as-is
 *   - null/undefined/LID → "Aguardando número"
 *   - Unparseable garbage → "Contato desconhecido"
 */
export function formatPhone(raw: string | null | undefined): string {
  if (raw == null) return "Aguardando número";
  const stripped = raw.replace(/@[^@]*$/, "");
  const digits = stripped.replace(/\D/g, "");
  if (!digits) return "Contato desconhecido";
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const local = digits.slice(2);
    if (local.length === 11) return `+55 ${local.slice(0, 2)} ${local.slice(2, 7)}-${local.slice(7)}`;
    if (local.length === 10) return `+55 ${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
  }
  if (digits.length > 10) return `+${digits}`;
  return "Contato desconhecido";
}
