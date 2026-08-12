CREATE TABLE "rescue_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"position_id" varchar(128) NOT NULL,
	"policy_mode" varchar(32) NOT NULL,
	"verified_amount" text NOT NULL,
	"destination" varchar(42) NOT NULL,
	"tx_hash" varchar(66) NOT NULL,
	"keeperhub_execution_id" varchar(128) NOT NULL,
	"status" varchar(32) DEFAULT 'PROTECTED' NOT NULL,
	"receipt_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"asset_address" varchar(42) NOT NULL,
	"destination" varchar(42) NOT NULL,
	"pre_balance" text NOT NULL,
	"post_balance" text NOT NULL,
	"delta" text NOT NULL,
	"expected_amount" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"block_number" text NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rescue_receipts_execution_uniq" ON "rescue_receipts" USING btree ("execution_id");