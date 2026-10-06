CREATE TABLE `ai_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`input` text NOT NULL,
	`tool_calls` text NOT NULL,
	`draft` text,
	`reply` text NOT NULL,
	`blocked` text NOT NULL,
	`escalation` text,
	`fallback` integer DEFAULT false NOT NULL,
	`neurons` real DEFAULT 0 NOT NULL,
	`latency_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_audit_conversation_idx` ON `ai_audit_log` (`conversation_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `prospects` ADD `city` text;--> statement-breakpoint
ALTER TABLE `prospects` ADD `purpose` text;--> statement-breakpoint
ALTER TABLE `prospects` ADD `down_payment_cents` integer;--> statement-breakpoint
ALTER TABLE `prospects` ADD `timeframe` text;--> statement-breakpoint
ALTER TABLE `prospects` ADD `interest_development_id` text REFERENCES developments(id);--> statement-breakpoint
ALTER TABLE `prospects` ADD `handoff_at` integer;--> statement-breakpoint
ALTER TABLE `prospects` ADD `handoff_reason` text;--> statement-breakpoint
ALTER TABLE `prospects` ADD `source` text DEFAULT 'whatsapp' NOT NULL;