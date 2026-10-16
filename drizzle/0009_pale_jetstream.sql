CREATE TABLE "doc_comments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "doc_comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"github_repo_id" bigint NOT NULL,
	"path" text NOT NULL,
	"parent_id" bigint,
	"author_id" integer,
	"author_label" text NOT NULL,
	"as_org" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by_admin" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" integer,
	CONSTRAINT "doc_comments_reply_not_resolved" CHECK ("doc_comments"."parent_id" IS NULL OR "doc_comments"."resolved_at" IS NULL),
	CONSTRAINT "doc_comments_body_length" CHECK (char_length("doc_comments"."body") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_parent_id_doc_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."doc_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_comments_doc_created_idx" ON "doc_comments" USING btree ("github_repo_id","path","created_at");--> statement-breakpoint
CREATE INDEX "doc_comments_created_idx" ON "doc_comments" USING btree ("created_at" DESC NULLS LAST);