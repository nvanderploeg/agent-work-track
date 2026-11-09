ALTER TABLE "chronicle_device_codes" ADD COLUMN "requester_ip" varchar(64);--> statement-breakpoint
ALTER TABLE "chronicle_device_codes" ADD COLUMN "requester_agent" varchar(255);--> statement-breakpoint
ALTER TABLE "chronicle_device_codes" ADD COLUMN "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL;