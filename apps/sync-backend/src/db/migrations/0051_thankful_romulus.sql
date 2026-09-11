CREATE TABLE "repairs" (
	"id" text PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
