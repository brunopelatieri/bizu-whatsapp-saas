import { SendHorizontal } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { useCan } from "@/components/auth/can";
import {
  type ConversationResponse,
  errorText,
  newClientId,
  type SendingMessage,
  useSendText,
} from "@/components/inbox/inbox-api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MESSAGE_TEXT_MAX } from "@/lib/schemas/inbox";
import { useAuth } from "@/providers/auth-provider";
import { Link } from "react-router";

/** Rascunhos por conversa, só em memória: trocar de conversa e voltar não perde o texto. */
const drafts = new Map<string, string>();

type ComposerProps = {
  conversationId: string;
  detail: ConversationResponse;
  onSendStart: (item: SendingMessage) => void;
  onSendEnd: (clientId: string) => void;
};

/**
 * Por que o campo está bloqueado, ou `null`. A tela só antecipa: o servidor confere a janela de
 * 24 h, o número conectado, a permissão e a personificação em todo envio.
 */
function useBlockReason(detail: ConversationResponse): ReactNode | null {
  const can = useCan();
  const { user, billing } = useAuth();

  if (user?.impersonatedBy) return "Sessão de suporte: você só pode ler as conversas.";
  if (!can("inbox", "reply")) return "Você não tem permissão para responder.";
  if (billing?.state === "read_only") {
    return (
      <>
        A organização está em modo somente leitura.{" "}
        <Link to="/app/assinatura" className="font-medium underline">
          Ver assinatura
        </Link>
      </>
    );
  }
  if (detail.conversation.channel.status !== "connected") {
    return (
      <>
        O número {detail.conversation.channel.name} está desconectado.{" "}
        {can("channel", "read") ? (
          <Link to="/app/configuracoes/canais" className="font-medium underline">
            Ver números
          </Link>
        ) : (
          "Peça a quem administra para reconectar."
        )}
      </>
    );
  }
  if (detail.window.applies && !detail.window.open) {
    return (
      <>
        <strong className="font-semibold">Janela de 24 horas encerrada.</strong> Neste número oficial só
        é possível responder em até 24 horas da última mensagem do contato. Depois disso, só um modelo
        de mensagem aprovado pode reabrir a conversa (ainda não disponível nesta tela).
      </>
    );
  }
  return null;
}

export function Composer({ conversationId, detail, onSendStart, onSendEnd }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(conversationId) ?? "");
  // Reaproveitado depois de um erro de rede: reenviar o mesmo texto não duplica no servidor.
  const clientId = useRef(newClientId());
  const send = useSendText(conversationId);
  const blocked = useBlockReason(detail);

  function change(value: string) {
    setText(value);
    if (value) drafts.set(conversationId, value);
    else drafts.delete(conversationId);
  }

  function submit() {
    const value = text.trim();
    if (!value || blocked || send.isPending) return;

    const id = clientId.current;
    change("");
    onSendStart({ clientId: id, text: value, createdAt: new Date().toISOString() });
    send.mutate(
      { text: value, clientId: id },
      {
        onSuccess: () => {
          clientId.current = newClientId();
        },
        onError: (error) => {
          // Devolve o texto para a pessoa corrigir ou tentar de novo.
          setText((current) => {
            const next = current || value;
            drafts.set(conversationId, next);
            return next;
          });
          toast.error(errorText(error));
        },
        onSettled: () => onSendEnd(id),
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <div className="border-t border-border bg-background p-3">
      {blocked ? (
        <p
          role="status"
          className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          {blocked}
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={Boolean(blocked)}
          maxLength={MESSAGE_TEXT_MAX}
          rows={1}
          aria-label="Mensagem"
          placeholder={blocked ? "Envio indisponível" : "Escreva uma mensagem (Enter envia, Shift+Enter quebra a linha)"}
          className="max-h-40 min-h-9 resize-none"
        />
        <Button
          type="button"
          size="icon"
          aria-label="Enviar mensagem"
          disabled={Boolean(blocked) || send.isPending || text.trim().length === 0}
          onClick={submit}
        >
          <SendHorizontal />
        </Button>
      </div>
      {text.length > MESSAGE_TEXT_MAX - 500 ? (
        <p className="mt-1 text-right text-xs text-muted-foreground">
          {text.length}/{MESSAGE_TEXT_MAX}
        </p>
      ) : null}
    </div>
  );
}
