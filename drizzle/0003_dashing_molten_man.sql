CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"simulation_id" uuid,
	"status" varchar(32) NOT NULL,
	"chain_id" integer NOT NULL,
	"target" varchar(42) NOT NULL,
	"function" varchar(64) NOT NULL,
	"parameters_hash" varchar(64) NOT NULL,
	"requested_amount" text NOT NULL,
	"safe_wallet" varchar(42) NOT NULL,
	"keeperhub_execution_id" varchar(128),
	"tx_hash" varchar(66),
	"block_number" text,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"error_code" varchar(64),
	"error_details_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"target" varchar(42) NOT NULL,
	"function" varchar(64) NOT NULL,
	"parameters_json" text NOT NULL,
	"parameters_hash" varchar(64) NOT NULL,
	"block_number" text,
	"block_timestamp" timestamp with time zone,
	"success" boolean NOT NULL,
	"would_revert" boolean DEFAULT false NOT NULL,
	"gas_estimate" text,
	"simulated_return_value" text,
	"revert_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "executions_decision_uniq" ON "executions" USING btree ("decision_id");