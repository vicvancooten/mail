CREATE TABLE "vapid_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
