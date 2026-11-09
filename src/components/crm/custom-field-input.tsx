import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CUSTOM_FIELD_TEXT_MAX } from "@/lib/crm/constants";
import type { CustomFieldDef } from "@/lib/crm/values";

const NONE = "__none__";

const BOOLEAN_ITEMS = [
  { value: NONE, label: "Não informado" },
  { value: "true", label: "Sim" },
  { value: "false", label: "Não" },
];

/**
 * Um controle por tipo de campo adicional. Controlado: `value` é o que o servidor guarda
 * (texto, número, `AAAA-MM-DD`, booleano, `value` da opção ou lista de `value`) e `null`
 * quer dizer "sem valor". Quem usa decide quando gravar.
 */
export function CustomFieldInput({
  field,
  value,
  onChange,
  invalid = false,
  id,
}: {
  field: CustomFieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  invalid?: boolean;
  id?: string;
}) {
  switch (field.type) {
    case "text":
      return (
        <Input
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          maxLength={CUSTOM_FIELD_TEXT_MAX}
          aria-invalid={invalid}
          autoComplete="off"
        />
      );

    case "number":
      return (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step="any"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? null : Number(raw));
          }}
          aria-invalid={invalid}
          autoComplete="off"
        />
      );

    case "date":
      return (
        <Input
          id={id}
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value || null)}
          aria-invalid={invalid}
        />
      );

    case "boolean":
      return (
        <Select
          items={BOOLEAN_ITEMS}
          value={typeof value === "boolean" ? String(value) : NONE}
          onValueChange={(next) => onChange(next === "true" ? true : next === "false" ? false : null)}
        >
          <SelectTrigger id={id} className="w-full" aria-invalid={invalid}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BOOLEAN_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "select": {
      const items = [{ value: NONE, label: "Não informado" }, ...field.options];

      return (
        <Select
          items={items}
          value={typeof value === "string" ? value : NONE}
          onValueChange={(next) => onChange(next && next !== NONE ? next : null)}
        >
          <SelectTrigger id={id} className="w-full" aria-invalid={invalid}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    case "multiselect": {
      const selected = Array.isArray(value) ? (value as string[]) : [];

      return (
        <fieldset
          id={id}
          aria-invalid={invalid}
          className="flex flex-wrap gap-x-4 gap-y-1.5 m-0 min-w-0 rounded-lg border border-input px-2.5 py-2"
        >
          {field.options.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => {
                  const next = selected.includes(option.value)
                    ? selected.filter((item) => item !== option.value)
                    : [...selected, option.value];
                  onChange(next.length > 0 ? next : null);
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      );
    }
  }
}
