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
 * convite (é o aceite que torna a organização responsável pelo telefone) e corrigir o número pela
 * troca (`POST`/`DELETE …/phone-change`, na equipe e no portal), que só grava o número novo quando
 * ele é confirmado. O `PATCH /api/portal/me` (nome e telefone) saiu da lista quando a troca ganhou
 * rota própria: com o telefone pendente, o portal só corrige o número. Sair é do Better Auth (`/api/auth/sign-out`,
 * `/api/portal/auth/sign-out`), que não passa por estes middlewares, e, na personificação,
 * `POST /api/admin/stop-impersonating` (sem ele o suporte ficaria preso na sessão da conta).
 *
 * LGPD (T3-7, decidido em 2026-11-13): **pedir a exclusão da própria conta** também passa, com as
 * rotas que mostram o pedido e deixam desistir. O direito de apagar os dados não depende de
 * confirmar o WhatsApp; a rota continua pedindo a senha (e o código do 2FA). A exportação e a
 * exclusão da organização seguem bloqueadas.
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
    path: /^\/api\/me\/phone-change$/,
    why: "corrigir o número: abre a troca, que só vale confirmada",
  },
  { method: "DELETE", path: /^\/api\/me\/phone-change$/, why: "desistir da troca de número" },
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
  { method: "DELETE", path: /^\/api\/me$/, why: "LGPD: pedir a exclusão da própria conta" },
  { method: "GET", path: /^\/api\/me\/deletion$/, why: "LGPD: ver a exclusão agendada" },
  { method: "POST", path: /^\/api\/me\/deletion\/cancel$/, why: "LGPD: desistir da exclusão" },
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
  {
    method: "POST",
    path: /^\/api\/portal\/me\/phone-change$/,
    why: "corrigir o número: abre a troca, que só vale confirmada",
  },
  {
    method: "DELETE",
    path: /^\/api\/portal\/me\/phone-change$/,
    why: "desistir da troca de número",
  },
  { method: "POST", path: /^\/api\/portal\/active-tenant$/, why: "ir à organização da ficha confirmada" },
  { method: "DELETE", path: /^\/api\/portal\/me$/, why: "LGPD: pedir a exclusão da própria conta" },
  {
    method: "POST",
    path: /^\/api\/portal\/me\/deletion\/confirm$/,
    why: "LGPD: confirmar a exclusão pelo link do e-mail (conta sem senha)",
  },
  { method: "GET", path: /^\/api\/portal\/me\/deletion$/, why: "LGPD: ver a exclusão agendada" },
  {
    method: "POST",
    path: /^\/api\/portal\/me\/deletion\/cancel$/,
    why: "LGPD: desistir da exclusão",
  },
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
