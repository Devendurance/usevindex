ALTER TABLE "executions" ADD COLUMN "idempotency_key" varchar(160);--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "broadcast_request_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "last_keeperhub_status" varchar(32);--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "transaction_link" varchar(256);--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "sponsored" boolean;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "submission_error" varchar(512);--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "pre_position_amount" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "pre_safe_wallet_balance" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "pre_block_number" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "pre_block_timestamp" timestamp with time zone;