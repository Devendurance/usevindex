CREATE TABLE "demo_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" varchar(32) DEFAULT 'CREATED' NOT NULL,
	"position_id" varchar(128) NOT NULL,
	"funding_execution_id" varchar(128),
	"approval_execution_id" varchar(128),
	"supply_execution_id" varchar(128),
	"policy_id" uuid,
	"decision_id" uuid,
	"evacuation_execution_id" uuid,
	"rescue_receipt_id" uuid,
	"starting_block_number" text,
	"starting_block_timestamp" timestamp with time zone,
	"pre_demo_safe_wallet_balance" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_runs_active_uniq" ON "demo_runs" USING btree ("id") WHERE "demo_runs"."status" not in ('PROTECTED', 'FAILED');