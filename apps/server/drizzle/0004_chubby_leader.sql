CREATE TABLE `quiz` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course_id` integer NOT NULL,
	`class_id` integer,
	`code` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text NOT NULL,
	`chips_json` text NOT NULL,
	`questions_json` text NOT NULL,
	`job_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_id`) REFERENCES `class`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `generation_job`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_course_id_code_unique` ON `quiz` (`course_id`,`code`);--> statement-breakpoint
CREATE INDEX `quiz_class_id_idx` ON `quiz` (`class_id`);--> statement-breakpoint
CREATE TABLE `quiz_plan` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`class_id` integer NOT NULL,
	`plan_json` text NOT NULL,
	`draft_json` text,
	`log_json` text NOT NULL,
	`quiz_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `generation_job`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_id`) REFERENCES `class`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quiz_id`) REFERENCES `quiz`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_plan_job_id_unique` ON `quiz_plan` (`job_id`);--> statement-breakpoint
ALTER TABLE `generation_job` ADD `cycle` integer;