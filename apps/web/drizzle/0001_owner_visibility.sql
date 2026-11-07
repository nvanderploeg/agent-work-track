ALTER TABLE "projects" ADD COLUMN "owner_uid" varchar(128);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_uid");