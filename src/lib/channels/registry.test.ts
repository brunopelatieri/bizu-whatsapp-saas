import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNEL_CAPABILITIES, can, capabilitiesFor } from "@/lib/channels/capabilities";
import { ChannelNotConfiguredError } from "@/lib/channels/errors";
import { buildRegistry, type ChannelModule } from "@/lib/channels/registry";
import { type ChannelProvider, channelTypes } from "@/lib/channels/types";
import type { Env } from "@/lib/env";

const env = {} as Env;

const fakeModule = (id: ChannelModule["id"]): ChannelModule => ({
  id,
  createProvider: () => ({ type: id }) as ChannelProvider,
});

describe("buildRegistry", () => {
  it("sem CHANNEL_PROVIDERS, nenhum provedor e nenhum erro", () => {
    expect(buildRegistry([], [fakeModule("whatsapp_cloud")], env).size).toBe(0);
  });

  it("monta só os ids pedidos, mesmo com mais pastas", () => {
    const providers = buildRegistry(
      ["whatsapp_cloud"],
      [fakeModule("whatsapp_cloud"), fakeModule("whatsapp_qr")],
      env,
    );

    expect([...providers.keys()]).toEqual(["whatsapp_cloud"]);
  });

  it("id pedido sem pasta é erro de configuração", () => {
    expect(() => buildRegistry(["whatsapp_qr"], [fakeModule("whatsapp_cloud")], env)).toThrow(
      /whatsapp_qr/,
    );
  });

  it("id desconhecido é erro de configuração", () => {
    expect(() => buildRegistry(["inventado"], [], env)).toThrow(/inventado/);
  });
});

describe("ChannelNotConfiguredError", () => {
  it("nomeia o tipo e é um Error comum", () => {
    const error = new ChannelNotConfiguredError("whatsapp_qr");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("whatsapp_qr");
  });
});

describe("capacidades", () => {
  it("todo tipo de canal declara as suas (a matriz não deixa nascer um sem)", () => {
    expect(Object.keys(CHANNEL_CAPABILITIES).sort()).toEqual([...channelTypes].sort());
  });

  it("a Cloud tem modelos, janela de 24 h e falha de entrega; não tem eco nem pareamento", () => {
    expect(capabilitiesFor("whatsapp_cloud")).toEqual({
      templates: true,
      sessionWindow24h: true,
      deliveryFailure: true,
      deviceEcho: false,
      pairing: false,
    });
  });

  it("a Evolution tem eco do celular e pareamento; não tem modelos nem janela", () => {
    expect(capabilitiesFor("whatsapp_qr")).toEqual({
      templates: false,
      sessionWindow24h: false,
      deliveryFailure: false,
      deviceEcho: true,
      pairing: true,
    });
    expect(can("whatsapp_qr", "pairing")).toBe(true);
    expect(can("whatsapp_cloud", "pairing")).toBe(false);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);

    if (statSync(file).isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(name) ? [file] : [];
  });
}

/**
 * A garantia de "apagar a pasta remove o módulo": nada fora de `providers/<id>/` importa o
 * módulo. `npm run check:module-removal` prova o mesmo apagando de fato.
 */
describe("o núcleo não conhece provedor pelo nome", () => {
  const src = path.resolve(import.meta.dirname, "../..");
  const providersDir = path.join(src, "lib/channels/providers");
  const core = sourceFiles(src).filter(
    (file) => !file.startsWith(providersDir) && !/\.test\.tsx?$/.test(file),
  );
  const importsModule = /(from|import\()\s*["'][^"']*channels\/providers\/[^"']*["']/;

  it("há arquivos de núcleo para conferir", () => {
    expect(core.length).toBeGreaterThan(50);
  });

  it("ninguém fora de providers/<id>/ importa um módulo de canal", () => {
    const offenders = core.filter((file) => importsModule.test(readFileSync(file, "utf8")));

    expect(offenders.map((file) => path.relative(src, file))).toEqual([]);
  });

  it("os módulos de canal não importam um ao outro", () => {
    for (const id of ["whatsapp_cloud", "whatsapp_qr"]) {
      const other = id === "whatsapp_cloud" ? "whatsapp_qr" : "whatsapp_cloud";
      // Com a pasta apagada (`check:module-removal`), não há o que conferir.
      if (!existsSync(path.join(providersDir, id))) continue;
      const files = sourceFiles(path.join(providersDir, id));
      const offenders = files.filter((file) =>
        new RegExp(`providers/${other}`).test(readFileSync(file, "utf8")),
      );

      expect(offenders, `${id} importa ${other}`).toEqual([]);
    }
  });
});
