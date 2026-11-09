CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"identifier" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"status_detail" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"connected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_name_length" CHECK (char_length("channel"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "channel" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"channel_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"raw" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_evolution" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"remote_instance_id" text,
	"remote_instance_name" text NOT NULL,
	"instance_token_enc" text,
	"webhook_secret_enc" text,
	"webhook_secret_hash" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"connected_phone" text,
	"connected_jid" text,
	"advanced_settings" jsonb,
	"last_qr_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_evolution_remote_instance_name_unique" UNIQUE("remote_instance_name"),
	CONSTRAINT "channel_evolution_webhook_secret_hash_unique" UNIQUE("webhook_secret_hash")
);
--> statement-breakpoint
ALTER TABLE "channel_evolution" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_whatsapp_cloud" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"phone_number_id" text NOT NULL,
	"waba_id" text NOT NULL,
	"app_id" text,
	"access_token_enc" text,
	"app_secret_enc" text,
	"verify_token_enc" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"webhook_key" text NOT NULL,
	"webhook_verified_at" timestamp with time zone,
	"display_phone" text,
	"verified_name" text,
	"quality_rating" text,
	"registered_at" timestamp with time zone,
	"subscribed_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_whatsapp_cloud_phone_number_id_unique" UNIQUE("phone_number_id"),
	CONSTRAINT "channel_whatsapp_cloud_webhook_key_unique" UNIQUE("webhook_key")
);
--> statement-breakpoint
ALTER TABLE "channel_whatsapp_cloud" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"waba_id" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text,
	"status" text NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_template_id" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_event" ADD CONSTRAINT "channel_event_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_event" ADD CONSTRAINT "channel_event_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_evolution" ADD CONSTRAINT "channel_evolution_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_evolution" ADD CONSTRAINT "channel_evolution_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_whatsapp_cloud" ADD CONSTRAINT "channel_whatsapp_cloud_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_whatsapp_cloud" ADD CONSTRAINT "channel_whatsapp_cloud_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_tenant_type_idx" ON "channel" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_default_tenant_idx" ON "channel" USING btree ("tenant_id","type") WHERE "channel"."is_default" and "channel"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_default_platform_idx" ON "channel" USING btree ("type") WHERE "channel"."is_default" and "channel"."tenant_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_event_dedupe_idx" ON "channel_event" USING btree ("channel_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "channel_event_pending_idx" ON "channel_event" USING btree ("received_at") WHERE "channel_event"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "channel_event_status_idx" ON "channel_event" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "channel_event_received_idx" ON "channel_event" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "channel_evolution_tenant_idx" ON "channel_evolution" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "channel_whatsapp_cloud_tenant_idx" ON "channel_whatsapp_cloud" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "channel_whatsapp_cloud_waba_idx" ON "channel_whatsapp_cloud" USING btree ("waba_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_tenant_idx" ON "message_template" USING btree ("tenant_id","waba_id","name","language") WHERE "message_template"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_platform_idx" ON "message_template" USING btree ("waba_id","name","language") WHERE "message_template"."tenant_id" is null;--> statement-breakpoint
CREATE INDEX "message_template_waba_idx" ON "message_template" USING btree ("waba_id");--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "channel" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "channel_event" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "channel_evolution" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "channel_whatsapp_cloud" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "message_template" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));