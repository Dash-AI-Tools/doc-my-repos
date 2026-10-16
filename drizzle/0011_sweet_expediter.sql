CREATE TABLE "ask_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" text,
	"model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "ask_settings_single_row" CHECK ("ask_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ask_usage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ask_usage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"excerpt_count" integer DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT 'started' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ask_settings" ADD CONSTRAINT "ask_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_usage" ADD CONSTRAINT "ask_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_usage_user_created_idx" ON "ask_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ask_usage_created_idx" ON "ask_usage" USING btree ("created_at");