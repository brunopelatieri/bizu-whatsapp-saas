/**
 * Recorte quadrado da foto de perfil, feito no navegador antes do envio (SPEC `pre-producao`,
 * bloco F, F1-5): o servidor só confere tipo e tamanho, não reprocessa a imagem. Código puro
 * (sem DOM) para o `avatar-crop.test.ts` cobrir; quem desenha no canvas é `avatar-crop-dialog.tsx`.
 */

/** Lado da foto enviada, em pixels. */
export const AVATAR_SIZE = 256;

/** Tipos que o servidor aceita (conferidos de novo pela assinatura do arquivo). */
export const AVATAR_ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/**
 * O arquivo escolhido é só lido pelo navegador para recortar; este teto evita abrir uma imagem
 * enorme na memória. Não é o limite do servidor (`AVATAR_MAX_KB`), que vale para a foto já recortada.
 */
export const AVATAR_PICK_MAX_BYTES = 20 * 1024 * 1024;

export type CropView = {
  /** 1 = a imagem cobre o quadrado sem sobrar; 4 = ampliada quatro vezes. */
  zoom: number;
  /** Deslocamento do centro da imagem em relação ao centro do quadrado, em pixels do quadrado. */
  x: number;
  y: number;
};

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Quanto a imagem é ampliada para cobrir o quadrado de `box` pixels (zoom 1). */
export function coverScale(width: number, height: number, box: number) {
  return box / Math.min(width, height);
}

/**
 * Mantém o deslocamento dentro do que a imagem ainda cobre o quadrado inteiro: nunca sobra
 * borda vazia. `box` é o lado do quadrado em que `view.x` e `view.y` são medidos.
 */
export function clampView(view: CropView, width: number, height: number, box: number): CropView {
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  const scale = coverScale(width, height, box) * zoom;
  const maxX = Math.max(0, (width * scale - box) / 2);
  const maxY = Math.max(0, (height * scale - box) / 2);

  return { zoom, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) };
}

/**
 * O trecho da imagem original que vira o quadrado: `sx`, `sy`, `side` em pixels da imagem. O
 * deslocamento positivo leva a imagem para a direita/baixo, então o trecho anda para o lado oposto.
 */
export function sourceRect(view: CropView, width: number, height: number, box: number) {
  const { zoom, x, y } = clampView(view, width, height, box);
  const scale = coverScale(width, height, box) * zoom;
  const side = box / scale;

  return {
    side,
    sx: width / 2 - side / 2 - x / scale,
    sy: height / 2 - side / 2 - y / scale,
  };
}

export type AvatarPickError = "type" | "size" | "unreadable";

/** Confere o arquivo escolhido antes de abri-lo. `null`: pode seguir para o recorte. */
export function checkPickedFile(file: { type: string; size: number }): AvatarPickError | null {
  if (!(AVATAR_ACCEPTED_TYPES as readonly string[]).includes(file.type)) return "type";
  if (file.size > AVATAR_PICK_MAX_BYTES) return "size";
  return null;
}

export const PICK_ERROR_MESSAGES: Record<AvatarPickError, string> = {
  type: "Use uma imagem PNG, JPEG ou WebP.",
  size: "A imagem é grande demais para abrir aqui. Escolha uma de até 20 MB.",
  unreadable: "Não foi possível abrir esta imagem. Escolha outra.",
};
