CREATE INDEX `events_tenant_time` ON `events` (`tenant`,`created_at`);--> statement-breakpoint
CREATE INDEX `profile_owner` ON `profiles` (`tenant`,`owner`);