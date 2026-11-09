-- O que o Drizzle Kit não gera. Sem FORCE, o dono da tabela (bizu_owner) ignoraria o RLS.
ALTER TABLE "channel" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_whatsapp_cloud" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_evolution" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_template" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- `ALTER DEFAULT PRIVILEGES` do init.sql já cobre o bizu_app. Explícito aqui para o
-- Postgres em que o papel foi criado à mão, sem esse trecho.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "channel", "channel_whatsapp_cloud", "channel_evolution", "channel_event", "message_template"
TO bizu_app;
