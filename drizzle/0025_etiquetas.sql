CREATE TABLE "customer_tag" (
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tag_customer_id_tag_id_pk" PRIMARY KEY("customer_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "customer_tag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_name_length" CHECK (char_length("tag"."name") between 1 and 40),
	CONSTRAINT "tag_color_hex" CHECK ("tag"."color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "tag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag" ADD CONSTRAINT "customer_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_tag_tenant_tag_idx" ON "customer_tag" USING btree ("tenant_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_tenant_name_idx" ON "tag" USING btree ("tenant_id",lower("name")) WHERE "tag"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tag_platform_name_idx" ON "tag" USING btree (lower("name")) WHERE "tag"."tenant_id" is null;--> statement-breakpoint
ALTER TABLE "customer" DROP COLUMN "tags";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_tag" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "tag" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));