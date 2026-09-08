-- #205 (ADR-0022): Provider Health's per-Facet reading — one row per
-- (Provider, Facet), first grant, last refresh + error, and whether the
-- Provider's own API answered 403-not-enabled (cleared on the next
-- success). Nothing seeds this table; every row is written the first time
-- something happens to that (Provider, Facet) pair.
CREATE TABLE "provider_facet_health" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"facet" text NOT NULL,
	"first_granted_at" timestamp with time zone,
	"last_refresh_at" timestamp with time zone,
	"last_refresh_error" text,
	"api_not_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_facet_health_provider_facet_key" ON "provider_facet_health" USING btree ("provider","facet");