/**
 * formatPhone — normalize and display a contact phone number.
 *
 * Locked contract (CONTEXT.md decision D-FORMAT):
 *   - +55 numbers → pt-BR format
 *   - Other country codes → E.164 as-is
 *   - null/undefined/LID → "Aguardando número"
 *   - Unparseable garbage → "Contato desconhecido"
 *   - No external dependencies (libphonenumber-js is prohibited)
 */
export function formatPhone(raw: string | null | undefined): string {
  if (raw == null) return "Aguardando número";

  // Strip JID suffixes (@s.whatsapp.net, @c.us, @lid, etc.)
  const stripped = raw.replace(/@[^@]*$/, "");

  // If the stripped value is a @lid-style numeric string that is NOT a real phone,
  // treat as unresolved. LID strings are short numeric codes (< 10 digits without country code).
  // However, we cannot distinguish LID digits from real short numbers by digits alone —
  // callers must pass null for unresolved LID contacts (phoneNumber column is null after Plan 2.1).
  // If we get here with a non-null value that strips to pure digits < 10 long, treat as garbage.

  const digits = stripped.replace(/\D/g, "");
  if (!digits) return "Contato desconhecido";

  // pt-BR: starts with 55, total digits 12 (10-digit local) or 13 (11-digit local)
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const local = digits.slice(2); // remove country code
    if (local.length === 11) {
      // Mobile: +55 DDD NNNNN-NNNN
      return `+55 ${local.slice(0, 2)} ${local.slice(2, 7)}-${local.slice(7)}`;
    }
    if (local.length === 10) {
      // Landline: +55 DDD NNNN-NNNN
      return `+55 ${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
    }
  }

  // International E.164: digits > 10 total, return with leading +
  if (digits.length > 10) return `+${digits}`;

  // Too short to be a real phone number
  return "Contato desconhecido";
}
