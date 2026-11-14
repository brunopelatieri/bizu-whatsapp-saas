import { FileText, LayoutTemplate, Paperclip, SendHorizontal, X } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { EmojiButton } from "@/components/inbox/emoji-button";
import { formatFileSize } from "@/components/inbox/format";
import {
  type ConversationResponse,
  errorText,
  type MessageView,
  newClientId,
  type SendingMessage,
  type SendPayload,
  useSendMessage,
} from "@/components/inbox/inbox-api";
import { TemplateDialog } from "@/components/inbox/template-dialog";
import { useInboxCan, useInboxScope } from "@/components/inbox/inbox-scope";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { can as channelCan } from "@/lib/channels/capabilities";
import { insertAtCursor } from "@/lib/emoji/insert-at-cursor";
import { MAX_OUTBOUND_MEDIA_BYTES, OUTBOUND_MIME } from "@/lib/inbox/constants";
import { previewOf } from "@/lib/inbox/preview";
import { MEDIA_CAPTION_MAX, MESSAGE_TEXT_MAX } from "@/lib/schemas/inbox";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";

/**
 * Rascunhos por conversa, só em memória: trocar de conversa e voltar não perde o texto. A chave leva
 * o tenant e a pessoa, para que outra sessão no mesmo navegador nunca veja o texto alheio. O anexo
 * não entra: arquivo selecionado não volta depois de trocar de conversa.
 */
const drafts = new Map<string, string>();

/** O que o seletor de arquivos oferece; o servidor confere o tipo pelo conteúdo de qualquer forma. */
const ACCEPT = Object.keys(OUTBOUND_MIME).join(",");

type ComposerProps = {
  conversationId: string;
  detail: ConversationResponse;
  onSendStart: (item: SendingMessage) => void;
  onSendEnd: (clientId: string) => void;
  /** A mensagem que a próxima será resposta (citação), ou `null`. */
  replyTo: MessageView | null;
  onClearReply: () => void;
};

type Block = {
  /** Por que o campo está bloqueado, ou `null`. */
  reason: ReactNode | null;
  /** Só a janela de 24 h: o texto e o anexo ficam fechados, mas o modelo é permitido. */
  windowClosed: boolean;
};

/**
 * Por que o campo está bloqueado. A tela só antecipa: o servidor confere a janela de 24 h, o número
 * conectado, a permissão e a personificação em todo envio.
 */
function useBlock(detail: ConversationResponse): Block {
  const can = useInboxCan();
  const inbox = useInboxScope();
  const { user, billing } = useAuth();
  const hard = (reason: ReactNode): Block => ({ reason, windowClosed: false });

  if (user?.impersonatedBy) return hard("Sessão de suporte: você só pode ler as conversas.");
  if (!can("inbox", "reply")) return hard("Você não tem permissão para responder.");
  if (inbox.mode === "tenant" && billing?.state === "read_only") {
    return hard(
      <>
        A organização está em modo somente leitura.{" "}
        <Link to="/app/assinatura" className="font-medium underline">
          Ver assinatura
        </Link>
      </>,
    );
  }
  if (detail.conversation.channel.status !== "connected") {
    return hard(
      <>
        O número {detail.conversation.channel.name} está desconectado.{" "}
        {can("channel", "read") ? (
          <Link to={inbox.channelsRoute} className="font-medium underline">
            Ver números
          </Link>
        ) : (
          "Peça a quem administra para reconectar."
        )}
      </>,
    );
  }
  if (detail.window.applies && !detail.window.open) {
    return { reason: null, windowClosed: true };
  }
  return { reason: null, windowClosed: false };
}

export function Composer({
  conversationId,
  detail,
  onSendStart,
  onSendEnd,
  replyTo,
  onClearReply,
}: ComposerProps) {
  const { user } = useAuth();
  const { key: scopeKey } = useInboxScope();
  const draftKey = `${scopeKey}:${user?.id}:${conversationId}`;
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // O campo de mensagem: o seletor de emoji lê o cursor dele e o foco volta para ele ao fechar.
  const field = useRef<HTMLTextAreaElement>(null);
  // Onde o cursor fica depois de inserir um emoji (aplicado depois da renderização, `useLayoutEffect`).
  const pendingCursor = useRef<number | null>(null);
  const fieldTouched = useRef(false);
  // O texto de agora, para o callback de erro (a closure do envio guarda o de antes de limpar o campo).
  const latest = useRef(text);
  // Do envio que falhou: reenviar o MESMO conteúdo reaproveita o id e não duplica no servidor;
  // conteúdo diferente leva id novo (o servidor devolveria a mensagem antiga para o mesmo id).
  const failed = useRef<{ key: string; clientId: string } | null>(null);
  const send = useSendMessage(conversationId);
  const block = useBlock(detail);
  const blocked = Boolean(block.reason) || block.windowClosed;
  const channelType = detail.conversation.channel.type;
  const supportsTemplates = channelCan(channelType, "templates");
  const canSendTemplate = supportsTemplates && !block.reason;
  const audioAttached = Boolean(attachment?.type.startsWith("audio/"));

  // Prévia local só de imagem; a URL é revogada ao trocar o arquivo e ao sair.
  useEffect(() => {
    if (!attachment?.type.startsWith("image/")) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(attachment);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  function change(value: string) {
    latest.current = value;
    setText(value);
    if (value) drafts.set(draftKey, value);
    else drafts.delete(draftKey);
  }

  /**
   * Emoji do seletor (X3): entra na posição do cursor ou sobre a seleção do campo, mesmo com o foco no
   * painel (o `<textarea>` guarda a seleção ao perder o foco). Passa pelo mesmo `change` do digitado,
   * então o contador, o rascunho e o envio veem o texto de sempre. Além do teto do campo, não insere.
   */
  function insertEmoji(emoji: string) {
    const element = field.current;
    // Campo que nunca teve foco (rascunho recuperado, por exemplo) não tem cursor de verdade: vai ao fim.
    const selection = fieldTouched.current
      ? { start: element?.selectionStart, end: element?.selectionEnd }
      : undefined;
    const next = insertAtCursor(latest.current, emoji, selection, limit);
    if (!next) {
      toast.error("A mensagem chegou ao limite de caracteres.");
      return;
    }
    pendingCursor.current = next.cursor;
    change(next.value);
  }

  // Devolve o cursor ao ponto depois do emoji: o campo controlado o levaria ao fim ao trocar o valor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: o texto é o gatilho
  useLayoutEffect(() => {
    const cursor = pendingCursor.current;
    if (cursor === null) return;
    pendingCursor.current = null;
    field.current?.setSelectionRange(cursor, cursor);
  }, [text]);

  function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_OUTBOUND_MEDIA_BYTES) {
      toast.error(`Arquivo grande demais (${formatFileSize(file.size)}). O máximo é 16 MB.`);
      return;
    }
    if (file.size === 0) {
      toast.error("O arquivo está vazio.");
      return;
    }
    setAttachment(file);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = event.clipboardData.files[0];
    if (!file || blocked) return;
    event.preventDefault();
    pick(file);
  }

  /** Um envio por vez: o resultado chega, a bolha "enviando" sai e a releitura traz a mensagem. */
  function run(
    item: SendingMessage,
    payload: SendPayload,
    restore: () => void,
  ) {
    onSendStart(item);
    send.mutate(
      { ...payload, clientId: item.clientId },
      {
        onSuccess: () => {
          if ("replyTo" in payload && payload.replyTo) onClearReply();
        },
        onError: (error) => {
          restore();
          toast.error(errorText(error));
        },
        onSettled: () => {
          if (item.attachment?.previewUrl) URL.revokeObjectURL(item.attachment.previewUrl);
          onSendEnd(item.clientId);
        },
      },
    );
  }

  function submit() {
    if (blocked || send.isPending) return;
    const value = text.trim();
    const quoted = replyTo?.id;

    if (attachment) {
      const file = attachment;
      const caption = audioAttached ? "" : value;
      const key = `m:${file.name}:${file.size}:${caption}`;
      const clientId = failed.current?.key === key ? failed.current.clientId : newClientId();
      failed.current = null;

      setAttachment(null);
      change("");
      run(
        {
          clientId,
          text: caption,
          createdAt: new Date().toISOString(),
          attachment: {
            name: file.name,
            previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
          },
        },
        { kind: "media", file, caption: caption || undefined, replyTo: quoted },
        () => {
          // Devolve o arquivo e a legenda para a pessoa corrigir ou tentar de novo.
          failed.current = { key, clientId };
          setAttachment((current) => current ?? file);
          if (latest.current.trim() === "" && caption) change(caption);
        },
      );
      return;
    }

    if (!value) return;
    const key = `t:${value}`;
    const clientId = failed.current?.key === key ? failed.current.clientId : newClientId();
    failed.current = null;
    change("");
    run(
      { clientId, text: value, createdAt: new Date().toISOString() },
      { kind: "text", text: value, replyTo: quoted },
      () => {
        failed.current = { key, clientId };
        if (latest.current.trim() === "") change(value);
      },
    );
  }

  /** Modelo: a caixa de diálogo espera o resultado (e mostra o erro nela mesma). */
  async function submitTemplate(input: { templateId: string; variables: string[]; name: string; rendered: string }) {
    const key = `tpl:${input.templateId}:${input.variables.join("\u0000")}`;
    const clientId = failed.current?.key === key ? failed.current.clientId : newClientId();
    failed.current = null;

    onSendStart({
      clientId,
      text: input.rendered,
      createdAt: new Date().toISOString(),
      template: { name: input.name },
    });
    try {
      await send.mutateAsync({
        kind: "template",
        templateId: input.templateId,
        variables: input.variables,
        clientId,
      });
    } catch (error) {
      failed.current = { key, clientId };
      throw error;
    } finally {
      onSendEnd(clientId);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  const quoteWho = replyTo?.direction === "out" ? "a você" : "ao contato";
  const limit = attachment ? MEDIA_CAPTION_MAX : MESSAGE_TEXT_MAX;
  // O texto digitado antes de anexar pode passar da legenda (1024): o servidor recusaria; a tela avisa antes.
  const overLimit = text.length > limit;

  return (
    <div className="border-t border-border bg-background p-3">
      {block.reason ? (
        <p
          role="status"
          className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          {block.reason}
        </p>
      ) : null}

      {block.windowClosed ? (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          <p className="min-w-0 flex-1">
            <strong className="font-semibold">Janela de 24 horas encerrada.</strong> Neste número oficial só
            é possível responder em até 24 horas da última mensagem do contato. Depois disso, só um modelo
            de mensagem aprovado reabre a conversa.
          </p>
          {canSendTemplate ? (
            <Button type="button" size="sm" onClick={() => setTemplateOpen(true)}>
              <LayoutTemplate />
              Enviar modelo
            </Button>
          ) : null}
        </div>
      ) : null}

      {replyTo ? (
        <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-primary/60 bg-muted px-3 py-1.5 text-xs">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">Respondendo {quoteWho}</p>
            <p className="truncate text-muted-foreground">{previewOf(replyTo.type, replyTo.text)}</p>
          </div>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Cancelar resposta"
            onClick={onClearReply}
          >
            <X />
          </Button>
        </div>
      ) : null}

      {attachment ? (
        <div className="mb-2 flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-2">
          {preview ? (
            <img src={preview} alt="Prévia do anexo" className="size-12 shrink-0 rounded-md object-cover" />
          ) : (
            <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-background">
              <FileText className="size-5 text-muted-foreground" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1 text-xs">
            <p className="truncate text-sm font-medium">{attachment.name}</p>
            <p className="text-muted-foreground">
              {formatFileSize(attachment.size)}
              {audioAttached ? " · Áudio não aceita legenda" : ""}
            </p>
          </div>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Remover anexo"
            onClick={() => setAttachment(null)}
          >
            <X />
          </Button>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            pick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Anexar arquivo"
          disabled={blocked || send.isPending}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip />
        </Button>
        {canSendTemplate && !block.windowClosed ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Enviar modelo de mensagem"
            title="Enviar modelo de mensagem"
            disabled={send.isPending}
            onClick={() => setTemplateOpen(true)}
          >
            <LayoutTemplate />
          </Button>
        ) : null}
        <EmojiButton
          key={user?.id}
          disabled={blocked || send.isPending || audioAttached}
          userId={user?.id}
          field={field}
          onPick={insertEmoji}
        />
        <Textarea
          ref={field}
          onFocus={() => {
            fieldTouched.current = true;
          }}
          value={text}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={blocked || audioAttached}
          maxLength={limit}
          rows={1}
          aria-label={attachment ? "Legenda" : "Mensagem"}
          placeholder={
            blocked
              ? "Envio indisponível"
              : attachment
                ? "Legenda (opcional)"
                : "Escreva uma mensagem (Enter envia, Shift+Enter quebra a linha)"
          }
          className="max-h-40 min-h-9 resize-none"
        />
        <Button
          type="button"
          size="icon"
          aria-label="Enviar mensagem"
          disabled={blocked || send.isPending || overLimit || (!attachment && text.trim().length === 0)}
          onClick={submit}
        >
          <SendHorizontal />
        </Button>
      </div>
      {text.length > limit - 500 ? (
        <p className={cn("mt-1 text-right text-xs", overLimit ? "text-destructive" : "text-muted-foreground")}>
          {overLimit ? "Legenda muito longa: " : ""}
          {text.length}/{limit}
        </p>
      ) : null}

      {supportsTemplates ? (
        <TemplateDialog
          open={templateOpen}
          onClose={() => setTemplateOpen(false)}
          conversationId={conversationId}
          onSubmit={submitTemplate}
        />
      ) : null}
    </div>
  );
}
