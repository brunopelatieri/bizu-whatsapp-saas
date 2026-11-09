import { cn } from "@/lib/utils";

/**
 * Etiqueta como chip: fundo e borda na cor da etiqueta com transparência, texto na cor. O
 * nome sempre aparece (a cor sozinha não é informação). Texto puro, renderizado pelo React.
 */
export function TagChip({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center truncate rounded-full border px-2 py-0.5 text-xs font-medium",
        className,
      )}
      style={{ backgroundColor: `${color}20`, borderColor: `${color}40`, color }}
    >
      <span className="truncate">{name}</span>
    </span>
  );
}
