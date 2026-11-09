-- `audit_log` passa de `tenantPolicy()` a `scopedPolicy()`: o evento da plataforma (`tenant_id` nulo)
-- precisa gravar e ler dentro de `withPlatformData`, sem o bypass total.
DROP POLICY "tenant_isolation" ON "audit_log" CASCADE;--> statement-breakpoint
CREATE POLICY "scope_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO "bizu_app", "bizu_owner" USING (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on')) WITH CHECK (current_setting('app.bypass_tenant', true) = 'on' or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid or (tenant_id is null and current_setting('app.platform_scope', true) = 'on'));
