import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  type ConversationTemplate,
  errorText,
  useConversationTemplates,
} from "@/components/inbox/inbox-api";
import { useInboxCan, useInboxScope } from "@/components/inbox/inbox-scope";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { renderTemplate, TEMPLATE_VARIABLE_MAX, variableProblem } from "@/lib/inbox/templates";
import { cn } from "@/lib/utils";

/**
 * Modelos aprovados do WABA do canal, com as variáveis e a prévia. A única forma de falar com a janela de
 * 24 h fechada. A prévia usa a mesma função que o servidor usa para gravar o texto (`templates.ts`), então
 * o que se vê é o que o contato recebe. Modelo que a tela ainda não sabe enviar (mídia no cabeçalho, botão
 * com variável...) aparece desabilitado, com o motivo. Criar e submeter modelos é da Meta: aqui só se usa.
 */

type TemplateDialogProps = {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  /** Resolve quando o envio foi aceito; rejeita com o erro da API, que o diálogo mostra. */
  onSubmit: (input: {
    templateId: string;
    variables: string[];
    name: string;
    rendered: string;
  }) => Promise<void>;
};

function slotLabel(template: ConversationTemplate, index: number) {
  const slot = template.slots[index];
  if (!slot) return "";
  const where = slot.component === "header" ? "cabeçalho" : "corpo";
  return `Variável {{${slot.name}}} (${where})`;
}

/** O modelo com o formato que `renderTemplate` espera. */
function analysisOf(template: ConversationTemplate) {
  return {
    supported: true as const,
    slots: template.slots,
    positional: template.positional,
    header: template.header,
    body: template.body ?? "",
    footer: template.footer,
  };
}

export function TemplateDialog({ open, onClose, conversationId, onSubmit }: TemplateDialogProps) {
  const can = useInboxCan();
  const { channelsRoute } = useInboxScope();
  const query = useConversationTemplates(conversationId, open);
  const templates = query.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = templates.find((item) => item.id === selectedId && item.supported) ?? null;

  // Cada abertura começa sem escolha.
  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setValues([]);
    setError(null);
    setSending(false);
  }, [open]);

  function choose(template: ConversationTemplate) {
    if (!template.supported) return;
    setSelectedId(template.id);
    setValues(template.slots.map(() => ""));
    setError(null);
  }

  const rendered = useMemo(
    () => (selected ? renderTemplate(analysisOf(selected), values) : ""),
    [selected, values],
  );
  const problem = selected
    ? (values.map((value) => variableProblem(value)).find(Boolean) ?? null)
    : "Escolha um modelo.";

  async function submit() {
    if (!selected || problem || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit({
        templateId: selected.id,
        variables: values.map((value) => value.trim()),
        name: selected.name,
        rendered,
      });
      onClose();
    } catch (failure) {
      setError(errorText(failure));
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !sending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Enviar modelo de mensagem</DialogTitle>
          <DialogDescription>
            Só modelos aprovados pela Meta para este número. Com a janela de 24 horas encerrada, o modelo é a
            única forma de reabrir a conversa.
          </DialogDescription>
        </DialogHeader>

        {query.isPending ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Carregando modelos…
          </p>
        ) : query.isError ? (
          <div className="space-y-2 py-4 text-sm">
            <p className="text-destructive">{errorText(query.error)}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
              Tentar novamente
            </Button>
          </div>
        ) : templates.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Este número não tem modelos aprovados.{" "}
            {can("channel", "read") ? (
              <>
                Sincronize os modelos em{" "}
                <Link to={channelsRoute} className="font-medium text-primary underline">
                  Números
                </Link>
                .
              </>
            ) : (
              "Peça a quem administra para sincronizar os modelos."
            )}
          </p>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-sm font-medium">Modelo</legend>
              <div className="grid max-h-44 gap-1.5 overflow-y-auto pr-1">
                {templates.map((template) => (
                  <label
                    key={template.id}
                    className={cn(
                      "cursor-pointer rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted",
                      "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                      !template.supported && "cursor-not-allowed opacity-60 hover:bg-transparent",
                    )}
                  >
                    <input
                      type="radio"
                      name="template"
                      className="sr-only"
                      checked={template.id === selectedId}
                      disabled={sending || !template.supported}
                      onChange={() => choose(template)}
                    />
                    <span className="block font-medium">{template.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {template.language}
                      {template.category ? ` · ${template.category.toLowerCase()}` : ""}
                    </span>
                    {template.reason ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">{template.reason}</span>
                    ) : null}
                  </label>
                ))}
              </div>
            </fieldset>

            {selected ? (
              <>
                {selected.slots.length > 0 ? (
                  <div className="grid gap-3">
                    {selected.slots.map((slot, index) => (
                      <div key={`${slot.component}-${slot.name}`} className="grid gap-1.5">
                        <Label htmlFor={`template-var-${index}`}>{slotLabel(selected, index)}</Label>
                        <Input
                          id={`template-var-${index}`}
                          value={values[index] ?? ""}
                          onChange={(event) =>
                            setValues((current) =>
                              current.map((value, at) => (at === index ? event.target.value : value)),
                            )
                          }
                          maxLength={TEMPLATE_VARIABLE_MAX}
                          autoComplete="off"
                          disabled={sending}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="grid gap-1.5">
                  <p className="text-sm font-medium">Prévia</p>
                  <p
                    data-testid="template-preview"
                    className="whitespace-pre-wrap break-words rounded-xl rounded-br-md bg-primary/15 px-3 py-2 text-sm dark:bg-primary/25"
                  >
                    {rendered}
                  </p>
                  {values.some((value) => value) && problem ? (
                    <p className="text-xs text-destructive">{problem}</p>
                  ) : null}
                </div>
              </>
            ) : null}

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={Boolean(problem) || sending}>
                {sending ? <Loader2 className="animate-spin" /> : null}
                Enviar modelo
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
