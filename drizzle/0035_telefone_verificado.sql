ALTER TABLE "user" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "phone_verified_via" text;--> statement-breakpoint
ALTER TABLE "portal_user" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal_user" ADD COLUMN "phone_verified_via" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "phone_verified_via" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_tenant_user_idx" ON "customer" USING btree ("tenant_id","user_id") WHERE "customer"."user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_phone_verified_consistent" CHECK ((phone_verified_at IS NULL AND phone_verified_via IS NULL) OR (phone_verified_at IS NOT NULL AND phone_key IS NOT NULL AND phone_verified_via IS NOT NULL AND phone_verified_via IN ('whatsapp', 'manual', 'team', 'inbound')));--> statement-breakpoint
ALTER TABLE "portal_user" ADD CONSTRAINT "portal_user_phone_verified_consistent" CHECK ((phone_verified_at IS NULL AND phone_verified_via IS NULL) OR (phone_verified_at IS NOT NULL AND phone_key IS NOT NULL AND phone_verified_via IS NOT NULL AND phone_verified_via IN ('whatsapp', 'manual', 'team', 'inbound')));--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_phone_verified_consistent" CHECK ((phone_verified_at IS NULL AND phone_verified_via IS NULL) OR (phone_verified_at IS NOT NULL AND phone_key IS NOT NULL AND phone_verified_via IS NOT NULL AND phone_verified_via IN ('whatsapp', 'manual', 'team', 'inbound')));--> statement-breakpoint

-- O que o Drizzle Kit não gera: os cadastros anteriores à regra nascem confirmados (`manual`).
-- Sem isto, quem já existe perderia o vínculo automático das conversas e, com
-- PHONE_VERIFICATION_REQUIRED, ficaria trancado para fora, inclusive o proprietário da plataforma.
-- `customer` tem FORCE ROW LEVEL SECURITY: o próprio dono da tabela só enxerga as linhas com o
-- bypass, que vale até o fim desta transação.
SELECT set_config('app.bypass_tenant', 'on', true);--> statement-breakpoint
UPDATE "user" SET "phone_verified_at" = now(), "phone_verified_via" = 'manual' WHERE "phone_key" IS NOT NULL AND "phone_verified_at" IS NULL;--> statement-breakpoint
UPDATE "portal_user" SET "phone_verified_at" = now(), "phone_verified_via" = 'manual' WHERE "phone_key" IS NOT NULL AND "phone_verified_at" IS NULL;--> statement-breakpoint
UPDATE "customer" SET "phone_verified_at" = now(), "phone_verified_via" = 'manual' WHERE "phone_key" IS NOT NULL AND "phone_verified_at" IS NULL;--> statement-breakpoint
-- O migrator aplica as migrations pendentes numa transação só: o bypass não pode sobrar para a próxima.
SELECT set_config('app.bypass_tenant', '', true);
