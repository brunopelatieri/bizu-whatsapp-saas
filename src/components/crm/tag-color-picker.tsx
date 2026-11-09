import { useState } from "react";
import { Input } from "@/components/ui/input";
import { contrastRatio, MIN_TAG_CONTRAST, normalizeHexColor } from "@/lib/crm/colors";
import { TAG_COLOR_PRESETS } from "@/lib/crm/constants";
import { cn } from "@/lib/utils";

/** Superfícies dos dois temas, para avisar quando o chip some contra uma delas. */
const SURFACES = ["#ffffff", "#0a0a0a"] as const;

/**
 * 8 presets e um campo hexadecimal. A cor sempre sai normalizada (`#rrggbb`); o aviso de
 * contraste não bloqueia.
 */
export function TagColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const [text, setText] = useState(value);
  const normalized = normalizeHexColor(text);
  const lowContrast =
    normalized !== null &&
    SURFACES.some((surface) => contrastRatio(normalized, surface) < MIN_TAG_CONTRAST);

  return (
    <div className="grid gap-2">
      <fieldset className="flex flex-wrap gap-1.5">
        <legend className="sr-only">Cor da etiqueta</legend>
        {TAG_COLOR_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            aria-pressed={value === color}
            aria-label={color}
            onClick={() => {
              setText(color);
              onChange(color);
            }}
            className={cn(
              "size-6 rounded-full border-2 border-transparent outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              value === color && "border-foreground",
            )}
            style={{ backgroundColor: color }}
          />
        ))}
      </fieldset>
      <Input
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const next = normalizeHexColor(event.target.value);
          if (next) onChange(next);
        }}
        aria-label="Cor em hexadecimal"
        aria-invalid={normalized === null}
        placeholder="#3b82f6"
        maxLength={7}
        className="w-32"
      />
      {normalized === null ? (
        <p className="text-xs text-destructive">Cor inválida. Use o formato #rrggbb.</p>
      ) : lowContrast ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Esta cor tem pouco contraste em um dos temas: a etiqueta pode ficar difícil de ler.
        </p>
      ) : null}
    </div>
  );
}
