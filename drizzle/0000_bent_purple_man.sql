CREATE TABLE "protected_positions" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"protocol" varchar(32) NOT NULL,
	"pool_address" varchar(42) NOT NULL,
	"asset_address" varchar(42) NOT NULL,
	"asset_symbol" varchar(16) NOT NULL,
	"asset_decimals" integer NOT NULL,
	"position_token_address" varchar(42) NOT NULL,
	"execution_wallet" varchar(42) NOT NULL,
	"safe_wallet" varchar(42),
	"latest_position_amount" text NOT NULL,
	"latest_underlying_wallet_balance" text NOT NULL,
	"latest_native_balance_wei" text NOT NULL,
	"latest_allowance" text NOT NULL,
	"latest_block_number" text NOT NULL,
	"latest_block_timestamp" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vindex_config" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"safe_wallet" varchar(42),
	"configured_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
