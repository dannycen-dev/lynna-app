ALTER TABLE `prospects` ADD `assigned_at` integer;--> statement-breakpoint
ALTER TABLE `prospects` ADD `reassign_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `assignment_mode` text DEFAULT 'round_robin' NOT NULL;--> statement-breakpoint
ALTER TABLE `tenants` ADD `reassign_after_minutes` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `receives_leads` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `last_assigned_at` integer;