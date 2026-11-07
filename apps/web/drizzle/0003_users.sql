CREATE TABLE "users" (
	"uid" varchar(128) PRIMARY KEY NOT NULL,
	"email" varchar(320),
	"name" varchar(255),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
