CREATE TABLE `kb_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`development_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`keywords` text,
	`category` text DEFAULT 'general' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_by_user_id` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`development_id`) REFERENCES `developments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `kb_tenant_status_idx` ON `kb_articles` (`tenant_id`,`status`);--> statement-breakpoint
-- Índice de texto completo (FTS5) sobre la base de conocimiento. Sin acentos para que "construcción" y
-- "construccion" coincidan. Lo mantienen los triggers: nadie escribe en kb_fts directamente.
CREATE VIRTUAL TABLE `kb_fts` USING fts5(`title`, `keywords`, `body`, content='kb_articles', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER `kb_articles_ai` AFTER INSERT ON `kb_articles` BEGIN
  INSERT INTO kb_fts(rowid, title, keywords, body) VALUES (new.rowid, new.title, coalesce(new.keywords, ''), new.body);
END;--> statement-breakpoint
CREATE TRIGGER `kb_articles_ad` AFTER DELETE ON `kb_articles` BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, title, keywords, body) VALUES ('delete', old.rowid, old.title, coalesce(old.keywords, ''), old.body);
END;--> statement-breakpoint
CREATE TRIGGER `kb_articles_au` AFTER UPDATE ON `kb_articles` BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, title, keywords, body) VALUES ('delete', old.rowid, old.title, coalesce(old.keywords, ''), old.body);
  INSERT INTO kb_fts(rowid, title, keywords, body) VALUES (new.rowid, new.title, coalesce(new.keywords, ''), new.body);
END;
