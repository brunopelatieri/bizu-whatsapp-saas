DO $$
DECLARE
  pending integer;
BEGIN
  -- O projeto é novo: não há cadastro anterior à regra do telefone obrigatório, então não há
  -- backfill. Se existir linha de pessoa (fora a anonimizada pela LGPD), os CHECK abaixo
  -- falhariam; abortamos antes, com mensagem clara e sem dado pessoal.
  SELECT
    (SELECT count(*) FROM "user" WHERE email NOT LIKE 'deleted+%@invalid')
    + (SELECT count(*) FROM portal_user WHERE email NOT LIKE 'deleted+%@invalid')
    + (SELECT count(*) FROM customer WHERE coalesce(email, '') NOT LIKE 'deleted+%@invalid')
  INTO pending;

  IF pending > 0 THEN
    RAISE EXCEPTION 'Migration 0024: % cadastro(s) sem telefone. O telefone passou a ser obrigatorio e nao ha backfill; em desenvolvimento, recrie o banco local e rode db:migrate e db:seed.', pending;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "customer" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "phone_normalized" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "phone_key" text;--> statement-breakpoint
ALTER TABLE "portal_user" ADD COLUMN "phone_normalized" text;--> statement-breakpoint
ALTER TABLE "portal_user" ADD COLUMN "phone_key" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "phone_normalized" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "phone_key" text;--> statement-breakpoint
CREATE INDEX "user_phone_key_idx" ON "user" USING btree ("phone_key");--> statement-breakpoint
CREATE INDEX "portal_user_phone_key_idx" ON "portal_user" USING btree ("phone_key");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_tenant_phone_key_idx" ON "customer" USING btree ("tenant_id","phone_key") WHERE "customer"."phone_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_phone_required" CHECK ((phone_normalized IS NOT NULL AND phone_key IS NOT NULL) OR coalesce(email, '') LIKE 'deleted+%@invalid');--> statement-breakpoint
ALTER TABLE "portal_user" ADD CONSTRAINT "portal_user_phone_required" CHECK ((phone_normalized IS NOT NULL AND phone_key IS NOT NULL) OR coalesce(email, '') LIKE 'deleted+%@invalid');--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_phone_required" CHECK ((phone_normalized IS NOT NULL AND phone_key IS NOT NULL) OR coalesce(email, '') LIKE 'deleted+%@invalid');