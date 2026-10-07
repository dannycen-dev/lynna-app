ALTER TABLE `prospects` ADD `privacy_notice_at` integer;--> statement-breakpoint
ALTER TABLE `prospects` ADD `consent_requested_at` integer;--> statement-breakpoint
ALTER TABLE `prospects` ADD `consent_denied_at` integer;--> statement-breakpoint
ALTER TABLE `prospects` ADD `consent_text` text;--> statement-breakpoint
ALTER TABLE `prospects` ADD `pending_financial` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `privacy_notice_url` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `privacy_notice_text` text;