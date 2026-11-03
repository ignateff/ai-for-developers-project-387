CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_type_id` text NOT NULL,
	`meeting_type_name` text NOT NULL,
	`meeting_type_description` text NOT NULL,
	`meeting_type_duration_minutes` integer NOT NULL,
	`guest_name` text NOT NULL,
	`guest_email` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	FOREIGN KEY (`meeting_type_id`) REFERENCES `meeting_types`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "booking_duration_positive" CHECK(typeof("bookings"."meeting_type_duration_minutes") = 'integer' and "bookings"."meeting_type_duration_minutes" between 1 and 2147483647),
	CONSTRAINT "booking_end_after_start" CHECK("bookings"."ends_at" > "bookings"."starts_at")
);
--> statement-breakpoint
CREATE INDEX `bookings_starts_at_idx` ON `bookings` (`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_idempotency_key_hash_idx` ON `bookings` (`idempotency_key_hash`);--> statement-breakpoint
CREATE TABLE `meeting_types` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT "meeting_type_duration_positive" CHECK(typeof("meeting_types"."duration_minutes") = 'integer' and "meeting_types"."duration_minutes" between 1 and 2147483647)
);
