ALTER TABLE "chronicle_projects" ADD COLUMN "owner_uid" varchar(128);--> statement-breakpoint
ALTER TABLE "chronicle_projects" ADD COLUMN "public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chronicle_tasks" ADD COLUMN "public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "chronicle_projects_owner_idx" ON "chronicle_projects" USING btree ("owner_uid");