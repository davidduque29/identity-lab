import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    tenant: text('tenant').notNull(),
    owner: text('owner').notNull(),
    documentKey: text('document_key').notNull(),
    data: text('data').notNull(),
    biometric: text('biometric').notNull(),
    media: text('media').notNull(),
    status: text('status').notNull().default('active'),
    failures: integer('failures').notNull().default(0),
    lockedUntil: integer('locked_until').notNull().default(0),
    version: integer('version').notNull().default(1),
    lastAttempt: text('last_attempt'),
    updateAllowed: integer('update_allowed').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('profile_document').on(t.tenant, t.documentKey),
    index('profile_owner').on(t.tenant, t.owner),
  ],
);
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    tenant: text('tenant').notNull(),
    actor: text('actor').notNull(),
    profileId: text('profile_id'),
    action: text('action').notNull(),
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('events_tenant_time').on(t.tenant, t.createdAt)],
);
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  creator: text('creator').notNull(),
  claimant: text('claimant'),
  mode: text('mode').notNull(),
  expiresAt: integer('expires_at').notNull(),
  status: text('status').notNull(),
});
export const configuration = sqliteTable('configuration', {
  key: text('key').primaryKey(),
  payload: text('payload').notNull(),
});
