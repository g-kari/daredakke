CREATE TABLE `record_documents` (
	`owner_id` text NOT NULL,
	`scope` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `scope`)
);
