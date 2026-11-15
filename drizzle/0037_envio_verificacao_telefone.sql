ALTER TABLE "channel_whatsapp_cloud" ADD COLUMN "verification_template_name" text;--> statement-breakpoint
ALTER TABLE "channel_whatsapp_cloud" ADD COLUMN "verification_template_language" text;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD COLUMN "attempts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD COLUMN "manual_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_verification" ADD CONSTRAINT "phone_verification_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_verification_message_idx" ON "phone_verification" USING btree ("channel_id","provider_message_id") WHERE "phone_verification"."provider_message_id" is not null;--> statement-breakpoint
ALTER TABLE "channel_whatsapp_cloud" ADD CONSTRAINT "channel_whatsapp_cloud_verification_template_pair" CHECK (("channel_whatsapp_cloud"."verification_template_name" is null) = ("channel_whatsapp_cloud"."verification_template_language" is null));--> statement-breakpoint

-- Fora do Drizzle Kit (SPEC `pre-producao`, T2b, restrição (e)): o canal que envia o link é
-- sempre do mesmo escopo do pedido. Pedido da plataforma enviado pelo canal de uma organização
-- daria ao owner dela o link de quem ele quisesse (o canal por QR Code é o WhatsApp dele). O
-- código confere em `src/lib/phone/delivery.ts`; o banco recusa também. `SECURITY INVOKER`: o
-- canal é lido sob o mesmo RLS de quem grava, e canal invisível também é recusado.
CREATE FUNCTION phone_verification_channel_same_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  channel_tenant uuid;
  found boolean;
BEGIN
  IF NEW.channel_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT tenant_id, true INTO channel_tenant, found FROM channel WHERE id = NEW.channel_id;
  IF found IS NOT TRUE OR channel_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'phone_verification: canal de outro escopo' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER phone_verification_channel_same_scope
  BEFORE INSERT OR UPDATE OF channel_id, tenant_id ON phone_verification
  FOR EACH ROW EXECUTE FUNCTION phone_verification_channel_same_scope();
