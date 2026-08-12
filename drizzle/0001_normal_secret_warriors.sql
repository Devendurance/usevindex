CREATE TABLE "signal_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" varchar(128) NOT NULL,
	"chain_id" integer NOT NULL,
	"protocol" varchar(32) NOT NULL,
	"source_family" varchar(32) NOT NULL,
	"metric" varchar(64) NOT NULL,
	"raw_value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"severity" varchar(16),
	"contract_address" varchar(42) NOT NULL,
	"block_number" text NOT NULL,
	"block_timestamp" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"rpc_source" varchar(256) NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "signal_observations_dedup_idx" ON "signal_observations" USING btree ("position_id","source_family","metric","contract_address","block_number");