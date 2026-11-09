/**
 * Validação e normalização de telefone (SPEC `crm-cadastro`, seção "Telefone").
 *
 * Formato canônico: só dígitos, com DDI, sem `+` (`5519999249658`). A regra do
 * Brasil (DDD, 9º dígito, fixo) só vale para DDI `55`; número de outro país só
 * passa pela checagem de tamanho do E.164. Referência: `docs/references/
 * mobile_number_brasil_guide.md`. O 9º dígito nunca é inserido.
 *
 * Código puro, sem dependência de servidor: serve o formulário e a API.
 */

export const BR_COUNTRY_CODE = "55";

/** Máximo de caracteres de entrada aceitos antes de qualquer parsing. */
export const PHONE_MAX_INPUT = 30;

/** 67 DDDs ativos no Brasil (Anatel). */
export const BR_AREA_CODES: ReadonlySet<number> = new Set([
  // Sudeste
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
  // Sul
  41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55,
  // Centro-Oeste
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  // Nordeste
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  // Norte
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * `mobile_legacy`: 8 dígitos locais começando em 9 (formato anterior ao 9º dígito),
 * aceito se informado assim, com aviso. `landline`: fixo.
 */
export type PhoneKind = "mobile" | "mobile_legacy" | "landline" | "foreign";

export type PhoneRejectReason =
  | "empty"
  | "invalid_length"
  | "invalid_ddd"
  | "mobile_invalid_ninth_digit"
  | "invalid_local_prefix"
  | "missing_area_code";

export type PhoneNormalizeResult =
  | {
      ok: true;
      /** Dígitos, com DDI, sem `+`: o formato gravado em `phone_normalized`. */
      phone: string;
      /** Chave de comparação, gravada em `phone_key`; igual com e sem o 9º dígito. */
      key: string;
      kind: PhoneKind;
      ddd: number | null;
      /** `true` em `mobile_legacy`: dispara o aviso para conferir o 9. */
      legacy: boolean;
    }
  | { ok: false; reason: PhoneRejectReason };

function fail(reason: PhoneRejectReason): PhoneNormalizeResult {
  return { ok: false, reason };
}

/** Valida DDD + número local (10 ou 11 dígitos, já sem DDI). */
function validateNational(national: string): PhoneNormalizeResult {
  if (national.length !== 10 && national.length !== 11) return fail("invalid_length");
  const ddd = Number.parseInt(national.slice(0, 2), 10);
  if (!BR_AREA_CODES.has(ddd)) return fail("invalid_ddd");

  const local = national.slice(2);
  const phone = BR_COUNTRY_CODE + national;

  if (local.length === 9) {
    if (local[0] !== "9") return fail("mobile_invalid_ninth_digit");
    return { ok: true, phone, key: `${BR_COUNTRY_CODE}${ddd}${local.slice(1)}`, kind: "mobile", ddd, legacy: false };
  }

  const first = local[0];
  if (first === "0" || first === "1") return fail("invalid_local_prefix");
  if (first === "9") {
    return { ok: true, phone, key: `${BR_COUNTRY_CODE}${ddd}${local}`, kind: "mobile_legacy", ddd, legacy: true };
  }
  return { ok: true, phone, key: phone, kind: "landline", ddd, legacy: false };
}

function validateForeign(digits: string): PhoneNormalizeResult {
  if (digits.startsWith("0") || digits.length < 8 || digits.length > 15) {
    return fail("invalid_length");
  }
  return { ok: true, phone: digits, key: digits, kind: "foreign", ddd: null, legacy: false };
}

/** Pipeline completo: a ordem dos passos é o comportamento. */
export function normalizePhone(raw: string): PhoneNormalizeResult {
  const text = raw.trim();
  if (text.length > PHONE_MAX_INPUT) return fail("invalid_length");

  const hasPlus = text.startsWith("+");
  let digits = text.replace(/\D/g, "");
  if (!digits) return fail("empty");

  if (hasPlus) {
    if (digits.startsWith(BR_COUNTRY_CODE)) return validateNational(digits.slice(2));
    return validateForeign(digits);
  }

  // Um zero de tronco (011… → 11…).
  if (digits.startsWith("0")) digits = digits.slice(1);

  // DDI 55 + nacional. Testado antes do nacional sem DDI: um DDD 55 (Santa Maria/RS)
  // sem DDI tem 10 ou 11 dígitos, nunca 12 ou 13.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith(BR_COUNTRY_CODE)) {
    return validateNational(digits.slice(2));
  }
  if (digits.length === 10 || digits.length === 11) return validateNational(digits);
  if (digits.length >= 12 && digits.length <= 15 && !digits.startsWith(BR_COUNTRY_CODE)) {
    return validateForeign(digits);
  }

  // Só o número local, sem DDD: 8 dígitos começando em 2 a 9, ou 9 começando em 9.
  if (
    (digits.length === 8 && /^[2-9]/.test(digits)) ||
    (digits.length === 9 && digits.startsWith("9"))
  ) {
    return fail("missing_area_code");
  }
  return fail("invalid_length");
}

/** Só `mobile` e `foreign` iniciam conversa no WhatsApp (fixo e legado só com histórico). */
export function canWhatsApp(kind: PhoneKind): boolean {
  return kind === "mobile" || kind === "foreign";
}

const ERROR_MESSAGES: Record<PhoneRejectReason, string> = {
  empty: "Informe o telefone.",
  invalid_length: "Número incompleto ou com dígitos a mais.",
  invalid_ddd: "DDD inexistente.",
  mobile_invalid_ninth_digit: "Celular precisa começar com 9 depois do DDD.",
  invalid_local_prefix: "Número inválido.",
  missing_area_code: "Informe o DDD.",
};

export function phoneErrorMessage(reason: PhoneRejectReason): string {
  return ERROR_MESSAGES[reason];
}

/** Aviso não bloqueante por tipo; `null` quando não há o que avisar. */
export function phoneWarning(kind: PhoneKind): string | null {
  if (kind === "landline") return "Telefone fixo: este número não recebe WhatsApp.";
  if (kind === "mobile_legacy") return "Celular com 8 dígitos (formato antigo): confira se falta o 9.";
  return null;
}

/** `5519999249658` → `+55 (19) 99924-9658`; fora do formato do Brasil, `+` e os dígitos. */
export function formatPhoneForDisplay(phone: string): string {
  const clean = phone.replace(/\D/g, "");
  if (!clean) return "";
  if (clean.startsWith(BR_COUNTRY_CODE) && (clean.length === 12 || clean.length === 13)) {
    const national = clean.slice(2);
    const ddd = national.slice(0, 2);
    const local = national.slice(2);
    const cut = local.length === 9 ? 5 : 4;
    return `+55 (${ddd}) ${local.slice(0, cut)}-${local.slice(cut)}`;
  }
  return `+${clean}`;
}

/** Para a tela: o telefone digitado em formato de exibição; o que não passar volta como veio. */
export function displayPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const result = normalizePhone(raw);
  return result.ok ? formatPhoneForDisplay(result.phone) : raw;
}

/**
 * O número e, para celular do Brasil, as formas com e sem o 9º dígito. Serve às buscas
 * por igualdade; o cadastro grava o número como veio e nunca converte.
 */
export function phoneVariants(phone: string): string[] {
  const clean = phone.replace(/\D/g, "");
  if (!clean.startsWith(BR_COUNTRY_CODE)) return clean ? [clean] : [];
  const national = clean.slice(2);
  const ddd = Number.parseInt(national.slice(0, 2), 10);
  if (!BR_AREA_CODES.has(ddd)) return [clean];
  const local = national.slice(2);
  if (national.length === 11 && local[0] === "9") {
    return [clean, `${BR_COUNTRY_CODE}${national.slice(0, 2)}${local.slice(1)}`];
  }
  if (national.length === 10 && /^[6-9]/.test(local)) {
    return [clean, `${BR_COUNTRY_CODE}${national.slice(0, 2)}9${local}`];
  }
  return [clean];
}

/** Dois números do mesmo aparelho, com ou sem o 9º dígito. */
export function phonesMatch(a: string, b: string): boolean {
  const left = new Set(phoneVariants(a));
  return phoneVariants(b).some((variant) => left.has(variant));
}
