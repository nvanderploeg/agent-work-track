CREATE TABLE "events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"task_id" varchar(36),
	"path" varchar(512) COLLATE "C",
	"type" varchar(16) NOT NULL,
	"payload" json NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"path" varchar(512) COLLATE "C",
	"caption" varchar(300) NOT NULL,
	"review" boolean NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"task_id" varchar(36) NOT NULL,
	"path" varchar(512) COLLATE "C" NOT NULL,
	"parent_path" varchar(512) COLLATE "C",
	"key" varchar(64) NOT NULL,
	"depth" integer NOT NULL,
	"title" text NOT NULL,
	"state" varchar(32) NOT NULL,
	"note" text NOT NULL,
	"tags" json NOT NULL,
	"agent" json,
	"links" json,
	"position" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"state_since" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_task_id_path_pk" PRIMARY KEY("task_id","path")
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"task_id" varchar(36) NOT NULL,
	"path" varchar(512) COLLATE "C",
	"kind" varchar(16) NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"notes" text,
	"links" json,
	"write_key_hash" char(64) NOT NULL,
	"config" json NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_write_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"project_id" varchar(36) NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"state" varchar(32) NOT NULL,
	"note" text NOT NULL,
	"agent" json,
	"links" json,
	"prs" json,
	"repo" varchar(255),
	"branch" varchar(255),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"state_since" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_project_seq_idx" ON "events" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "events_task_path_seq_idx" ON "events" USING btree ("task_id","path","seq");--> statement-breakpoint
CREATE INDEX "images_task_created_idx" ON "images" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "notices_task_created_idx" ON "notices" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_project_created_idx" ON "tasks" USING btree ("project_id","created_at");