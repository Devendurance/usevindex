CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" varchar(128) NOT NULL,
	"decision_id" uuid,
	"event_type" varchar(64) NOT NULL,
	"details_json" text DEFAULT '{}' NOT NULL,
	"block_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protection_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" varchar(128) NOT NULL,
	"mode" varchar(32) NOT NULL,
	"required_signals" integer NOT NULL,
	"correlation_window_sec" integer NOT NULL,
	"thresholds_json" text NOT NULL,
	"safe_wallet_snapshot" varchar(42) NOT NULL,
	"is_armed" boolean DEFAULT false NOT NULL,
	"armed_at" timestamp with time zone,
	"disarmed_at" timestamp with time zone,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threat_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" varchar(128) NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"state" varchar(32) NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"contributing_signal_ids" text DEFAULT '[]' NOT NULL,
	"matched_families_json" text DEFAULT '[]' NOT NULL,
	"reason_json" text DEFAULT '{}' NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "protection_policies_armed_uniq" ON "protection_policies" USING btree ("position_id") WHERE "protection_policies"."is_armed" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "threat_decisions_active_uniq" ON "threat_decisions" USING btree ("policy_id") WHERE "threat_decisions"."state" in ('ELEVATED', 'CONFIRMING');