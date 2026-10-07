CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`prospect_id` text NOT NULL,
	`user_id` text NOT NULL,
	`development_id` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`source` text NOT NULL,
	`notes` text,
	`cancel_reason` text,
	`seller_reminded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`development_id`) REFERENCES `developments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appointments_user_start_uq` ON `appointments` (`user_id`,`starts_at`) WHERE status = 'scheduled';--> statement-breakpoint
CREATE INDEX `appointments_tenant_start_idx` ON `appointments` (`tenant_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `appointments_prospect_idx` ON `appointments` (`prospect_id`);--> statement-breakpoint
CREATE TABLE `availability_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `availability_user_idx` ON `availability_rules` (`user_id`,`weekday`);--> statement-breakpoint
ALTER TABLE `tenants` ADD `timezone` text DEFAULT 'America/Mexico_City' NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `appointment_minutes` integer DEFAULT 60 NOT NULL;