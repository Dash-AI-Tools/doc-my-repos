CREATE TABLE "repo_folders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repo_folders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"description" text,
	"star_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "folder_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_folders_name_lower_unique" ON "repo_folders" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_folder_id_repo_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."repo_folders"("id") ON DELETE set null ON UPDATE no action;