import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { PageTitle, QueryState } from "@/components/admin/query-state";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { CustomerFormDialog } from "@/components/app/customers/customer-form-dialog";
import { CustomerPhoneChangeCard } from "@/components/app/customers/customer-phone-change-card";
import { CustomerStatusBadge } from "@/components/app/customers/customer-status-badge";
import { TeamLinkDialog } from "@/components/app/customers/customer-team-link";
import {
  type Customer,
  formatDateTime,
  useCustomer,
  useCustomerMutation,
} from "@/components/app/customers/customers-api";
import { Can } from "@/components/auth/can";
import { phoneKindOf, StartConversationButton } from "@/components/inbox/new-conversation-dialog";
import { DetailRow } from "@/components/detail-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { roleLabel } from "@/lib/auth/permissions";
import { conversationsLabel } from "@/lib/format/conversations";
import { formatPhoneForDisplay } from "@/lib/phone/br";
import { TagChip } from "@/components/crm/tag-chip";
import { TagPicker } from "@/components/crm/tag-picker";
import { useCustomFields } from "@/components/crm/custom-fields-api";
import {
  displayCustomFieldValue,
  type CustomFieldValues,
  missingRequired,
} from "@/lib/crm/values";

/** Etiquetas do cliente: chips para quem lê, seletor para quem edita (`customer:update`). */
function CustomerTags({ customer }: { customer: Customer }) {
  const update = useCustomerMutation("Etiquetas atualizadas.");
  const ids = customer.tags.map(({ id }) => id);

  return (
    <Can
      resource="customer"
      action="update"
      fallback={
        customer.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {customer.tags.map((tag) => (
              <TagChip key={tag.id} name={tag.name} color={tag.color} />
            ))}
          </div>
        ) : null
      }
    >
      <TagPicker
        value={ids}
        disabled={update.isPending}
        onChange={(next) =>
          update.mutate({
            path: `/api/customers/${customer.id}`,
            method: "PATCH",
            body: { tagIds: next },
          })
        }
      />
    </Can>
  );
}

/**
 * Campos adicionais do cliente, das definições ativas; vazio mostra "–". Obrigatório sem
 * valor aparece como pendente (o cadastro pelo atendimento não traz o bloco e passa).
 * Quem edita usa o formulário de "Editar".
 */
function CustomFieldsCard({ customer }: { customer: Customer }) {
  const definitions = useCustomFields();
  const defs = definitions.data ?? [];
  if (defs.length === 0) return null;

  const pending = missingRequired(defs, customer.customFields as CustomFieldValues);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Campos adicionais</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.length > 0 ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Campos obrigatórios pendentes: {pending.join(", ")}.
          </p>
        ) : null}
        <dl className="space-y-3 text-sm">
          {defs.map((def) => (
            <DetailRow
              key={def.id}
              label={def.label}
              value={displayCustomFieldValue(def, customer.customFields[def.id])}
            />
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** Ficha sem ligação: quem edita pode ligá-la a uma pessoa da equipe, à mão (D-9). */
function TeamLinkAction({ customer }: { customer: Customer }) {
  const [open, setOpen] = useState(false);

  return (
    <Can resource="customer" action="update">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pessoa da equipe</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Se este cliente também é da equipe (por exemplo, com o mesmo e-mail), ligue a ficha à pessoa
            para mostrar o papel dela aqui.
          </p>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Ligar a uma pessoa da equipe
          </Button>
          <TeamLinkDialog customer={customer} open={open} onClose={() => setOpen(false)} />
        </CardContent>
      </Card>
    </Can>
  );
}

/**
 * Ficha de quem é da equipe (D-9/D-11). Remover a pessoa da equipe, ou ela excluir a conta, apaga esta
 * ficha e as conversas do número dela; desfazer a ligação mantém a ficha (a ação é só de quem edita).
 * Sem ligação, a ação de ligar à mão.
 */
function TeamLinkCard({ customer }: { customer: Customer }) {
  const queryClient = useQueryClient();
  const unlink = useCustomerMutation("Ligação desfeita. A ficha fica com a organização.");
  if (!customer.team) return <TeamLinkAction customer={customer} />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Também é da equipe</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Esta ficha está ligada a uma pessoa da equipe ({roleLabel(customer.team.role)}). Se ela for
          removida da equipe ou excluir a própria conta,{" "}
          <strong>esta ficha e as conversas do número dela são apagadas, sem volta</strong>.
        </p>
        <p className="text-muted-foreground">
          Para manter a ficha, desfaça a ligação antes. Ela continua como cliente comum e nada é
          apagado quando a pessoa sair.
        </p>
        <Can resource="customer" action="update">
          <Button
            variant="outline"
            disabled={unlink.isPending}
            onClick={() =>
              unlink.mutate(
                { path: `/api/customers/${customer.id}/team-link`, method: "DELETE" },
                // O aviso da remoção de membros (`/app/equipe`) vem da lista da equipe.
                { onSuccess: () => queryClient.invalidateQueries({ queryKey: ["team"] }) },
              )
            }
          >
            Desfazer a ligação com a equipe
          </Button>
        </Can>
      </CardContent>
    </Card>
  );
}

function PortalAccessCard({ customer }: { customer: Customer }) {
  const invite = useCustomerMutation("Acesso enviado por e-mail.");
  const changeStatus = useCustomerMutation("Situação atualizada.");
  const path = `/api/customers/${customer.id}`;
  const blocked = customer.status === "blocked";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Portal do cliente</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="space-y-3 text-sm">
          <DetailRow
            label="Acesso enviado em"
            value={customer.invitedAt ? formatDateTime(customer.invitedAt) : null}
          />
          <DetailRow label="Último acesso" value={formatDateTime(customer.lastLoginAt)} />
        </dl>
        <div className="flex flex-wrap gap-2">
          <Can resource="customer" action="invite">
            <Button
              disabled={blocked || invite.isPending || !customer.email}
              onClick={() => invite.mutate({ path: `${path}/invite`, method: "POST" })}
            >
              {customer.invitedAt
                ? "Reenviar acesso ao portal"
                : "Enviar acesso ao portal"}
            </Button>
          </Can>
          {customer.email ? null : (
            <p className="basis-full text-xs text-muted-foreground">
              Cadastre um e-mail para liberar o acesso do cliente.
            </p>
          )}
          <Can resource="customer" action="update">
            <Button
              variant="outline"
              disabled={changeStatus.isPending}
              onClick={() =>
                changeStatus.mutate({
                  path,
                  method: "PATCH",
                  body: { status: blocked ? "lead" : "blocked" },
                })
              }
            >
              {blocked ? "Desbloquear" : "Bloquear"}
            </Button>
          </Can>
        </div>
        {blocked ? (
          <p className="text-sm text-muted-foreground">
            Desbloqueado, o cliente volta a lead e entra depois de um novo envio.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function CustomerDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const query = useCustomer(id);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const remove = useCustomerMutation("Cliente removido.");
  const customer = query.data?.customer;

  function confirmRemoval() {
    remove.mutate(
      { path: `/api/customers/${id}`, method: "DELETE" },
      { onSuccess: () => navigate("/app/clientes", { replace: true }) },
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        to="/app/clientes"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Clientes
      </Link>

      <QueryState {...query}>
        {customer ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <PageTitle title={customer.name} />
                <CustomerStatusBadge status={customer.status} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StartConversationButton
                  target={{ customerId: customer.id }}
                  name={customer.name}
                  phoneKind={phoneKindOf(customer.phoneNormalized)}
                />
                <Can resource="customer" action="update">
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    Editar
                  </Button>
                </Can>
                <Can resource="customer" action="delete">
                  <Button variant="ghost" onClick={() => setRemoving(true)}>
                    Remover
                  </Button>
                </Can>
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dados</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="space-y-3 text-sm">
                  <DetailRow label="E-mail" value={customer.email} />
                  <DetailRow
                    label="Telefone"
                    value={customer.phoneNormalized ? formatPhoneForDisplay(customer.phoneNormalized) : null}
                  />
                  <DetailRow label="Documento" value={customer.document} />
                </dl>
                <CustomerTags customer={customer} />
                {customer.notes ? (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {customer.notes}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            <CustomFieldsCard customer={customer} />

            <CustomerPhoneChangeCard customer={customer} />

            <PortalAccessCard customer={customer} />

            <TeamLinkCard customer={customer} />

            <CustomerFormDialog
              open={editing}
              customer={customer}
              onClose={() => setEditing(false)}
            />
            <ConfirmDialog
              open={removing}
              title="Remover cliente"
              description={
                <>
                  {customer.name} sai desta organização e perde o acesso ao portal na hora.{" "}
                  <strong>
                    {customer.conversationCount
                      ? `${conversationsLabel(customer.conversationCount)} de WhatsApp, com as mensagens e os arquivos, serão apagadas sem volta.`
                      : "As conversas e os arquivos do atendimento ligados a este cliente também são apagados, sem volta."}
                  </strong>
                </>
              }
              confirmLabel="Remover"
              pending={remove.isPending}
              onConfirm={confirmRemoval}
              onCancel={() => setRemoving(false)}
            />
          </>
        ) : null}
      </QueryState>
    </div>
  );
}
