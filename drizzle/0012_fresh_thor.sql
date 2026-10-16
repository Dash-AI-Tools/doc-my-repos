CREATE TABLE "settings_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "settings_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fields" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "workspace_secrets_name" CHECK ("workspace_secrets"."name" in ('github_private_key', 'github_webhook_secret', 'anthropic_api_key', 'openai_api_key'))
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "workspace_settings_single_row" CHECK ("workspace_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "settings_audit" ADD CONSTRAINT "settings_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD CONSTRAINT "workspace_secrets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;