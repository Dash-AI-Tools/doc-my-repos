CREATE TABLE "site_branding" (
	"id" smallint PRIMARY KEY NOT NULL,
	"org_name" text,
	"page_title" text,
	"primary_color" text,
	"accent_color" text,
	"colored_header" boolean DEFAULT false NOT NULL,
	"invert_logo_on_dark" boolean DEFAULT true NOT NULL,
	"logo" "bytea",
	"logo_type" text,
	"logo_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_branding_single_row" CHECK ("site_branding"."id" = 1)
);
