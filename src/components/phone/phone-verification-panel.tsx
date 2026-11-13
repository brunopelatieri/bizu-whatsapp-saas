import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, Loader2, MessageCircle, Send } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { AuthShell, authLinkClassName } from "@/components/auth/auth-shell";
import {
  AccountDeletionCard,
  useDeletionStatus,
} from "@/components/privacy/account-deletion-card";
import { ConfirmDeletionCard } from "@/components/privacy/confirm-deletion-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PhoneField } from "@/components/ui/phone-field";
import { apiFetch } from "@/lib/api/client";
import { phoneSchema } from "@/lib/schemas/phone";
import { useAuth } from "@/providers/auth-provider";
import { usePortalAuth } from "@/providers/portal-auth-provider";

/**
 * "Confirme seu WhatsApp" (SPEC `pre-producao`, T3). Com `PHONE_VERIFICATION_REQUIRED=true` é a
 * única tela das áreas autenticadas enquanto a API responde 403 `PHONE_UNVERIFIED`; desligada, o
 * mesmo painel abre a partir do aviso. Quem bloqueia é o servidor: a tela só mostra o estado que
 * `GET …/phone-verification` devolve e chama as rotas que passam pelo portão (`src/api/phone-gate.ts`).
 */

type Area = "team" | "portal";
type Status = "confirmed" | "sent" | "awaiting_manual" | "none";

type Responsible = {
  responsible: "platform" | "organization";
  tenantId: string | null;
  tenantName: string | null;
  status: Status;
  phoneHint?: string | null;
  /** Portal: dá para entrar na organização agora (ficha ativa). Ausente na equipe. */
  enterable?: boolean;
};

type Overview = {
  phoneHint?: string | null;
  answersTo?: "platform" | "organization";
  responsibles: Responsible[];
};

const ENDPOINT: Record<Area, string> = {
  team: "/api/me/phone-verification",
  portal: "/api/portal/me/phone-verification",
};

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

function statusText(row: Responsible) {
  const who =
    row.responsible === "platform"
      ? "do proprietário da plataforma"
      : `de quem administra ${row.tenantName ?? "a organização"}`;

  switch (row.status) {
    case "confirmed":
      return "Confirmado.";
    case "sent":
      return "Enviamos um link. Abra-o neste navegador, com esta conta.";
    case "awaiting_manual":
      return `Sem envio automático agora: aguardando a liberação ${who}.`;
    default:
      return row.responsible === "platform"
        ? "Opcional: confirma o número para todas as organizações."
        : "Nenhum link pedido ainda.";
  }
}

function StatusIcon({ status }: { status: Status }) {
  if (status === "confirmed") return <CheckCircle2 className="size-4 shrink-0 text-primary" />;
  if (status === "sent") return <MessageCircle className="size-4 shrink-0 text-primary" />;
  return <Clock className="size-4 shrink-0 text-muted-foreground" />;
}

/** Corrigir o número no portal: a rota de sempre (`PATCH /api/portal/me`), com o nome da sessão. */
function PortalPhoneFix({ name, onSaved }: { name: string; onSaved: () => Promise<void> }) {
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const valid = phoneSchema.safeParse(phone).success;

  async function save() {
    setSaving(true);
    try {
      await apiFetch("/api/portal/me", {
        method: "PATCH",
        body: JSON.stringify({ name, phone }),
      });
      toast.success("Número atualizado. Enviaremos o link para ele.");
      setPhone("");
      await onSaved();
    } catch (error) {
      toast.error(message(error, "Não foi possível salvar o número."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2 border-t border-border pt-4">
      <p className="text-sm font-medium">Número errado?</p>
      <PhoneField value={phone} onChange={setPhone} name="phone" />
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        disabled={!valid || saving}
        onClick={() => void save()}
      >
        {saving ? <Loader2 className="animate-spin" /> : null}
        Corrigir o número
      </Button>
    </div>
  );
}

export function PhoneVerificationPanel({
  area,
  onChanged,
  onSwitchTenant,
  portalName,
}: {
  area: Area;
  /** Releia a conta: o número pode ter sido confirmado. */
  onChanged: () => Promise<void>;
  /** Vai para a organização em que o número já vale (o portão é por organização ativa). */
  onSwitchTenant: (tenantId: string) => Promise<void>;
  /** Portal: o nome que acompanha a correção do número. */
  portalName?: string | null;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ["phone-verification", area],
    queryFn: () => apiFetch<Overview>(ENDPOINT[area]),
    retry: false,
  });

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ["phone-verification", area] });
    await onChanged();
  };

  async function resend(row: Responsible) {
    const key = `resend:${row.tenantId ?? "platform"}`;
    setBusy(key);
    try {
      const body =
        area === "team"
          ? { responsible: row.tenantId ?? "platform" }
          : { tenantId: row.tenantId ?? undefined };
      await apiFetch(`${ENDPOINT[area]}/resend`, { method: "POST", body: JSON.stringify(body) });
      toast.success("Pedido feito. Se houver um número da organização disponível, o link chega em instantes.");
      await queryClient.invalidateQueries({ queryKey: ["phone-verification", area] });
    } catch (error) {
      toast.error(message(error, "Não foi possível pedir o link."));
    } finally {
      setBusy(null);
    }
  }

  async function use(tenantId: string) {
    setBusy(`use:${tenantId}`);
    try {
      await onSwitchTenant(tenantId);
    } catch (error) {
      toast.error(message(error, "Não foi possível entrar nesta organização."));
    } finally {
      setBusy(null);
    }
  }

  if (overview.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (overview.error) {
    return (
      <div className="grid gap-2 text-sm">
        <p className="text-destructive">{message(overview.error, "Não foi possível ler a situação.")}</p>
        <Button type="button" variant="outline" className="w-fit" onClick={() => void overview.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const rows = overview.data.responsibles;
  const hint = overview.data.phoneHint ?? rows.find((row) => row.phoneHint)?.phoneHint ?? null;
  // "Abra o link" só faz sentido se algum link saiu; sem envio, o pedido espera a liberação.
  const linkSent = rows.some((row) => row.status === "sent");

  return (
    <div className="grid gap-4 text-sm">
      <p className="text-muted-foreground">
        {hint
          ? linkSent
            ? `Confirme que o WhatsApp terminado em ${hint} é seu: abra o link que enviamos para ele.`
            : `Falta confirmar o WhatsApp terminado em ${hint}.`
          : "Confirme seu número de WhatsApp para continuar."}
        {area === "team" && overview.data.answersTo === "organization"
          ? " A confirmação de uma organização vale só nela."
          : null}
      </p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">Nenhum pedido de confirmação aberto.</p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((row) => {
            const label =
              row.responsible === "platform"
                ? "Plataforma (vale em todas as organizações)"
                : (row.tenantName ?? "Organização");
            const resendKey = `resend:${row.tenantId ?? "platform"}`;

            return (
              <li
                key={row.tenantId ?? "platform"}
                className="grid gap-2 rounded-lg border border-border p-3"
              >
                <div className="flex items-start gap-2">
                  <StatusIcon status={row.status} />
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium break-words">{label}</span>
                    <span className="text-muted-foreground">{statusText(row)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {row.status === "confirmed" && row.tenantId && row.enterable !== false ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void use(row.tenantId as string)}
                    >
                      Usar esta organização
                    </Button>
                  ) : null}
                  {row.status !== "confirmed" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void resend(row)}
                    >
                      {busy === resendKey ? <Loader2 className="animate-spin" /> : <Send />}
                      {row.status === "none" ? "Pedir o link" : "Reenviar o link"}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {area === "portal" && portalName ? (
        <PortalPhoneFix name={portalName} onSaved={reload} />
      ) : null}
      {area === "team" ? (
        <p className="border-t border-border pt-4 text-muted-foreground">
          Número errado? A correção do telefone da conta é feita pela plataforma:{" "}
          <Link to="/contato" className={authLinkClassName}>
            fale conosco
          </Link>
          .
        </p>
      ) : null}

      <Button type="button" variant="secondary" className="w-fit" onClick={() => void reload()}>
        Já confirmei
      </Button>
    </div>
  );
}

/**
 * LGPD (T3-7): pedir a exclusão da própria conta não depende de confirmar o WhatsApp. Fica
 * recolhido; a exclusão já agendada aparece aberta, para a pessoa poder desistir.
 */
function GateDeletion({ statusUrl, children }: { statusUrl: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const status = useDeletionStatus(statusUrl);

  if (!open && !status.data?.account) {
    return (
      <Button
        type="button"
        variant="link"
        className="h-auto w-fit p-0 text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Excluir minha conta
      </Button>
    );
  }

  return <>{children}</>;
}

function GateShell({
  children,
  deletion,
  onSignOut,
}: {
  children: ReactNode;
  /** A exclusão da conta (LGPD), abaixo de "Sair". */
  deletion?: ReactNode;
  onSignOut: () => Promise<void>;
}) {
  return (
    <AuthShell title="Confirme seu WhatsApp" subtitle="Falta confirmar o seu número">
      <div className="grid gap-6">
        {children}
        <Button type="button" variant="ghost" className="w-fit" onClick={() => void onSignOut()}>
          Sair
        </Button>
        {deletion}
      </div>
    </AuthShell>
  );
}

/** A tela inteira de `/app`, `/admin` e `/app/onboarding` enquanto a API recusa pelo telefone. */
export function TeamPhoneGate() {
  const { reloadAccount, switchTenant, signOut, user } = useAuth();

  return (
    <GateShell
      onSignOut={signOut}
      // O suporte, na sessão personificada, não exclui nada em nome de ninguém.
      deletion={
        user?.impersonatedBy ? null : (
          <GateDeletion statusUrl="/api/me/deletion">
            <AccountDeletionCard
              statusUrl="/api/me/deletion"
              deleteUrl="/api/me"
              cancelUrl="/api/me/deletion/cancel"
              needsTotp={user?.twoFactorEnabled ?? false}
            />
          </GateDeletion>
        )
      }
    >
      <PhoneVerificationPanel
        area="team"
        onChanged={reloadAccount}
        onSwitchTenant={async (tenantId) => {
          await switchTenant(tenantId);
          await reloadAccount();
        }}
      />
    </GateShell>
  );
}

/** A tela inteira de `/portal/**` enquanto a API recusa pelo telefone da ficha. */
export function PortalPhoneGate() {
  const { refresh, switchTenant, signOut, sessionName } = usePortalAuth();
  // O link de confirmação da exclusão (conta sem senha) cai em `/portal/conta`, atrás desta tela.
  const [params, setParams] = useSearchParams();
  const deletionToken = params.get("confirmar-exclusao");

  return (
    <GateShell
      onSignOut={signOut}
      deletion={
        <>
          {deletionToken ? (
            <ConfirmDeletionCard
              token={deletionToken}
              onDone={() => {
                params.delete("confirmar-exclusao");
                setParams(params, { replace: true });
              }}
            />
          ) : null}
          <GateDeletion statusUrl="/api/portal/me/deletion">
            {/* Se a conta tem senha, quem diz é a rota de status (`needsPassword`). */}
            <AccountDeletionCard
              statusUrl="/api/portal/me/deletion"
              deleteUrl="/api/portal/me"
              cancelUrl="/api/portal/me/deletion/cancel"
              needsPassword={false}
            />
          </GateDeletion>
        </>
      }
    >
      <PhoneVerificationPanel
        area="portal"
        portalName={sessionName}
        onChanged={refresh}
        onSwitchTenant={async (tenantId) => {
          await switchTenant(tenantId);
          await refresh();
        }}
      />
    </GateShell>
  );
}

/** Aviso com `PHONE_VERIFICATION_REQUIRED=false`: a pessoa entra, e o painel abre daqui. */
function PendingBanner({
  area,
  onChanged,
  onSwitchTenant,
  portalName,
}: {
  area: Area;
  onChanged: () => Promise<void>;
  onSwitchTenant: (tenantId: string) => Promise<void>;
  portalName?: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
        <span>
          Seu WhatsApp ainda não foi confirmado. Sem a confirmação, as conversas desse número não
          aparecem ligadas ao seu cadastro.
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          Confirmar agora
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirme seu WhatsApp</DialogTitle>
            <DialogDescription>O link chega ao número cadastrado.</DialogDescription>
          </DialogHeader>
          {open ? (
            <PhoneVerificationPanel
              area={area}
              portalName={portalName}
              onChanged={onChanged}
              onSwitchTenant={async (tenantId) => {
                await onSwitchTenant(tenantId);
                await onChanged();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TeamPhonePendingBanner() {
  const { phonePending, reloadAccount, switchTenant } = useAuth();
  if (!phonePending) return null;

  return <PendingBanner area="team" onChanged={reloadAccount} onSwitchTenant={switchTenant} />;
}

export function PortalPhonePendingBanner() {
  const { phonePending, refresh, switchTenant, sessionName } = usePortalAuth();
  if (!phonePending) return null;

  return (
    <PendingBanner
      area="portal"
      portalName={sessionName}
      onChanged={refresh}
      onSwitchTenant={switchTenant}
    />
  );
}
