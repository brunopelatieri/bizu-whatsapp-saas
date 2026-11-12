import { Check, Circle, X } from "lucide-react";
import { passwordChecklist } from "@/lib/auth/password-checklist";
import { cn } from "@/lib/utils";

/**
 * Barra e checklist ao vivo da política de senha (`src/lib/auth/password-policy.ts`). Só
 * orienta: quem recusa a senha fraca é o schema e o servidor. Não mostra nada com o campo vazio.
 */
export function PasswordStrengthMeter({
  password,
  className,
}: {
  password: string;
  className?: string;
}) {
  const checklist = passwordChecklist(password);

  if (checklist.empty) return null;

  const complete = checklist.met === checklist.total;

  return (
    <div className={cn("grid gap-2", className)}>
      <div
        role="progressbar"
        aria-label="Requisitos da senha cumpridos"
        aria-valuemin={0}
        aria-valuemax={checklist.total}
        aria-valuenow={checklist.met}
        aria-valuetext={`${checklist.met} de ${checklist.total} requisitos`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-all",
            complete ? "bg-chart-2" : "bg-primary/70",
          )}
          style={{ width: `${(checklist.met / checklist.total) * 100}%` }}
        />
      </div>
      <ul className="grid gap-1 text-xs">
        {checklist.items.map((item) => {
          // Só maxLength e noControl chegam aqui violadas; as demais estão pendentes.
          const violated = !item.met && (item.rule === "maxLength" || item.rule === "noControl");
          const Icon = item.met ? Check : violated ? X : Circle;

          return (
            <li
              key={item.rule}
              className={cn(
                "flex items-start gap-1.5",
                item.met
                  ? "text-chart-2"
                  : violated
                    ? "text-destructive"
                    : "text-muted-foreground",
              )}
            >
              <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">
                {item.label}
                <span className="sr-only">{item.met ? " (cumprido)" : violated ? " (violado)" : " (pendente)"}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
