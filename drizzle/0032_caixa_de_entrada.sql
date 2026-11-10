CREATE TABLE "chat_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"phone" text NOT NULL,
	"phone_key" text NOT NULL,
	"wa_name" text,
	"name" text,
	"customer_id" uuid,
	"user_id" uuid,
	"created_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_contact_single_link" CHECK ("chat_contact"."customer_id" is null or "chat_contact"."user_id" is null),
	CONSTRAINT "chat_contact_platform_no_customer" CHECK ("chat_contact"."tenant_id" is not null or "chat_contact"."customer_id" is null)
);
--> statement-breakpoint
ALTER TABLE "chat_contact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chat_contact_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_contact_identity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"channel_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"assigned_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"last_message_direction" text,
	"last_inbound_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_unread_nonnegative" CHECK ("conversation"."unread_count" >= 0),
	CONSTRAINT "conversation_preview_length" CHECK (char_length("conversation"."last_message_preview") <= 120),
	CONSTRAINT "conversation_platform_unassigned" CHECK ("conversation"."tenant_id" is not null or "conversation"."assigned_user_id" is null)
);
--> statement-breakpoint
ALTER TABLE "conversation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"sender_type" text NOT NULL,
	"sender_user_id" uuid,
	"type" text NOT NULL,
	"text" text,
	"file_id" uuid,
	"media_status" text,
	"provider_media_id" text,
	"provider_message_id" text,
	"client_id" text,
	"reply_to_message_id" uuid,
	"template_name" text,
	"payload" jsonb,
	"status" text,
	"error_code" text,
	"error_message" text,
	"provider_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "file" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_contact" ADD CONSTRAINT "chat_contact_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_contact" ADD CONSTRAINT "chat_contact_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_contact" ADD CONSTRAINT "chat_contact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_contact_identity" ADD CONSTRAINT "chat_contact_identity_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_contact_identity" ADD CONSTRAINT "chat_contact_identity_contact_id_chat_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."chat_contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_id_chat_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."chat_contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_sender_user_id_user_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_reply_to_message_id_message_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_contact_tenant_phone_key_idx" ON "chat_contact" USING btree ("tenant_id","phone_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_contact_platform_phone_key_idx" ON "chat_contact" USING btree ("phone_key") WHERE "chat_contact"."tenant_id" is null;--> statement-breakpoint
CREATE INDEX "chat_contact_customer_idx" ON "chat_contact" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "chat_contact_user_idx" ON "chat_contact" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_contact_identity_tenant_idx" ON "chat_contact_identity" USING btree ("tenant_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_contact_identity_platform_idx" ON "chat_contact_identity" USING btree ("kind","value") WHERE "chat_contact_identity"."tenant_id" is null;--> statement-breakpoint
CREATE INDEX "chat_contact_identity_contact_idx" ON "chat_contact_identity" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_tenant_contact_channel_idx" ON "conversation" USING btree ("tenant_id","contact_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_platform_contact_channel_idx" ON "conversation" USING btree ("contact_id","channel_id") WHERE "conversation"."tenant_id" is null;--> statement-breakpoint
CREATE INDEX "conversation_tenant_status_idx" ON "conversation" USING btree ("tenant_id","status","last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_queue_idx" ON "conversation" USING btree ("tenant_id","last_message_at" DESC NULLS LAST) WHERE "conversation"."assigned_user_id" is null and "conversation"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "conversation_assigned_idx" ON "conversation" USING btree ("tenant_id","assigned_user_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_channel_idx" ON "conversation" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "conversation_contact_idx" ON "conversation" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_channel_provider_id_idx" ON "message" USING btree ("channel_id","provider_message_id") WHERE "message"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_conversation_client_id_idx" ON "message" USING btree ("conversation_id","client_id") WHERE "message"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "message_conversation_created_idx" ON "message" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "message_queued_idx" ON "message" USING btree ("created_at") WHERE "message"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "message_file_idx" ON "message" USING btree ("file_id") WHERE "message"."file_id" is not null;--> statement-breakpoint
CREATE INDEX "message_reply_to_idx" ON "message" USING btree ("reply_to_message_id") WHERE "message"."reply_to_message_id" is not null;--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "file" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "chat_contact" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "chat_contact_identity" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "conversation" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "message" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));--> statement-breakpoint
-- `file` passa de `tenantPolicy()` a `scopedPolicy()` (mídia da plataforma, `tenant_id` nulo).
DROP POLICY "tenant_isolation" ON "file" CASCADE;
