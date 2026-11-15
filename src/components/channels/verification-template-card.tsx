import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Channel, useChannelMutation } from "@/components/channels/channels-api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api/client";

/**
 * Modelo que leva o link de verificação de telefone neste número Cloud (SPEC `pre-producao`, T4).
 * Escolhe entre os modelos **aprovados já sincronizados** do número, ou tira. Quem confere se o
 * modelo serve (aprovado, um botão de URL no endereço deste sistema, sem outras variáveis) é a
 * API: o motivo do 422 aparece aqui como veio. Sem modelo, o número não envia o link e o envio
 * passa ao próximo canal.
 *
 * Serve `/app` e `/admin` pelo mesmo componente: `basePath` decide a API e o escopo.
 */

type Template = { id: string; name: string; language: string; status: string };
type TemplateList = { templates: Template[]; syncedAt: string | null };

const keyOf = (item: { name: string; language: string }) => `${item.name}|${item.language}`;

export function VerificationTemplateCard({
  basePath,
  channel,
}: {
  basePath: string;
  channel: Channel;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const current = channel.verificationTemplate ?? null;
  const templates = useQuery({
    queryKey: ["channel-templates", basePath, channel.id, "approved"],
    queryFn: () =>
      apiFetch<TemplateList>(`${basePath}/${channel.id}/templates?status=APPROVED`),
    retry: false,
  });
  const save = useChannelMutation("Modelo de verificação atualizado.", { silent: true });
  const sync = useChannelMutation<unknown>("Modelos sincronizados com a Meta.");

  const options = templates.data?.templates ?? [];
  const items = options.map((item) => ({
    value: keyOf(item),
    label: `${item.name} (${item.language})`,
  }));
  const selected = chosen ?? (current ? keyOf(current) : null);
  const chosenTemplate = options.find((item) => keyOf(item) === selected) ?? null;

  async function apply(template: { name: string; language: string } | null) {
    setFailure(null);
    try {
      await save.mutateAsync({
        path: `${basePath}/${channel.id}/verification-template`,
        method: "PUT",
        body: { template },
      });
      setChosen(null);
    } catch (error) {
      // 422 com o motivo, 404 de modelo que sumiu: fica junto do seletor.
      setFailure(error instanceof Error ? error.message : "Não foi possível salvar o modelo.");
    }
  }

  async function syncNow() {
    await sync
      .mutateAsync({ path: `${basePath}/${channel.id}/templates/sync`, method: "POST" })
      .catch(() => null);
    await templates.refetch();
  }

  return (
    <section className="space-y-3" aria-labelledby="cloud-verification-title">
      <h3 id="cloud-verification-title" className="text-sm font-semibold">
        Modelo de verificação de telefone
      </h3>
      <p className="text-sm">
        {current ? (
          <>
            Em uso: <strong className="break-all">{current.name}</strong> ({current.language})
          </>
        ) : (
          <span className="text-muted-foreground">
            Nenhum modelo escolhido: este número não envia o link de verificação, e o envio passa
            ao próximo número.
          </span>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        O modelo precisa estar aprovado, ter um único botão de URL dinâmica que termina em{" "}
        <code>/verificar-telefone?token={"{{1}}"}</code> no endereço deste sistema e não ter outra
        variável. A Meta só deixa a empresa começar a conversa por modelo.
      </p>

      {templates.isPending ? (
        <p className="text-sm text-muted-foreground">Carregando os modelos…</p>
      ) : templates.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {templates.error.message}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhum modelo aprovado sincronizado. Crie e aprove o modelo na Meta e sincronize.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
          <Select
            items={items}
            value={selected}
            onValueChange={(next) => {
              setChosen(next);
              setFailure(null);
            }}
          >
            <SelectTrigger aria-label="Modelo de verificação" className="w-full">
              <SelectValue placeholder="Escolha um modelo aprovado" />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={
              save.isPending ||
              !chosenTemplate ||
              (current !== null && keyOf(current) === keyOf(chosenTemplate))
            }
            onClick={() => chosenTemplate && void apply(chosenTemplate)}
          >
            {save.isPending ? "Salvando…" : "Usar este modelo"}
          </Button>
        </div>
      )}

      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={sync.isPending}
          onClick={() => void syncNow()}
        >
          {sync.isPending ? "Sincronizando…" : "Sincronizar modelos"}
        </Button>
        {current ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => void apply(null)}
          >
            Tirar o modelo
          </Button>
        ) : null}
      </div>
    </section>
  );
}
