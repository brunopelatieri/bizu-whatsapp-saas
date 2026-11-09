CREATE TABLE "organization_profile" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_profile_object" CHECK (jsonb_typeof(custom_fields) = 'object')
);
--> statement-breakpoint
ALTER TABLE "organization_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_tag" (
	"organization_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_tag_organization_id_tag_id_pk" PRIMARY KEY("organization_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "organization_tag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_profile" ADD CONSTRAINT "organization_profile_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_profile" ADD CONSTRAINT "organization_profile_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_tag" ADD CONSTRAINT "organization_tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_tag" ADD CONSTRAINT "organization_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_tag_tag_idx" ON "organization_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE POLICY "platform_only" ON "organization_profile" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or current_setting('app.platform_scope', true) = 'on') WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or current_setting('app.platform_scope', true) = 'on');--> statement-breakpoint
CREATE POLICY "platform_only" ON "organization_tag" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or current_setting('app.platform_scope', true) = 'on') WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or current_setting('app.platform_scope', true) = 'on');