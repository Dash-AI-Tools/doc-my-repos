ALTER TABLE "repos" ADD COLUMN "selection_fingerprint" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "head_etag" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "commit_sha" text;