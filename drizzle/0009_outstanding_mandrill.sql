CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"event_key" varchar(128) NOT NULL,
	"status" varchar(16) NOT NULL,
	"telegram_message_id" varchar(64),
	"error_code" varchar(64),
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_connect_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"position_id" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" varchar(128) NOT NULL,
	"chat_id" varchar(64) NOT NULL,
	"telegram_username" varchar(255),
	"risk_alerts_enabled" boolean DEFAULT true NOT NULL,
	"withdrawal_alerts_enabled" boolean DEFAULT true NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_dedup_uniq" ON "notification_deliveries" USING btree ("subscription_id","event_type","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_connect_tokens_hash_uniq" ON "telegram_connect_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_subscriptions_position_chat_uniq" ON "telegram_subscriptions" USING btree ("position_id","chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_subscriptions_active_uniq" ON "telegram_subscriptions" USING btree ("position_id") WHERE "telegram_subscriptions"."disconnected_at" is null;