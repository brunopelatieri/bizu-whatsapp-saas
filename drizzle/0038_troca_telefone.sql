DROP INDEX "phone_verification_open_tenant_idx";--> statement-breakpoint
DROP INDEX "phone_verification_open_platform_idx";--> statement-breakpoint
ALTER TABLE "phone_verification" ADD COLUMN "purpose" text DEFAULT 'signup' NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD COLUMN "requested_by_type" text;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD COLUMN "requested_by_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_verification_open_change_idx" ON "phone_verification" USING btree ("subject_type","subject_id") WHERE "phone_verification"."status" in ('sent', 'awaiting_manual') and "phone_verification"."purpose" = 'change';--> statement-breakpoint
CREATE UNIQUE INDEX "phone_verification_open_tenant_idx" ON "phone_verification" USING btree ("subject_type","subject_id","tenant_id","purpose") WHERE "phone_verification"."status" in ('sent', 'awaiting_manual') and "phone_verification"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_verification_open_platform_idx" ON "phone_verification" USING btree ("subject_type","subject_id","purpose") WHERE "phone_verification"."status" in ('sent', 'awaiting_manual') and "phone_verification"."tenant_id" is null;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD CONSTRAINT "phone_verification_purpose_known" CHECK ("phone_verification"."purpose" in ('signup', 'change'));--> statement-breakpoint
ALTER TABLE "phone_verification" ADD CONSTRAINT "phone_verification_requester_known" CHECK ("phone_verification"."requested_by_type" is null or "phone_verification"."requested_by_type" in ('user', 'portal_user'));--> statement-breakpoint
ALTER TABLE "phone_verification" ADD CONSTRAINT "phone_verification_change_complete" CHECK ("phone_verification"."purpose" <> 'change' or ("phone_verification"."phone" is not null and "phone_verification"."requested_by_type" is not null));--> statement-breakpoint
ALTER TABLE "phone_verification" ADD CONSTRAINT "phone_verification_requester_pair" CHECK (("phone_verification"."requested_by_type" is null) = ("phone_verification"."requested_by_id" is null));