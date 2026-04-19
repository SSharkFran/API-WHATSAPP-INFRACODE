/**
 * formatPhone — normalize and display a contact phone number.
 *
 * Locked contract (02-UI-SPEC.md decision D-FORMAT):
 *   - +55 numbers → pt-BR format (+55 DDD NNNNN-NNNN or +55 DDD NNNN-NNNN)
 *   - Other country codes → E.164 as-is
 *   - null/undefined/LID → "Aguardando número"
 *   - Unparseable garbage → "Contato desconhecido"
 *   - No external dependencies (libphonenumber-js is prohibited)
 */
export function formatPhone(raw: string | null | undefined): string {
  if (raw == null) return "Aguardando número";

  // Strip JID suffixes (@s.whatsapp.net, @c.us, @lid, etc.)
  const stripped = raw.replace(/@[^@]*$/, "");

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
