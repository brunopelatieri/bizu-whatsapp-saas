import { Smile } from "lucide-react";
import { lazy, type RefObject, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { loadSkinTone, type SkinTone, saveSkinTone } from "@/lib/emoji/preferences";
import { loadRecents, saveRecent } from "@/lib/emoji/recents";

/** O painel (e a biblioteca de emoji) só é baixado na primeira abertura. */
const EmojiPanel = lazy(() => import("@/components/inbox/emoji-panel"));

type EmojiButtonProps = {
  /** Mesma regra de bloqueio do campo de mensagem (janela fechada, envio em andamento, sem permissão). */
  disabled: boolean;
  /** Quem usa: os recentes e o tom de pele são por usuário. */
  userId: string | undefined;
  /** O campo de mensagem: o foco volta para ele ao fechar. */
  field: RefObject<HTMLTextAreaElement | null>;
  /** Insere o emoji no campo (posição do cursor, ou sobre a seleção). */
  onPick: (emoji: string) => void;
};

/**
 * Botão do seletor de emoji do composer (X3). O painel fica aberto para várias inserções; fecha com
 * Escape, clicando fora ou no botão, e o foco volta ao campo. Funciona nos dois escopos (tenant e
 * plataforma): não fala com a API, só escolhe o caractere.
 */
export function EmojiButton({ disabled, userId, field, onPick }: EmojiButtonProps) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState(() => loadRecents(userId));
  const [skinTone, setSkinTone] = useState<SkinTone>(() => loadSkinTone(userId));

  // O campo bloqueou com o painel aberto (envio começou, janela fechou): o painel fecha junto.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function pick(emoji: string) {
    setRecents(saveRecent(userId, emoji));
    onPick(emoji);
  }

  function changeSkinTone(tone: SkinTone) {
    setSkinTone(tone);
    saveSkinTone(userId, tone);
  }

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Inserir emoji"
            title="Inserir emoji"
            disabled={disabled}
          />
        }
      >
        <Smile />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} finalFocus={field} aria-label="Seletor de emoji">
        <Suspense
          fallback={
            <div className="flex h-96 items-center justify-center text-sm text-muted-foreground">
              Carregando emojis…
            </div>
          }
        >
          <EmojiPanel
            onPick={pick}
            recents={recents}
            skinTone={skinTone}
            onSkinToneChange={changeSkinTone}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
