import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { validationError } from "@/api/guards";
import {
  createPairingChannel,
  getPairingStatus,
  requestPairingCode,
  requestPairingQr,
  runPairingAction,
  updatePairingSettings,
} from "@/lib/channels/pairing";
import type { ChannelRouteKit } from "@/lib/channels/registry";
import {
  createQrChannelSchema,
  pairChannelSchema,
  updateQrSettingsSchema,
} from "@/lib/schemas/channels";

/**
 * Rotas do canal por QR Code (criação, pareamento e ciclo de vida), montadas por
 * `buildChannelRoutes` para o tenant (`/api/channels`) e para a plataforma
 * (`/api/admin/channels`): a cadeia de guardas, o escopo e o ator vêm do `kit`, nunca do corpo.
 * Com o módulo fora de `CHANNEL_PROVIDERS`, o serviço responde 503 `PROVIDER_UNAVAILABLE`.
 * Nenhuma resposta traz token, segredo nem coluna `_enc`.
 */
export function qrRoutes(kit: ChannelRouteKit) {
  const routes = new Hono();
  const { base, canRead, canManage, validId } = kit;

  /** Limites da SPEC, por usuário: criar instância 10 por minuto, QR 15, consulta de estado 30. */
  const createLimit = kit.limit("channel-qr-create", 10);
  const qrLimit = kit.limit("channel-qr", 15);
  const statusLimit = kit.limit("channel-status", 30);
  const writeLimit = kit.limit("channel-pairing-write", 30);

  // `validId` já recusou o que não é uuid.
  const id = (c: Context) => c.req.param("id") ?? "";
  /** QR e código de pareamento dão acesso ao número: nunca em cache de navegador ou proxy. */
  const noStore = { "Cache-Control": "no-store" };

  routes.post(
    `${base}/whatsapp-qr`,
    canManage,
    createLimit,
    zValidator("json", createQrChannelSchema, validationError),
    async (c) =>
      c.json(
        {
          channel: await createPairingChannel(
            kit.scopeOf(c),
            "whatsapp_qr",
            c.req.valid("json").name,
            kit.actorOf(c),
          ),
        },
        201,
      ),
  );

  routes.post(`${base}/:id/qr`, canManage, qrLimit, validId, async (c) => {
    const qr = await requestPairingQr(kit.scopeOf(c), id(c));

    return c.json(
      qr.alreadyConnected
        ? { alreadyConnected: true }
        : { qrcode: qr.qrcode, code: qr.code, expiresInSeconds: qr.expiresInSeconds },
      200,
      noStore,
    );
  });

  routes.post(
    `${base}/:id/pair`,
    canManage,
    qrLimit,
    validId,
    zValidator("json", pairChannelSchema, validationError),
    async (c) => {
      const result = await requestPairingCode(kit.scopeOf(c), id(c), c.req.valid("json").phone);

      return c.json({ pairingCode: result.pairingCode }, 200, noStore);
    },
  );

  routes.get(`${base}/:id/status`, canRead, statusLimit, validId, async (c) =>
    c.json(await getPairingStatus(kit.scopeOf(c), id(c)), 200, noStore),
  );

  for (const action of ["disconnect", "logout", "reconnect"] as const) {
    routes.post(`${base}/:id/${action}`, canManage, writeLimit, validId, async (c) =>
      c.json({
        channel: await runPairingAction(kit.scopeOf(c), id(c), action, kit.actorOf(c)),
      }),
    );
  }

  /**
   * Ajustes avançados da instância. Rota própria (e não o `PATCH /:id` da SPEC) para não
   * disputar o handler de renomear com os campos da Cloud API; o contrato do corpo é o mesmo.
   */
  routes.patch(
    `${base}/:id/advanced-settings`,
    canManage,
    writeLimit,
    validId,
    zValidator("json", updateQrSettingsSchema, validationError),
    async (c) =>
      c.json({
        channel: await updatePairingSettings(
          kit.scopeOf(c),
          id(c),
          c.req.valid("json").advancedSettings,
          kit.actorOf(c),
        ),
      }),
  );

  return routes;
}
