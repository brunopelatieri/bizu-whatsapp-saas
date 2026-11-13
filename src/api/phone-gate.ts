import type { Context } from "hono";
import { getEnv } from "@/lib/env";

/**
 * Portão de telefone (SPEC `pre-producao`, T3 e D-2). Com `PHONE_VERIFICATION_REQUIRED=true`,
 * `requireAuth` e `requirePortalAuth` respondem 403 `PHONE_UNVERIFIED` à sessão cujo telefone não
 * vale (`src/lib/phone/gate.ts`) em **tudo**, menos no que está nas listas abaixo.
 *
 * Falha fechada: rota nova fica bloqueada sem que ninguém lembre de marcá-la. A lista é do que
 * passa, explícita e mínima, e casa o método e o caminho **da requisição** (não o padrão da rota):
 * um caminho que não está aqui, ou que chega com barra a mais, fica de fora. Entrar aqui exige
 * motivo, e a rota precisa existir (`tests/db/phone-gate.test.ts` confere as duas coisas).
 *
 * O que passa: ler o próprio estado, reenviar o link, confirmar, trocar a organização em uso (o
 * portão é por organização: quem foi liberado em outra precisa conseguir ir para ela), aceitar o
 * convite (é o aceite que torna a organização responsável pelo telefone) e, no portal, corrigir o
 * número (`PATCH /api/portal/me`). Sair é do Better Auth (`/api/auth/sign-out`,
 * `/api/portal/auth/sign-out`), que não passa por estes middlewares, e, na personificação,
 * `POST /api/admin/stop-impersonating` (sem ele o suporte ficaria preso na sessão da conta).
 */

type Allowed = { method: string; path: RegExp; why: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const TEAM_PHONE_PENDING_ALLOWED: readonly Allowed[] = [
  { method: "GET", path: /^\/api\/me\/phone-verification$/, why: "ler o próprio estado" },
  { method: "POST", path: /^\/api\/me\/phone-verification\/resend$/, why: "reenviar o link" },
  { method: "POST", path: /^\/api\/me\/phone-verification\/confirm$/, why: "confirmar pelo link" },
  { method: "POST", path: /^\/api\/tenant\/active$/, why: "ir à organização que liberou o número" },
  {
    method: "POST",
    path: /^\/api\/admin\/stop-impersonating$/,
    why: "sair: o suporte que personifica uma conta pendente encerra por aqui",
  },
  {
    method: "POST",
    path: new RegExp(`^/api/invitations/${UUID}/accept$`, "i"),
    why: "aceitar o convite: a organização passa a responder pelo telefone",
  },
];

export const PORTAL_PHONE_PENDING_ALLOWED: readonly Allowed[] = [
  { method: "GET", path: /^\/api\/portal\/me\/phone-verification$/, why: "ler o próprio estado" },
  {
    method: "POST",
    path: /^\/api\/portal\/me\/phone-verification\/resend$/,
    why: "reenviar o link",
  },
  {
    method: "POST",
    path: /^\/api\/portal\/me\/phone-verification\/confirm$/,
    why: "confirmar pelo link",
  },
  { method: "PATCH", path: /^\/api\/portal\/me$/, why: "corrigir o número" },
  { method: "POST", path: /^\/api\/portal\/active-tenant$/, why: "ir à organização da ficha confirmada" },
];

function allowed(list: readonly Allowed[], c: Context) {
  const { method, path } = c.req;
  return list.some((entry) => entry.method === method && entry.path.test(path));
}

export const teamPhonePendingAllowed = (c: Context) => allowed(TEAM_PHONE_PENDING_ALLOWED, c);
export const portalPhonePendingAllowed = (c: Context) => allowed(PORTAL_PHONE_PENDING_ALLOWED, c);

/** `PHONE_VERIFICATION_REQUIRED`, lido a cada requisição (os testes trocam). */
export const phoneVerificationRequired = () => getEnv().PHONE_VERIFICATION_REQUIRED;

export const PHONE_UNVERIFIED = {
  error: "Confirme seu WhatsApp para continuar.",
  code: "PHONE_UNVERIFIED",
} as const;
