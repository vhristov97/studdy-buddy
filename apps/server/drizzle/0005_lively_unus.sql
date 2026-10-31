CREATE TABLE `submission` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quiz_id` integer NOT NULL,
	`answers_json` text NOT NULL,
	`auto_score` real NOT NULL,
	`auto_max` integer NOT NULL,
	`dont_know_json` text NOT NULL,
	`results_json` text NOT NULL,
	`open_pending` integer NOT NULL,
	`submitted_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`quiz_id`) REFERENCES `quiz`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `submission_quiz_id_idx` ON `submission` (`quiz_id`);