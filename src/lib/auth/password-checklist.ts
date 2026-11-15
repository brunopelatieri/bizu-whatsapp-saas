import {
  evaluatePassword,
  isPasswordValid,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARS,
  type PasswordRule,
} from "@/lib/auth/password-policy";

/** Regras sempre listadas, na ordem em que aparecem. */
const ALWAYS_VISIBLE: PasswordRule[] = [
  "minLength",
  "uppercase",
  "lowercase",
  "number",
  "special",
];

/** Só aparecem quando violadas: não pesam na barra. */
const ONLY_WHEN_VIOLATED: PasswordRule[] = ["maxLength", "noControl"];

const LABELS: Record<PasswordRule, string> = {
  minLength: `Mínimo de ${PASSWORD_MIN_LENGTH} caracteres`,
  maxLength: `No máximo ${PASSWORD_MAX_LENGTH} caracteres`,
  uppercase: "Uma letra maiúscula",
  lowercase: "Uma letra minúscula",
  number: "Um número",
  special: `Um caractere especial (${PASSWORD_SPECIAL_CHARS})`,
  noControl: "Sem caracteres de controle",
};

export type PasswordChecklistItem = {
  rule: PasswordRule;
  label: string;
  met: boolean;
};

export type PasswordChecklist = {
  /** Campo vazio: a tela não mostra nada. */
  empty: boolean;
  items: PasswordChecklistItem[];
  /** Regras sempre visíveis cumpridas, e o total delas (a barra). */
  met: number;
  total: number;
  /** A senha cumpre toda a política (inclui `maxLength` e `noControl`). */
  valid: boolean;
};

/** Quais linhas o medidor mostra, e quantas regras estão cumpridas. Sem entropia. */
export function passwordChecklist(password: string): PasswordChecklist {
  const result = evaluatePassword(password);
  const visible = [
    ...ALWAYS_VISIBLE,
    ...ONLY_WHEN_VIOLATED.filter((rule) => !result[rule]),
  ];

  return {
    empty: password.length === 0,
    items: visible.map((rule) => ({
      rule,
      label: LABELS[rule],
      met: result[rule],
    })),
    met: ALWAYS_VISIBLE.filter((rule) => result[rule]).length,
    total: ALWAYS_VISIBLE.length,
    valid: isPasswordValid(result),
  };
}
