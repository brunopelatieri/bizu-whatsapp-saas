import { Clock, Loader2, MessageCircle, Send } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  formatRequestedAt,
  type PhoneChange,
  phoneChangeErrorMessage,
  responsibleText,
} from "@/components/phone/phone-change-api";
import { Button } from "@/components/ui/button";
import { PhoneField } from "@/components/ui/phone-field";
import { phoneSchema, whatsappPhoneSchema } from "@/lib/schemas/phone";

/**
 * Pedir, acompanhar e cancelar a troca de telefone de um cadastro (SPEC `pre-producao`, "Troca de
 * telefone pelo pedido"). Um componente para os três usos:
 *
 * - `team`: a própria conta da equipe (`/app/perfil`, `/admin/perfil` e "Confirme seu WhatsApp");
 * - `portal`: o cliente em `/portal/conta`;
 * - `customer`: a equipe sobre a ficha de um cliente (`/app/clientes/:id`, TC-5).
 *
 * A tela não decide nada: quem confere número, permissão e responsável é a API. O texto diz o que
 * o servidor garante, e o número novo só aparece pelo final que a rota devolve.
 */

export type PhoneChangeAudience = "team" | "portal" | "customer";

const INTRO: Record<PhoneChangeAudience, string> = {
  team: "O número atual continua valendo até o novo ser confirmado. Enviamos um link ao WhatsApp novo: abra-o neste navegador, com esta conta. Se o link não puder ser enviado, quem responde pela conta libera o número à mão.",
  portal:
    "O número atual continua valendo até o novo ser confirmado. Enviamos um link ao WhatsApp novo: abra-o neste navegador, com esta conta.",
  customer:
    "A ficha segue com o número atual até o novo valer. Ele vale quando o cliente confirma o link no portal, logado, ou quando quem tem permissão para liberar telefones o libera na fila de clientes. Liberado assim, a ficha volta a receber as conversas do número novo.",
};

function statusText(change: PhoneChange, audience: PhoneChangeAudience) {
  const hint = change.phoneHint ? ` terminado em ${change.phoneHint}` : "";

  if (change.status === "sent") {
    return audience === "customer"
      ? `Link enviado ao WhatsApp${hint}. Falta o cliente confirmá-lo no portal.`
      : `Link enviado ao WhatsApp${hint}. Abra-o neste navegador, com esta conta.`;
  }

  return audience === "customer"
    ? `Sem envio de link para o WhatsApp${hint}: aguardando a liberação de quem administra a organização.`
    : `Sem envio automático para o WhatsApp${hint}: aguardando a liberação ${responsibleText(change)}.`;
}

export function PhoneChangeSection({
  audience,
  current,
  change,
  disabled = false,
  disabledReason,
  onRequest,
  onCancel,
  onResend,
  inUseNotice,
}: {
  audience: PhoneChangeAudience;
  /** O número atual, do jeito que a rota o devolve (ou só o final). */
  current: ReactNode;
  change: PhoneChange | null;
  /** Sem poder escrever (personificação, sem permissão): a tela mostra, mas não oferece. */
  disabled?: boolean;
  disabledReason?: string;
  /** Lança em caso de erro (a mensagem vai ao aviso); em sucesso, quem chama relê os dados. */
  onRequest: (phone: string) => Promise<void>;
  onCancel: () => Promise<void>;
  /** Sem a função, o botão "Reenviar o link" não aparece (a equipe pede de novo o mesmo número). */
  onResend?: () => Promise<void>;
  /** Mensagem própria do 409 `PHONE_IN_USE` (só a equipe, ao pedir pela ficha). */
  inUseNotice?: (error: unknown) => string | null;
}) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<"request" | "cancel" | "resend" | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  // A regra do número só aparece depois de sair do campo: durante a digitação ela é ruído.
  const [touched, setTouched] = useState(false);
  const schema = audience === "team" ? whatsappPhoneSchema : phoneSchema;
  const parsed = phone ? schema.safeParse(phone) : null;
  const valid = parsed?.success === true;
  const invalidMessage =
    touched && parsed && !parsed.success ? parsed.error.issues[0]?.message : null;

  async function run(kind: "request" | "cancel" | "resend", action: () => Promise<void>, ok: string) {
    setBusy(kind);
    setFieldError(null);
    try {
      await action();
      toast.success(ok);
      if (kind === "request") {
        setPhone("");
        setTouched(false);
      }
    } catch (error) {
      const own = kind === "request" ? (inUseNotice?.(error) ?? null) : null;
      const message = own ?? phoneChangeErrorMessage(error);
      if (kind === "request") setFieldError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 text-sm">
      <div className="grid gap-1">
        <p className="text-muted-foreground">
          Número atual: <span className="font-medium text-foreground">{current}</span>
        </p>
        <p className="text-muted-foreground">{INTRO[audience]}</p>
      </div>

      {change ? (
        <div
          className="grid gap-2 rounded-lg border border-border p-3"
          data-testid="phone-change-pending"
        >
          <div className="flex items-start gap-2">
            {change.status === "sent" ? (
              <MessageCircle className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            ) : (
              <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div className="grid min-w-0 gap-0.5">
              <span className="font-medium">Troca pendente</span>
              <span className="text-muted-foreground">{statusText(change, audience)}</span>
              <span className="text-xs text-muted-foreground">
                Pedida em {formatRequestedAt(change.requestedAt)}. O número atual segue valendo.
              </span>
            </div>
          </div>
          {!disabled ? (
            <div className="flex flex-wrap gap-2">
              {onResend ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      "resend",
                      onResend,
                      "Pedido feito. Se houver um número disponível para o envio, o link chega em instantes.",
                    )
                  }
                >
                  {busy === "resend" ? <Loader2 className="animate-spin" /> : <Send />}
                  Reenviar o link
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void run("cancel", onCancel, "Troca cancelada. O número atual segue valendo.")}
              >
                {busy === "cancel" ? <Loader2 className="animate-spin" /> : null}
                Cancelar a troca
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {disabled ? (
        disabledReason ? <p className="text-muted-foreground">{disabledReason}</p> : null
      ) : (
        <form
          className="grid max-w-sm gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            void run(
              "request",
              () => onRequest(phone),
              audience === "customer"
                ? "Troca pedida. A ficha segue com o número atual até o novo valer."
                : "Troca pedida. O número atual segue valendo até o novo ser confirmado.",
            );
          }}
        >
          <label className="font-medium" htmlFor={`phone-change-${audience}`}>
            {change ? "Trocar por outro número" : "Número novo"}
          </label>
          <PhoneField
            id={`phone-change-${audience}`}
            value={phone}
            onChange={(next) => {
              setPhone(next);
              setFieldError(null);
            }}
            onBlur={() => setTouched(true)}
            name="newPhone"
            invalid={Boolean(fieldError || invalidMessage)}
          />
          {fieldError || invalidMessage ? (
            <p className="text-xs text-destructive" role="alert">
              {fieldError ?? invalidMessage}
            </p>
          ) : null}
          <Button type="submit" className="w-fit" disabled={!valid || busy !== null}>
            {busy === "request" ? <Loader2 className="animate-spin" /> : null}
            {change ? "Substituir a troca" : "Pedir a troca"}
          </Button>
        </form>
      )}
    </div>
  );
}
