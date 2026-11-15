import { Loader2 } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AVATAR_SIZE,
  type CropView,
  clampView,
  MAX_ZOOM,
  MIN_ZOOM,
  PICK_ERROR_MESSAGES,
  sourceRect,
} from "@/lib/profile/avatar-crop";

/**
 * Recorte quadrado de 256 px da foto de perfil, no navegador, antes do envio (SPEC `pre-producao`,
 * bloco F, F1-5). Arrastar (ou as setas) move a imagem; o controle de zoom a amplia. A prévia é o
 * mesmo quadrado que vai ao servidor; o círculo é só a máscara com que a foto aparece nas telas.
 */

/** WebP quando o navegador gera; senão PNG (o servidor aceita os dois). */
function renderBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (webp) => {
        if (webp && webp.type === "image/webp") return resolve(webp);
        canvas.toBlob((png) => resolve(png), "image/png");
      },
      "image/webp",
      0.92,
    );
  });
}

export function AvatarCropDialog({
  file,
  onCancel,
  onConfirm,
  pending,
  onUnreadable,
}: {
  /** A imagem escolhida; `null` fecha o diálogo. */
  file: File | null;
  onCancel: () => void;
  onConfirm: (cropped: Blob) => void;
  /** O envio em andamento: bloqueia os botões. */
  pending: boolean;
  onUnreadable: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [view, setView] = useState<CropView>({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [working, setWorking] = useState(false);

  // Abre a imagem escolhida. Falhou (arquivo corrompido, formato que o navegador não lê): avisa e fecha.
  useEffect(() => {
    if (!file) {
      setBitmap(null);
      return;
    }

    let cancelled = false;
    let opened: ImageBitmap | null = null;
    setView({ zoom: 1, x: 0, y: 0 });

    createImageBitmap(file)
      .then((image) => {
        if (cancelled) return image.close();
        opened = image;
        setBitmap(image);
      })
      .catch(() => {
        if (!cancelled) onUnreadable(PICK_ERROR_MESSAGES.unreadable);
      });

    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [file, onUnreadable]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !bitmap) return;

    const { sx, sy, side } = sourceRect(view, bitmap.width, bitmap.height, AVATAR_SIZE);
    context.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  }, [bitmap, view]);

  const move = (dx: number, dy: number) => {
    if (!bitmap) return;
    setView((current) =>
      clampView({ ...current, x: current.x + dx, y: current.y + dy }, bitmap.width, bitmap.height, AVATAR_SIZE),
    );
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // O quadrado aparece em AVATAR_SIZE pixels de CSS, como o `box` do recorte.
    move(event.clientX - drag.current.x, event.clientY - drag.current.y);
    drag.current = { x: event.clientX, y: event.clientY };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 8;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = moves[event.key];
    if (!delta) return;
    event.preventDefault();
    move(delta[0], delta[1]);
  };

  async function confirm() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setWorking(true);
    const blob = await renderBlob(canvas);
    setWorking(false);

    if (!blob) {
      onUnreadable(PICK_ERROR_MESSAGES.unreadable);
      return;
    }
    onConfirm(blob);
  }

  const busy = pending || working;

  return (
    <Dialog open={Boolean(file)} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustar a foto</DialogTitle>
          <DialogDescription>
            Arraste a imagem (ou use as setas) e ajuste o zoom. A foto é recortada em quadrado, de{" "}
            {AVATAR_SIZE} px, antes de ser enviada.
          </DialogDescription>
        </DialogHeader>

        <div className="grid justify-items-center gap-4">
          <div
            role="application"
            aria-label="Área de recorte da foto"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: área de arrastar do recorte; as setas movem a imagem
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={onKeyDown}
            className="relative touch-none cursor-grab overflow-hidden rounded-lg border border-border bg-muted active:cursor-grabbing"
            style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
          >
            <canvas
              ref={canvasRef}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              className="block"
              style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
            />
            {bitmap ? null : (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {/* Máscara circular: como a foto aparece nas telas. */}
            <div className="pointer-events-none absolute inset-0 rounded-full ring-[999px] ring-background/60" />
          </div>

          <label className="grid w-full max-w-xs gap-1 text-sm">
            <span className="font-medium">Zoom</span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={view.zoom}
              disabled={!bitmap}
              onChange={(event) => {
                if (!bitmap) return;
                const zoom = Number(event.target.value);
                setView((current) =>
                  clampView({ ...current, zoom }, bitmap.width, bitmap.height, AVATAR_SIZE),
                );
              }}
            />
          </label>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="button" disabled={!bitmap || busy} onClick={() => void confirm()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Usar esta foto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
