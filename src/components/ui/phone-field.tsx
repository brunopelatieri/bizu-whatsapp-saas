import { forwardRef, type ComponentProps } from "react";
import PhoneInput from "react-phone-number-input/min";
import labels from "react-phone-number-input/locale/pt-BR.json";
import "react-phone-number-input/style.css";
import { Input } from "@/components/ui/input";
import { normalizePhone, phoneWarning } from "@/lib/phone/br";
import { cn } from "@/lib/utils";

/**
 * Campo de telefone dos formulários de pessoa (`/cadastro`, portal, `/admin`, cliente).
 *
 * É só apresentação: seletor de país (Brasil como padrão) e máscara enquanto se digita. O
 * valor que sobe é o E.164 com `+` (`+5511987654321`), que `normalizePhone` lê igual ao
 * número digitado no Brasil e sem ambiguidade nos demais países. Quem valida é o
 * `phoneSchema`, no formulário e de novo no servidor. Mostra o aviso não bloqueante (fixo e
 * celular de 8 dígitos) abaixo do campo.
 */

type PhoneFieldProps = {
  value?: string | null;
  onChange: (value: string) => void;
  onBlur?: () => void;
  name?: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  "aria-describedby"?: string;
  className?: string;
  /** Classes do campo de texto (as telas de autenticação usam o próprio estilo de campo). */
  inputClassName?: string;
};

const TextInput = forwardRef<HTMLInputElement, ComponentProps<"input">>(
  function TextInput(props, ref) {
    return <Input ref={ref} {...props} />;
  },
);

/** `+5511987654321` a partir do que o servidor guardou (`phone_normalized`: dígitos com DDI). */
export function toPhoneFieldValue(phoneNormalized: string | null | undefined) {
  return phoneNormalized ? `+${phoneNormalized}` : "";
}

export function PhoneField({
  value,
  onChange,
  onBlur,
  name,
  id,
  disabled,
  invalid,
  className,
  inputClassName,
  "aria-describedby": describedBy,
}: PhoneFieldProps) {
  const parsed = value ? normalizePhone(value) : null;
  const warning = parsed?.ok ? phoneWarning(parsed.kind) : null;

  return (
    <div className={cn("grid gap-1", className)}>
      <PhoneInput
        international={false}
        defaultCountry="BR"
        labels={labels}
        value={value || undefined}
        onChange={(next) => onChange(next ?? "")}
        onBlur={onBlur}
        name={name}
        id={id}
        disabled={disabled}
        inputComponent={TextInput}
        numberInputProps={{ className: inputClassName }}
        inputMode="tel"
        autoComplete="tel"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="flex items-center gap-2"
      />
      {warning ? <p className="text-xs text-muted-foreground">{warning}</p> : null}
    </div>
  );
}
