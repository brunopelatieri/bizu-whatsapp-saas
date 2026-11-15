CREATE TABLE "phone_tenant_vouch" (
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone_key" text NOT NULL,
	"vouched_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_tenant_vouch_user_id_tenant_id_pk" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "phone_tenant_vouch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "phone_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"phone_normalized" text NOT NULL,
	"phone_key" text NOT NULL,
	"status" text DEFAULT 'awaiting_manual' NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_verification_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "phone_verification_token_with_expiry" CHECK (("phone_verification"."token_hash" is null) = ("phone_verification"."expires_at" is null)),
	CONSTRAINT "phone_verification_status_known" CHECK ("phone_verification"."status" in ('sent', 'awaiting_manual', 'confirmed', 'canceled')),
	CONSTRAINT "phone_verification_subject_known" CHECK ("phone_verification"."subject_type" in ('user', 'customer')),
	CONSTRAINT "phone_verification_customer_has_tenant" CHECK ("phone_verification"."subject_type" <> 'customer' or "phone_verification"."tenant_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "phone_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "phone_tenant_vouch" ADD CONSTRAINT "phone_tenant_vouch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_tenant_vouch" ADD CONSTRAINT "phone_tenant_vouch_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_tenant_vouch" ADD CONSTRAINT "phone_tenant_vouch_vouched_by_user_id_fk" FOREIGN KEY ("vouched_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD CONSTRAINT "phone_verification_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_tenant_vouch_tenant_idx" ON "phone_tenant_vouch" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_verification_open_tenant_idx" ON "phone_verification" USING btree ("subject_type","subject_id","tenant_id") WHERE "phone_verification"."status" in ('sent', 'awaiting_manual') and "phone_verification"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_verification_open_platform_idx" ON "phone_verification" USING btree ("subject_type","subject_id") WHERE "phone_verification"."status" in ('sent', 'awaiting_manual') and "phone_verification"."tenant_id" is null;--> statement-breakpoint
CREATE INDEX "phone_verification_scope_status_idx" ON "phone_verification" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "phone_verification_updated_at_idx" ON "phone_verification" USING btree ("updated_at");--> statement-breakpoint
-- Fora do Drizzle Kit: a 0035 marcou `manual` as fichas de cliente que já existiam, para não
-- perderem o vínculo automático das conversas. A partir daqui, `manual` na ficha é o número que o
-- próprio cliente declarou e o owner liberou, e NÃO atrai conversa: as fichas antigas passam a
-- `team`, que é o que mantém o comportamento que tinham. Neste ponto nenhuma ficha `manual` veio
-- de liberação do owner (a liberação nasce com esta migration). `customer` tem FORCE ROW LEVEL
-- SECURITY: o bypass vale só para este comando e é desligado em seguida.
SELECT set_config('app.bypass_tenant', 'on', true);--> statement-breakpoint
UPDATE "customer" SET "phone_verified_via" = 'team' WHERE "phone_verified_via" = 'manual';--> statement-breakpoint
SELECT set_config('app.bypass_tenant', '', true);--> statement-breakpoint
-- Fora do Drizzle Kit: conta com forma de ficha de cliente (a T1 copiava o estado da ficha para a
-- conta do portal) volta a pendente antes do CHECK. A conta é global; `team` e `inbound` nunca
-- valeram fora da organização que os gravou.
UPDATE "user" SET "phone_verified_at" = NULL, "phone_verified_via" = NULL WHERE "phone_verified_via" IN ('team', 'inbound');--> statement-breakpoint
UPDATE "portal_user" SET "phone_verified_at" = NULL, "phone_verified_via" = NULL WHERE "phone_verified_via" IN ('team', 'inbound');--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_phone_via_global" CHECK (phone_verified_via IS NULL OR phone_verified_via IN ('whatsapp', 'manual'));--> statement-breakpoint
ALTER TABLE "portal_user" ADD CONSTRAINT "portal_user_phone_via_global" CHECK (phone_verified_via IS NULL OR phone_verified_via IN ('whatsapp', 'manual'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "phone_tenant_vouch" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "phone_verification" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint

-- O que o Drizzle Kit não gera. Sem FORCE, o dono da tabela (bizu_owner) ignoraria o RLS.
ALTER TABLE "phone_verification" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "phone_tenant_vouch" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- `ALTER DEFAULT PRIVILEGES` do init.sql já cobre o bizu_app. Explícito aqui para o
-- Postgres em que o papel foi criado à mão, sem esse trecho.
GRANT SELECT, INSERT, UPDATE, DELETE ON "phone_verification", "phone_tenant_vouch" TO bizu_app;
