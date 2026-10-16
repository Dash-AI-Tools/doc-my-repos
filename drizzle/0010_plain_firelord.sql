CREATE TABLE "api_specs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_specs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" integer NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"format" text NOT NULL,
	"spec_version" text NOT NULL,
	"title" text NOT NULL,
	"api_version" text,
	"operation_count" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_specs_repo_id_path_unique" UNIQUE("repo_id","path"),
	CONSTRAINT "api_specs_format" CHECK ("api_specs"."format" IN ('openapi', 'swagger'))
);
--> statement-breakpoint
ALTER TABLE "api_specs" ADD CONSTRAINT "api_specs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;