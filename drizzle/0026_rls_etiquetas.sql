-- O que o Drizzle Kit não gera. Sem FORCE, o dono da tabela (bizu_owner) ignoraria o RLS.
ALTER TABLE "tag" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_tag" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- `ALTER DEFAULT PRIVILEGES` do init.sql já cobre o bizu_app. Explícito aqui para o
-- Postgres em que o papel foi criado à mão, sem esse trecho.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tag", "customer_tag" TO bizu_app;
