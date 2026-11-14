/**
 * Seção que segura uma conexão do pool enquanto o código de dentro pede **outra**: a transação de
 * `withinLimit` para `members` (o `createInvitation` e o `acceptInvitation` do Better Auth gravam
 * pelo mesmo pool) e a de `createOrganizationWithinLimit` (o `createOrganization`).
 *
 * O pool é um só, de `POOL_MAX` conexões (`src/db/index.ts`), e o `postgres.js` não tem prazo para a
 * fila dele. Se todas as conexões ficarem presas em seções que esperam outra, nenhuma volta: o
 * processo inteiro para de falar com o banco até reiniciar. Por isso estas seções passam por
 * `nestedSection`, que limita quantas rodam ao mesmo tempo; as demais esperam **sem** segurar
 * conexão (a fila é de promessas, não do pool).
 *
 * **Por que `NESTED_SECTIONS_MAX` é seguro:** cada seção segura 1 conexão e o código de dentro usa
 * até 2 ao mesmo tempo (o Better Auth grava em sequência; 2 é folga). Com o teto em um terço do
 * pool, no pior caso as seções seguram 3 e pedem mais 6, no total 9 de 10: sempre sobra conexão
 * para quem está dentro terminar, e a seção termina e devolve a sua. O pedido comum (que segura
 * uma conexão só enquanto roda e não espera outra) nunca entra num ciclo, então só atrasa. Não
 * aumente o pool para resolver isto: o teto é que garante a vivacidade.
 *
 * Regra de uso: a seção **não aninha** outra `nestedSection` (duas seções esperando vaga uma da
 * outra travariam o teto), e só entra aqui quem realmente pede outra conexão lá dentro. Seção
 * que grava só pela própria transação (`withinLimit` para `customers`) não precisa.
 */

/** Conexões do pool de runtime (`getDb`). */
export const POOL_MAX = 10;

/** Quantas seções que seguram uma conexão e pedem outra rodam ao mesmo tempo no processo. */
export const NESTED_SECTIONS_MAX = Math.max(1, Math.floor(POOL_MAX / 3));

/** Semáforo em memória: no máximo `max` rodando, o resto na fila, em ordem de chegada. */
export function createGate(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];

  return async function gated<T>(run: () => Promise<T>): Promise<T> {
    if (running >= max) {
      // A vaga passa direto ao próximo da fila (`running` não muda), sem janela para furar a fila.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      running += 1;
    }

    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

export const nestedSection = createGate(NESTED_SECTIONS_MAX);
