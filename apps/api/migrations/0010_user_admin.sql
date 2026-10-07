ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `password_changed_at` integer;