CREATE TABLE usage (tenant_id text NOT NULL, count integer NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE INDEX usage_tenant ON usage (tenant_id);
