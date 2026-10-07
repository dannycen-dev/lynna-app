ALTER TABLE `prospects` ADD `followup_step` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `prospects` ADD `followup_last_at` integer;--> statement-breakpoint
ALTER TABLE `prospects` ADD `followups_paused_at` integer;--> statement-breakpoint
ALTER TABLE `tenants` ADD `followups_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `followup_steps` text;