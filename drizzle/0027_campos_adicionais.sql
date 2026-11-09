CREATE TABLE "custom_field" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_key_format" CHECK ("custom_field"."key" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "custom_field_label_length" CHECK (char_length("custom_field"."label") between 1 and 60),
	CONSTRAINT "custom_field_type_known" CHECK ("custom_field"."type" in ('text', 'number', 'date', 'boolean', 'select', 'multiselect')),
	CONSTRAINT "custom_field_options_array" CHECK (jsonb_typeof("custom_field"."options") = 'array'),
	CONSTRAINT "custom_field_entity_scope" CHECK (("custom_field"."entity" = 'organization' and "custom_field"."tenant_id" is null) or ("custom_field"."entity" = 'customer' and "custom_field"."tenant_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "custom_field" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_field_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_field_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_tenant_key_idx" ON "custom_field" USING btree ("tenant_id","entity","key") WHERE "custom_field"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_platform_key_idx" ON "custom_field" USING btree ("entity","key") WHERE "custom_field"."tenant_id" is null;--> statement-breakpoint
CREATE INDEX "custom_field_scope_idx" ON "custom_field" USING btree ("tenant_id","entity","position");--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_custom_fields_object" CHECK (jsonb_typeof("customer"."custom_fields") = 'object');--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "custom_field" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));