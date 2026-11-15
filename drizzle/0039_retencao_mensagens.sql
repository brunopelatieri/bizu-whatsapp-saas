CREATE TABLE "message_retention_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"channel_type" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_retention_state_result_object" CHECK (jsonb_typeof("message_retention_state"."last_result") = 'object')
);
--> statement-breakpoint
ALTER TABLE "message_retention_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retention_policy" (
	"tenant_id" uuid NOT NULL,
	"channel_type" text NOT NULL,
	"max_messages" integer,
	"retention_days" integer,
	"max_favorites" integer,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policy_tenant_id_channel_type_pk" PRIMARY KEY("tenant_id","channel_type"),
	CONSTRAINT "retention_policy_max_messages_nonneg" CHECK ("retention_policy"."max_messages" is null or "retention_policy"."max_messages" >= 0),
	CONSTRAINT "retention_policy_retention_days_nonneg" CHECK ("retention_policy"."retention_days" is null or "retention_policy"."retention_days" >= 0),
	CONSTRAINT "retention_policy_max_favorites_nonneg" CHECK ("retention_policy"."max_favorites" is null or "retention_policy"."max_favorites" >= 0)
);
--> statement-breakpoint
ALTER TABLE "retention_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "is_favorite" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "favorited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "favorited_by" uuid;--> statement-breakpoint
ALTER TABLE "message_retention_state" ADD CONSTRAINT "message_retention_state_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_retention_state_tenant_idx" ON "message_retention_state" USING btree ("tenant_id","channel_type") WHERE "message_retention_state"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_retention_state_platform_idx" ON "message_retention_state" USING btree ("channel_type") WHERE "message_retention_state"."tenant_id" is null;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_favorited_by_user_id_fk" FOREIGN KEY ("favorited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_favorite_idx" ON "message" USING btree ("conversation_id","created_at") WHERE "message"."is_favorite";--> statement-breakpoint
CREATE INDEX "message_favorited_by_idx" ON "message" USING btree ("favorited_by") WHERE "message"."favorited_by" is not null;--> statement-breakpoint
CREATE INDEX "message_tenant_created_idx" ON "message" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_favorite_stamp" CHECK ("message"."is_favorite" or ("message"."favorited_at" is null and "message"."favorited_by" is null));--> statement-breakpoint
CREATE POLICY "platform_only" ON "message_retention_state" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or current_setting('app.platform_scope', true) = 'on') WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or current_setting('app.platform_scope', true) = 'on');--> statement-breakpoint
CREATE POLICY "platform_only" ON "retention_policy" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or current_setting('app.platform_scope', true) = 'on') WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or current_setting('app.platform_scope', true) = 'on');--> statement-breakpoint

-- O que o Drizzle Kit não gera. Sem FORCE, o dono da tabela (bizu_owner) ignoraria o RLS.
ALTER TABLE "retention_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_retention_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- `ALTER DEFAULT PRIVILEGES` do init.sql já cobre o bizu_app. Explícito aqui para o
-- Postgres em que o papel foi criado à mão, sem esse trecho.
GRANT SELECT, INSERT, UPDATE, DELETE ON "retention_policy", "message_retention_state" TO bizu_app;
