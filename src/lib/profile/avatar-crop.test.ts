import { describe, expect, it } from "vitest";
import {
  AVATAR_PICK_MAX_BYTES,
  checkPickedFile,
  clampView,
  coverScale,
  MAX_ZOOM,
  sourceRect,
} from "@/lib/profile/avatar-crop";

describe("recorte da foto de perfil", () => {
  it("cobre o quadrado pelo lado menor", () => {
    expect(coverScale(400, 200, 256)).toBeCloseTo(1.28);
    expect(coverScale(100, 300, 256)).toBeCloseTo(2.56);
  });

  it("sem zoom nem deslocamento, recorta o centro da imagem", () => {
    const { sx, sy, side } = sourceRect({ zoom: 1, x: 0, y: 0 }, 400, 200, 256);

    expect(side).toBeCloseTo(200);
    expect(sx).toBeCloseTo(100);
    expect(sy).toBeCloseTo(0);
  });

  it("o zoom reduz o trecho da imagem que cabe no quadrado", () => {
    const { side } = sourceRect({ zoom: 2, x: 0, y: 0 }, 400, 200, 256);

    expect(side).toBeCloseTo(100);
  });

  it("não deixa o deslocamento descobrir uma borda vazia", () => {
    // Imagem 400x200: com zoom 1 só sobra folga na horizontal.
    const view = clampView({ zoom: 1, x: 9999, y: 9999 }, 400, 200, 256);

    expect(view.y).toBe(0);
    expect(view.x).toBeCloseTo((400 * 1.28 - 256) / 2);

    const { sx, sy, side } = sourceRect({ zoom: 1, x: -9999, y: 9999 }, 400, 200, 256);
    expect(sx + side).toBeCloseTo(400);
    expect(sy).toBeCloseTo(0);
  });

  it("limita o zoom ao intervalo", () => {
    expect(clampView({ zoom: 99, x: 0, y: 0 }, 300, 300, 256).zoom).toBe(MAX_ZOOM);
    expect(clampView({ zoom: 0.1, x: 0, y: 0 }, 300, 300, 256).zoom).toBe(1);
  });

  it("arrastar para a direita mostra o trecho da esquerda", () => {
    const centered = sourceRect({ zoom: 2, x: 0, y: 0 }, 400, 400, 256);
    const dragged = sourceRect({ zoom: 2, x: 50, y: 0 }, 400, 400, 256);

    expect(dragged.sx).toBeLessThan(centered.sx);
  });

  it("recusa tipo fora de PNG, JPEG e WebP e arquivo grande demais para abrir", () => {
    expect(checkPickedFile({ type: "image/png", size: 10 })).toBeNull();
    expect(checkPickedFile({ type: "image/jpeg", size: 10 })).toBeNull();
    expect(checkPickedFile({ type: "image/webp", size: 10 })).toBeNull();
    expect(checkPickedFile({ type: "image/svg+xml", size: 10 })).toBe("type");
    expect(checkPickedFile({ type: "image/gif", size: 10 })).toBe("type");
    expect(checkPickedFile({ type: "", size: 10 })).toBe("type");
    expect(checkPickedFile({ type: "image/png", size: AVATAR_PICK_MAX_BYTES + 1 })).toBe("size");
  });
});
