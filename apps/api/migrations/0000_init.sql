CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`actor` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`data` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`tenant_id`,`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`prospect_id` text NOT NULL,
	`wa_account_id` text NOT NULL,
	`ai_paused` integer DEFAULT false NOT NULL,
	`last_inbound_at` integer,
	`last_outbound_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`wa_account_id`) REFERENCES `wa_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_prospect_account_uq` ON `conversations` (`prospect_id`,`wa_account_id`);--> statement-breakpoint
CREATE TABLE `developments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`address` text,
	`city` text,
	`state` text,
	`lat` real,
	`lng` real,
	`amenities` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `developments_tenant_slug_uq` ON `developments` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE TABLE `lot_media` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`development_id` text NOT NULL,
	`lot_id` text,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`mime` text NOT NULL,
	`caption` text,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`development_id`) REFERENCES `developments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `lots` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`development_id` text NOT NULL,
	`block` text NOT NULL,
	`number` text NOT NULL,
	`area_m2` real NOT NULL,
	`front_m` real,
	`depth_m` real,
	`price_per_m2_cents` integer NOT NULL,
	`total_price_cents` integer NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`reserved_until` integer,
	`features` text,
	`geojson` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`development_id`) REFERENCES `developments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lots_dev_block_number_uq` ON `lots` (`development_id`,`block`,`number`);--> statement-breakpoint
CREATE INDEX `lots_tenant_status_idx` ON `lots` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`wamid` text NOT NULL,
	`direction` text NOT NULL,
	`author` text NOT NULL,
	`type` text NOT NULL,
	`body` text,
	`media_id` text,
	`media_mime` text,
	`status` text NOT NULL,
	`status_rank` integer NOT NULL,
	`error` text,
	`wa_timestamp` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_wamid_unique` ON `messages` (`wamid`);--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `payment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`development_id` text,
	`name` text NOT NULL,
	`reservation_cents` integer DEFAULT 0 NOT NULL,
	`down_payment_bp` integer DEFAULT 0 NOT NULL,
	`months` integer DEFAULT 0 NOT NULL,
	`annual_interest_bp` integer DEFAULT 0 NOT NULL,
	`on_delivery_bp` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`development_id`) REFERENCES `developments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prospects` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`phone` text NOT NULL,
	`name` text,
	`profile_name` text,
	`email` text,
	`stage` text DEFAULT 'new' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`budget_cents` integer,
	`assigned_user_id` text,
	`consent_at` integer,
	`opted_out_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prospects_tenant_phone_uq` ON `prospects` (`tenant_id`,`phone`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `wa_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`phone_number_id` text NOT NULL,
	`waba_id` text,
	`display_phone` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wa_accounts_phone_number_id_unique` ON `wa_accounts` (`phone_number_id`);