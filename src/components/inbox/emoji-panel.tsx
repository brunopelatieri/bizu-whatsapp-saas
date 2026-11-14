import { EmojiPicker, type EmojiPickerListComponents } from "frimousse";
import type { SkinTone } from "@/lib/emoji/preferences";
import { cn } from "@/lib/utils";

/**
 * O painel do seletor de emoji (X3): a busca, os recentes, a lista por categoria e o tom de pele.
 * Carregado com `React.lazy` na primeira abertura (`emoji-button.tsx`), então a biblioteca e a lógica da
 * lista não entram no pacote inicial do atendimento. Os dados vêm de `/emojibase` (mesma origem,
 * copiados por `scripts/sync-emojibase.mjs`): nenhuma requisição sai do servidor e a CSP segue com
 * `connect-src 'self'`.
 */

/** Onde ficam os dados (`public/emojibase/<idioma>/`). */
const EMOJIBASE_URL = "/emojibase";

const SKIN_TONE_LABELS: Record<SkinTone, string> = {
  none: "Padrão",
  light: "Claro",
  "medium-light": "Médio-claro",
  medium: "Médio",
  "medium-dark": "Médio-escuro",
  dark: "Escuro",
};

/** As peças da lista, definidas fora do componente: criá-las a cada renderização refaria a lista toda. */
const LIST_COMPONENTS = {
  CategoryHeader: ({ category, ...props }) => (
    <div className="bg-popover px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground" {...props}>
      {category.label}
    </div>
  ),
  Row: ({ children, ...props }) => (
    <div className="scroll-my-1" {...props}>
      {children}
    </div>
  ),
  Emoji: ({ emoji, ...props }) => (
    <button
      type="button"
      className="flex size-8 items-center justify-center rounded-md text-lg outline-none data-[active]:bg-accent"
      {...props}
    >
      {emoji.emoji}
    </button>
  ),
} satisfies Partial<EmojiPickerListComponents>;

/** Em toque (ponteiro grosso) a busca não toma o foco: o teclado virtual cobriria a lista. */
const focusSearch = () => typeof window === "undefined" || !window.matchMedia("(pointer: coarse)").matches;

type EmojiPanelProps = {
  /** O emoji escolhido. O painel não fecha: a pessoa pode inserir vários. */
  onPick: (emoji: string) => void;
  recents: readonly string[];
  skinTone: SkinTone;
  onSkinToneChange: (tone: SkinTone) => void;
};

export default function EmojiPanel({ onPick, recents, skinTone, onSkinToneChange }: EmojiPanelProps) {
  return (
    <EmojiPicker.Root
      locale="pt"
      emojibaseUrl={EMOJIBASE_URL}
      columns={8}
      skinTone={skinTone}
      onEmojiSelect={({ emoji }) => onPick(emoji)}
      className="isolate flex h-96 w-full flex-col"
    >
      <EmojiPicker.Search
        aria-label="Buscar emoji"
        autoFocus={focusSearch()}
        placeholder="Buscar emoji"
        className="mb-2 h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />

      {/* Altura fixa (legenda e duas fileiras de 8): a lista não se mexe quando o primeiro emoji vira recente. */}
      <fieldset className="mb-1 h-20 min-w-0 shrink-0 border-0 p-0">
        <legend className="px-1 text-xs font-medium text-muted-foreground">Recentes</legend>
        {recents.length > 0 ? (
          <div className="grid grid-cols-8">
            {recents.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Inserir ${emoji}`}
                onClick={() => onPick(emoji)}
                className="flex size-8 items-center justify-center rounded-md text-lg outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {emoji}
              </button>
            ))}
          </div>
        ) : (
          <p className="px-1 pt-1 text-xs text-muted-foreground">Os emojis que você usar aparecem aqui.</p>
        )}
      </fieldset>

      <EmojiPicker.Viewport className="relative min-h-0 flex-1 outline-none">
        <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Carregando emojis…
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Nenhum emoji encontrado.
        </EmojiPicker.Empty>
        <EmojiPicker.List className="select-none pb-1" components={LIST_COMPONENTS} />
      </EmojiPicker.Viewport>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
        <fieldset className="m-0 flex min-w-0 flex-1 items-center justify-between gap-2 border-0 p-0">
          <legend className="sr-only">Tom de pele</legend>
          <span className="text-xs text-muted-foreground" aria-hidden>
            Tom de pele
          </span>
          <div className="flex items-center gap-1">
          <EmojiPicker.SkinTone emoji="👋">
            {({ skinToneVariations }) =>
              skinToneVariations.map(({ skinTone: tone, emoji }) => (
                <button
                  key={tone}
                  type="button"
                  aria-label={SKIN_TONE_LABELS[tone]}
                  aria-pressed={tone === skinTone}
                  title={SKIN_TONE_LABELS[tone]}
                  onClick={() => onSkinToneChange(tone)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                    tone === skinTone && "bg-accent ring-1 ring-ring/40",
                  )}
                >
                  {emoji}
                </button>
              ))
            }
          </EmojiPicker.SkinTone>
          </div>
        </fieldset>
      </div>
    </EmojiPicker.Root>
  );
}
