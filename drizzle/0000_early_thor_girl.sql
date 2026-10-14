CREATE TYPE "public"."document_reserved" AS ENUM('index', 'log');--> statement-breakpoint
CREATE TYPE "public"."repo_sync_status" AS ENUM('pending', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."repo_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_trigger" AS ENUM('webhook', 'manual', 'schedule', 'startup');--> statement-breakpoint
CREATE TABLE "code_owners" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "code_owners_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" integer NOT NULL,
	"position" integer NOT NULL,
	"pattern" text NOT NULL,
	"owners" jsonb NOT NULL,
	"source_path" text NOT NULL,
	CONSTRAINT "code_owners_repo_id_position_unique" UNIQUE("repo_id","position")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" integer NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text,
	"headings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"reserved" "document_reserved",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_repo_id_path_unique" UNIQUE("repo_id","path")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"github_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_branch" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"visibility" "repo_visibility" NOT NULL,
	"html_url" text NOT NULL,
	"readme_path" text,
	"readme_markdown" text,
	"readme_sha" text,
	"codeowners_path" text,
	"codeowners_sha" text,
	"tree_sha" text,
	"docs_path" text,
	"is_okf" boolean DEFAULT false NOT NULL,
	"okf_version" text,
	"sync_status" "repo_sync_status" DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_owner_name_unique" UNIQUE("owner","name"),
	CONSTRAINT "repos_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"trigger" "sync_trigger" NOT NULL,
	"scope" text,
	"status" "sync_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"repos_total" integer DEFAULT 0 NOT NULL,
	"repos_synced" integer DEFAULT 0 NOT NULL,
	"repos_unchanged" integer DEFAULT 0 NOT NULL,
	"repos_failed" integer DEFAULT 0 NOT NULL,
	"docs_added" integer DEFAULT 0 NOT NULL,
	"docs_updated" integer DEFAULT 0 NOT NULL,
	"docs_removed" integer DEFAULT 0 NOT NULL,
	"docs_skipped" integer DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "code_owners" ADD CONSTRAINT "code_owners_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_started_at_idx" ON "sync_runs" USING btree ("started_at");