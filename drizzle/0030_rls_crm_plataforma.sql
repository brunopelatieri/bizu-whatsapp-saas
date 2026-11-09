-- O que o Drizzle Kit não gera. Sem FORCE, o dono da tabela (bizu_owner) ignoraria o RLS.
-- `platform_only` (sem `tenant_id`): só `withPlatformData` (ou o bypass de jobs e do seed) lê
-- e grava. `withTenant` e o `bizu_app` cru leem vazio.
ALTER TABLE "organization_tag" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_profile" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- `ALTER DEFAULT PRIVILEGES` do init.sql já cobre o bizu_app. Explícito aqui para o
-- Postgres em que o papel foi criado à mão, sem esse trecho.
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_tag", "organization_profile" TO bizu_app;
