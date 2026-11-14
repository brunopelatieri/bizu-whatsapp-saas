import { describe, expect, it } from "vitest";
import { createGate, NESTED_SECTIONS_MAX, POOL_MAX } from "@/db/nested-section";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("createGate", () => {
  it("nunca roda mais do que o teto ao mesmo tempo e atende em ordem de chegada", async () => {
    const gated = createGate(2);
    let running = 0;
    let peak = 0;
    const started: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        gated(async () => {
          started.push(index);
          running += 1;
          peak = Math.max(peak, running);
          await tick();
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("devolve o resultado e solta a vaga quando a seção falha", async () => {
    const gated = createGate(1);

    await expect(gated(async () => Promise.reject(new Error("falhou")))).rejects.toThrow("falhou");
    await expect(gated(async () => "depois")).resolves.toBe("depois");
  });

  it("não deixa a vaga solta enquanto há fila", async () => {
    const gated = createGate(1);
    let running = 0;
    let peak = 0;
    const work = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
    };

    await Promise.all([gated(work), gated(work), gated(work)]);
    // Depois da fila vazia o teto volta inteiro.
    await Promise.all([gated(work), gated(work)]);

    expect(peak).toBe(1);
  });
});

describe("teto das seções que seguram uma conexão e pedem outra", () => {
  it("fica bem abaixo do pool: cada seção mais duas conexões de dentro cabem nele", () => {
    expect(NESTED_SECTIONS_MAX).toBeGreaterThanOrEqual(1);
    expect(NESTED_SECTIONS_MAX * 3).toBeLessThanOrEqual(POOL_MAX);
  });
});
