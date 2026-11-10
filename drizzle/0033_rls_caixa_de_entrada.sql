-- O que o Drizzle Kit não gera. Sem FORCE, o dono da tabela (bizu_owner) ignoraria o RLS.
-- `file` já tem FORCE desde a `0017`; a troca de política dela está na `0032`.
ALTER TABLE "chat_contact" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_contact_identity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- `conversation.channel_id` é imutável: trocar de número é outra conversa (SPEC da caixa de
-- entrada, "Modelo de dados"). O gatilho recusa qualquer UPDATE que mude o valor.
CREATE OR REPLACE FUNCTION conversation_channel_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN
    RAISE EXCEPTION 'conversation.channel_id é imutável' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER conversation_channel_immutable
  BEFORE UPDATE OF channel_id ON "conversation"
  FOR EACH ROW EXECUTE FUNCTION conversation_channel_immutable();--> statement-breakpoint

-- `ALTER DEFAULT PRIVILEGES` do init.sql já cobre o bizu_app. Explícito aqui para o
-- Postgres em que o papel foi criado à mão, sem esse trecho.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "chat_contact", "chat_contact_identity", "conversation", "message"
TO bizu_app;
