CREATE TABLE `images` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`path` varchar(512),
	`caption` varchar(300) NOT NULL,
	`review` boolean NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `images` ADD CONSTRAINT `images_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `images_task_created_idx` ON `images` (`task_id`,`created_at`);