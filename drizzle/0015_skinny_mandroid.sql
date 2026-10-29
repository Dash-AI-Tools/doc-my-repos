CREATE TABLE "public_access_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"search_enabled" boolean DEFAULT true NOT NULL,
	"ask_enabled" boolean DEFAULT false NOT NULL,
	"ask_questions_per_day" integer DEFAULT 200 NOT NULL,
	"ask_questions_per_ten_minutes" integer DEFAULT 20 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "public_access_settings_single_row" CHECK ("public_access_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "ask_usage" ADD COLUMN "anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_folders" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "public_access_settings" ADD CONSTRAINT "public_access_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;