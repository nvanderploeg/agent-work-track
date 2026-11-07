CREATE TABLE "api_tokens" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_uid" varchar(128) NOT NULL,
	"token_hash" char(64) NOT NULL,
	"label" varchar(100) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "device_codes" (
	"device_hash" char(64) PRIMARY KEY NOT NULL,
	"user_code" varchar(16) NOT NULL,
	"label" varchar(100) NOT NULL,
	"owner_uid" varchar(128),
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE INDEX "api_tokens_owner_idx" ON "api_tokens" USING btree ("owner_uid");