import { useState } from "react";
import { Pager } from "@/components/admin/pager";
import { QueryState } from "@/components/admin/query-state";
import {
  useAdminMutation,
  useAdminQuery,
  type Page,
} from "@/components/admin/admin-api";
import {
  PLATFORM_PHONE_QUEUE_PATH,
  type PhoneRelease,
  type PhoneReleasePage,
  releaseErrorMessage,
  useTenantPhoneQueue,
  useTenantPhoneRelease,
} from "@/components/phone/phone-release-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Fila de liberação de telefone à mão (SPEC `pre-producao`, T4). Três usos, uma tela:
 * `/admin/usuarios` (plataforma), `/app/equipe` (pessoas da equipe) e `/app/clientes` (fichas).
 *
 * O número aparece como a rota o devolve. O botão de liberar só aparece para quem pode; quem
 * decide, de verdade, é a API (`phone:confirm` na organização, proprietário na plataforma).
 *
 * O trecho "não prova que o número é da pessoa" é de propósito: a liberação à mão é um ato de fé
 * do responsável, e a tela não deve prometer mais do que o servidor garante.
 */

/** Até onde a liberação vale: o texto da confirmação diz isso, conforme o responsável. */
type Reach = "platform" | "team" | "customer";

const REACH_TEXT: Record<Reach, string> = {
  platform:
    "Liberada por você, a conta passa a valer no sistema inteiro, em todas as organizações.",
  team: "Liberada por você, a pessoa passa a valer só nesta organização. Em outras organizações e na plataforma, o número continua pendente.",
  customer:
    "Liberada por você, a ficha passa a valer só nesta organização. A liberação à mão não atrai as próximas conversas desse número nem liga a ficha a quem é da equipe.",
};

const STATUS_LABEL: Record<PhoneRelease["status"], string> = {
  sent: "Link enviado",
  awaiting_manual: "Aguardando liberação",
};

function formatWhen(value: string) {
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

type QueueResult = {
  data: PhoneReleasePage | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => unknown;
};

type CardProps = {
  title: string;
  description: string;
  reach: Reach;
  /** Só os pedidos deste tipo; a fila da organização mistura equipe e fichas de cliente. */
  subject?: PhoneRelease["subjectType"];
  queue: QueueResult;
  page: number;
  onPage: (page: number) => void;
  pending: boolean;
  release: (id: string) => Promise<unknown>;
};

function PhoneReleaseView({
  title,
  description,
  reach,
  subject,
  queue,
  page,
  onPage,
  pending,
  release,
}: CardProps) {
  // `selected` fica depois de fechar: o texto do diálogo não pode esvaziar durante a animação.
  const [selected, setSelected] = useState<PhoneRelease | null>(null);
  const [open, setOpen] = useState(false);
  const data = queue.data;
  const items = data ? data.items.filter((item) => !subject || item.subjectType === subject) : [];

  async function confirm() {
    if (!selected) return;

    // O erro já foi para o aviso (`onError`); fechar e reler a lista é o que resta a fazer.
    await release(selected.id).catch(() => undefined);
    setOpen(false);
    // Recusada ou não, o pedido pode ter mudado: a lista relê.
    void queue.refetch();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryState
          isPending={queue.isPending}
          isError={queue.isError}
          error={queue.error}
          refetch={() => void queue.refetch()}
        >
          {data ? (
            <>
              {items.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {data.total === 0 || data.total <= data.pageSize
                    ? "Nenhum telefone aguardando liberação."
                    : "Nenhum pedido deste tipo nesta página. Veja as outras páginas."}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="truncate font-medium">{item.name}</p>
                        <p className="text-sm text-muted-foreground">
                          <span className="break-all">{item.phone}</span> · pedido em{" "}
                          {formatWhen(item.createdAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge
                          variant={item.status === "awaiting_manual" ? "default" : "secondary"}
                        >
                          {STATUS_LABEL[item.status]}
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            setSelected(item);
                            setOpen(true);
                          }}
                        >
                          Liberar
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {data.total > data.pageSize || page > 1 ? (
                <>
                  {subject ? (
                    <p className="pt-2 text-xs text-muted-foreground">
                      A fila da organização reúne equipe e clientes ({data.total} pedidos no
                      total); cada tela mostra o seu tipo, e a paginação vale para a fila toda.
                    </p>
                  ) : null}
                  <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={onPage} />
                </>
              ) : null}
            </>
          ) : null}
        </QueryState>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Liberar o telefone de {selected?.name}?</DialogTitle>
            <DialogDescription>
              Número <span className="break-all font-medium">{selected?.phone}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              <strong>A liberação à mão não prova que o número é da pessoa.</strong> Só libere se
              você a conhece e confirmou o número por outro meio.
            </p>
            <p className="text-muted-foreground">{REACH_TEXT[reach]}</p>
            <p className="text-muted-foreground">
              Você não pode liberar o seu próprio telefone. A liberação fica registrada na
              auditoria.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button disabled={pending} onClick={() => void confirm()}>
              {pending ? "Liberando…" : "Liberar telefone"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Fila da organização: `subject` escolhe equipe (`/app/equipe`) ou fichas (`/app/clientes`).
 * A rota que lista também exige `phone:confirm`, então quem monta a tela envolve o cartão em
 * `<Can resource="phone" action="confirm">`: sem a permissão, nada é pedido à API.
 */
export function TenantPhoneReleaseCard({ subject }: { subject: PhoneRelease["subjectType"] }) {
  const [page, setPage] = useState(1);
  const queue = useTenantPhoneQueue(page);
  const release = useTenantPhoneRelease();

  return (
    <PhoneReleaseView
      title={
        subject === "user"
          ? "Telefones da equipe aguardando liberação"
          : "Telefones de clientes aguardando liberação"
      }
      description={
        subject === "user"
          ? "Pessoas da equipe que ainda não confirmaram o WhatsApp. Se o link não chegou, você pode liberar à mão."
          : "Clientes com conta no portal que ainda não confirmaram o WhatsApp. Se o link não chegou, você pode liberar à mão."
      }
      reach={subject === "user" ? "team" : "customer"}
      subject={subject}
      queue={queue}
      page={page}
      onPage={setPage}
      pending={release.isPending}
      release={(id) => release.mutateAsync(id)}
    />
  );
}

/** Fila da plataforma (`/admin/usuarios`). Só o proprietário lê e libera: o suporte nem a vê. */
export function PlatformPhoneReleaseCard() {
  const [page, setPage] = useState(1);
  const queue = useAdminQuery<Page<PhoneRelease>>(PLATFORM_PHONE_QUEUE_PATH, { page });
  const release = useAdminMutation("Telefone liberado.", { errorMessage: releaseErrorMessage });

  return (
    <PhoneReleaseView
      title="Telefones aguardando liberação"
      description="Owners, equipe da plataforma e contas sem organização que não conseguiram confirmar o WhatsApp pelo link. Membros comuns são liberados pela organização deles."
      reach="platform"
      queue={queue}
      page={page}
      onPage={setPage}
      pending={release.isPending}
      release={(id) =>
        release.mutateAsync({
          path: `${PLATFORM_PHONE_QUEUE_PATH}/${id}/confirm`,
          method: "POST",
        })
      }
    />
  );
}
