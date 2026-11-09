import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneOldData } from "@/jobs/maintenance";
import { setStorageForTests } from "@/lib/storage";
import { createLocalProvider } from "@/lib/storage/providers/local";
import {
  asPlatform,
  restoreSettings,
  type SavedSettings,
  saveSettings,
} from "./billing-helpers";
import { connectOwner, createUser, DOMAIN, cleanUp } from "./tenant-helpers";
import { phoneRow } from "./phone-helpers";

/** Retenção do `maintenance.prune`, com datas controladas, uma tabela por vez. */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

let owner: postgres.Sql;
let saved: SavedSettings;
let storageDir: string;
let userId: string;
const tag = `prune-${randomUUID()}`;
const portalEmail = `${tag}@${DOMAIN}`;
let portalId: string;

const exists = async (table: string, column: string, value: string) => {
  const [row] = await asPlatform(
    owner,
    (tx) => tx<{ total: number }[]>`
      select count(*)::int as total from ${tx(table)} where ${tx(column)} = ${value}
    `,
  );
  return (row?.total ?? 0) > 0;
};

beforeAll(async () => {
  owner = connectOwner();
  saved = await saveSettings(owner);
  storageDir = await mkdtemp(path.join(os.tmpdir(), "bizu-prune-"));
  setStorageForTests(createLocalProvider(storageDir));

  userId = (await createUser(owner)).id;
  const ph = phoneRow();
  const [person] = await owner<{ id: string }[]>`
    insert into portal_user (name, email, email_verified, phone, phone_normalized, phone_key)
    values ('Prune', ${portalEmail}, true, ${ph.phone}, ${ph.phoneNormalized}, ${ph.phoneKey})
    returning id
  `;
  portalId = person?.id ?? "";
});

afterAll(async () => {
  setStorageForTests(undefined);
  await rm(storageDir, { recursive: true, force: true });
  await restoreSettings(owner, saved);
  await asPlatform(owner, async (tx) => {
    await tx`delete from payment_event where provider_event_id like ${`${tag}%`}`;
    await tx`delete from audit_log where action = ${tag}`;
    await tx`delete from data_export where subject_id in (${userId}, ${portalId})`;
  });
  await owner`delete from portal_user where id = ${portalId}`;
  await owner`delete from verification where identifier like ${`${tag}%`}`;
  await owner`delete from rate_limit_bucket where key like ${`${tag}%`}`;
  await cleanUp(owner);
  await owner.end();
});

describe("maintenance.prune", () => {
  it("payment_event: só o já tratado com mais de 90 dias; pendente e falho ficam", async () => {
    const insert = (name: string, status: string, days: number) =>
      asPlatform(
        owner,
        (tx) => tx`
          insert into payment_event (provider, provider_event_id, status, verified, received_at)
          values ('pagarme', ${`${tag}-${name}`}, ${status}, true, ${ago(days)})
        `,
      );

    await insert("processed-old", "processed", 100);
    await insert("ignored-old", "ignored", 100);
    await insert("duplicate-old", "duplicate", 100);
    await insert("processed-fresh", "processed", 10);
    await insert("pending-old", "pending", 100);
    await insert("failed-old", "failed", 100);

    const result = await pruneOldData();
    expect(result.paymentEvents).toBeGreaterThanOrEqual(3);

    const kept = async (name: string) => exists("payment_event", "provider_event_id", `${tag}-${name}`);
    expect(await kept("processed-old")).toBe(false);
    expect(await kept("ignored-old")).toBe(false);
    expect(await kept("duplicate-old")).toBe(false);
    expect(await kept("processed-fresh")).toBe(true);
    expect(await kept("pending-old")).toBe(true);
    expect(await kept("failed-old")).toBe(true);
  });

  it("email_message: mais de 180 dias", async () => {
    const [old] = await owner<{ id: string }[]>`
      insert into email_message (to_hash, template, created_at)
      values (${tag}, 'prune', ${ago(181)}) returning id
    `;
    const [fresh] = await owner<{ id: string }[]>`
      insert into email_message (to_hash, template, created_at)
      values (${tag}, 'prune', ${ago(179)}) returning id
    `;

    await pruneOldData();

    expect(await exists("email_message", "id", old?.id ?? "")).toBe(false);
    expect(await exists("email_message", "id", fresh?.id ?? "")).toBe(true);
    await owner`delete from email_message where to_hash = ${tag}`;
  });

  it("sessões vencidas das duas instâncias; as vigentes ficam", async () => {
    const insertSession = async (name: string, days: number) => {
      const [row] = await owner<{ id: string }[]>`
        insert into session (token, user_id, expires_at)
        values (${`${tag}-${name}`}, ${userId}, ${new Date(Date.now() + days * DAY)}) returning id
      `;
      return row?.id ?? "";
    };
    const insertPortal = async (name: string, days: number) => {
      const [row] = await owner<{ id: string }[]>`
        insert into portal_session (token, user_id, expires_at)
        values (${`${tag}-${name}`}, ${portalId}, ${new Date(Date.now() + days * DAY)}) returning id
      `;
      return row?.id ?? "";
    };

    const expired = await insertSession("expired", -1);
    const live = await insertSession("live", 3);
    const portalExpired = await insertPortal("expired", -1);
    const portalLive = await insertPortal("live", 3);

    await pruneOldData();

    expect(await exists("session", "id", expired)).toBe(false);
    expect(await exists("session", "id", live)).toBe(true);
    expect(await exists("portal_session", "id", portalExpired)).toBe(false);
    expect(await exists("portal_session", "id", portalLive)).toBe(true);
  });

  it("verification e portal_verification vencidos", async () => {
    const [old] = await owner<{ id: string }[]>`
      insert into verification (identifier, value, expires_at)
      values (${`${tag}-old`}, 'x', ${ago(1)}) returning id
    `;
    const [live] = await owner<{ id: string }[]>`
      insert into verification (identifier, value, expires_at)
      values (${`${tag}-live`}, 'x', ${new Date(Date.now() + DAY)}) returning id
    `;
    const [portalOld] = await owner<{ id: string }[]>`
      insert into portal_verification (identifier, value, expires_at)
      values (${`${tag}-old`}, 'x', ${ago(1)}) returning id
    `;

    await pruneOldData();

    expect(await exists("verification", "id", old?.id ?? "")).toBe(false);
    expect(await exists("verification", "id", live?.id ?? "")).toBe(true);
    expect(await exists("portal_verification", "id", portalOld?.id ?? "")).toBe(false);
    await owner`delete from portal_verification where identifier like ${`${tag}%`}`;
  });

  it("audit_log: respeita audit_retention_days (365 por padrão, ajustável)", async () => {
    const insert = async (name: string, days: number) => {
      const [row] = await asPlatform(
        owner,
        (tx) => tx<{ id: string }[]>`
          insert into audit_log (actor_type, action, target_id, created_at)
          values ('system', ${tag}, ${name}, ${ago(days)}) returning id
        `,
      );
      return row?.id ?? "";
    };

    const old = await insert("400", 400);
    const mid = await insert("150", 150);
    const fresh = await insert("10", 10);

    await pruneOldData();
    expect(await exists("audit_log", "id", old)).toBe(false);
    expect(await exists("audit_log", "id", mid)).toBe(true);
    expect(await exists("audit_log", "id", fresh)).toBe(true);

    await owner`
      insert into platform_setting (key, value) values ('audit_retention_days', '100'::jsonb)
      on conflict (key) do update set value = excluded.value
    `;
    await pruneOldData();
    expect(await exists("audit_log", "id", mid)).toBe(false);
    expect(await exists("audit_log", "id", fresh)).toBe(true);
  });

  it("exportações: arquivo e registro vencidos saem; pendente e vigente ficam", async () => {
    const put = async (name: string) => {
      const key = `exports/${tag}-${name}`;
      await mkdir(path.join(storageDir, "exports"), { recursive: true });
      await writeFile(path.join(storageDir, key), "zip");
      return key;
    };
    const expiredKey = await put("expired");
    const liveKey = await put("live");

    const insert = async (status: string, key: string | null, expiresInDays: number | null, createdDays: number) => {
      const [row] = await asPlatform(
        owner,
        (tx) => tx<{ id: string }[]>`
          insert into data_export (subject_type, subject_id, status, file_key, expires_at, created_at)
          values ('user', ${userId}, ${status}, ${key},
            ${expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY)},
            ${ago(createdDays)})
          returning id
        `,
      );
      return row?.id ?? "";
    };

    const expired = await insert("ready", expiredKey, -1, 8);
    const live = await insert("ready", liveKey, 3, 4);
    const oldFailed = await insert("failed", null, null, 9);
    const pending = await insert("pending", null, null, 0);

    const result = await pruneOldData();
    expect(result.exportFiles).toBeGreaterThanOrEqual(1);

    // O vencido perde o arquivo agora e o registro sete dias depois.
    const files = await readdir(path.join(storageDir, "exports"));
    expect(files).toContain(`${tag}-live`);
    expect(files).not.toContain(`${tag}-expired`);
    expect(await exists("data_export", "id", expired)).toBe(false);
    expect(await exists("data_export", "id", oldFailed)).toBe(false);
    expect(await exists("data_export", "id", live)).toBe(true);
    expect(await exists("data_export", "id", pending)).toBe(true);
  });

  it("buckets vencidos de rate limit", async () => {
    await owner`
      insert into rate_limit_bucket (key, window_start, count)
      values (${`${tag}-old`}, ${ago(2)}, 1), (${`${tag}-fresh`}, now(), 1)
    `;

    await pruneOldData();

    expect(await exists("rate_limit_bucket", "key", `${tag}-old`)).toBe(false);
    expect(await exists("rate_limit_bucket", "key", `${tag}-fresh`)).toBe(true);
  });

  it("é idempotente: a segunda rodada não apaga nada a mais", async () => {
    await pruneOldData();
    const again = await pruneOldData();

    expect(again).toMatchObject({
      emailMessages: 0,
      paymentEvents: 0,
      auditLogs: 0,
      sessions: 0,
      portalSessions: 0,
      verifications: 0,
      portalVerifications: 0,
      exportFiles: 0,
      exportRecords: 0,
    });
  });
});
