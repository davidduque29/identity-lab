ALTER TABLE profiles ADD COLUMN account_id TEXT;
CREATE INDEX profile_account ON profiles(tenant, account_id);
CREATE INDEX events_actor_time ON events(tenant, actor, created_at DESC);
