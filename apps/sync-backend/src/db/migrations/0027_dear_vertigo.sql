CREATE TABLE "provider_registrations" (
	"provider" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
