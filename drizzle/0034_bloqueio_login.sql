CREATE TABLE "login_throttle" (
	"realm" text NOT NULL,
	"key_hash" text NOT NULL,
	"subject_hash" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_throttle_realm_key_hash_pk" PRIMARY KEY("realm","key_hash")
);
--> statement-breakpoint
CREATE INDEX "login_throttle_subject_idx" ON "login_throttle" USING btree ("realm","subject_hash");--> statement-breakpoint
CREATE INDEX "login_throttle_updated_at_idx" ON "login_throttle" USING btree ("updated_at");--> statement-breakpoint

-- O que o Drizzle Kit não gera. `ALTER DEFAULT PRIVILEGES` do init.sql já cobre o bizu_app;
-- explícito aqui para o Postgres em que o papel foi criado à mão. Sem `tenant_id` e sem RLS,
-- como `rate_limit_bucket`: o login acontece antes de existir tenant.
GRANT SELECT, INSERT, UPDATE, DELETE ON "login_throttle" TO bizu_app;
