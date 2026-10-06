ALTER TABLE `payment_plans` ADD `calculation_type` text DEFAULT 'with_interest' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `list_price_type` text DEFAULT 'list_price' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `discount_type` text DEFAULT 'percentage' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `discount_bp` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `discount_fixed_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `opening_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `down_payment_type` text DEFAULT 'percentage' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `down_payment_fixed_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `down_payment_installments` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `monthly_type` text DEFAULT 'percentage' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `monthly_bp` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `monthly_fixed_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `on_delivery_type` text DEFAULT 'percentage' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `on_delivery_fixed_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `on_delivery_installments` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `rounding_absorber` text;--> statement-breakpoint
ALTER TABLE `payment_plans` ADD `delivery_date` text;