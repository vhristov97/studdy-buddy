CREATE TABLE `material` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`class_id` integer NOT NULL,
	`kind` text NOT NULL,
	`original_name` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`extracted_text` text,
	`extraction_status` text NOT NULL,
	`extraction_error` text,
	`page_count` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`class_id`) REFERENCES `class`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `material_class_id_sha256_unique` ON `material` (`class_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `material_class_id_idx` ON `material` (`class_id`);--> statement-breakpoint
CREATE INDEX `material_sha256_idx` ON `material` (`sha256`);