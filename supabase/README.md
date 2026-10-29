# Supabase database

The SaaS schema for Supabase project `whats_marketing` (`uvdjrbsiyircgutnstmm`)
is in `migrations/`. The initial model is in
`20261029061423_initial_saas_schema.sql`; the follow-up
`20261029061800_harden_workspace_policy_overlaps.sql` separates write policies
to keep SELECT checks efficient, and `20261029061925_restrict_server_owned_columns.sql`
prevents authenticated users from changing server-owned billing or notification
fields.

It models Supabase Auth profiles, workspaces and memberships, contacts, deals,
WhatsApp conversations and messages, consent evidence, templates, campaigns,
automations, assistant settings, notifications, invitations, billing, audit
history, and platform-admin records. Workspace data uses row-level security;
anonymous users receive no table access. WhatsApp tokens, Stripe identifiers,
one-time token hashes, webhook idempotency and platform-admin membership live
in the unexposed `app_private` schema for server-only access.

Workspace logos use the public `workspace-logos` Storage bucket. Logo images
are public brand assets; writes must go through the trusted server and must not
use a client-exposed service-role key.

## Runtime status

All three migrations have been applied to the Supabase project through its SQL
Editor and verified. The current Express runtime still reads and writes the local
SQLite database in `server.mjs`; this schema does not automatically move live
app data into Supabase. A separate backend cutover must replace the SQLite
repository and custom session authentication with Supabase Auth and Postgres
queries before production app traffic uses this database.

The schema references `auth.users`. Create application accounts through
Supabase Auth so the profile-sync trigger can create their `public.profiles`
rows. Workspace creation and membership/invitation acceptance should be done
by trusted server code using a server-only Supabase service-role credential.

## Migration history

The dashboard SQL Editor applied this migration directly; that operation does
not register the file in the CLI migration-history table. Keep the SQL file as
the source of truth and baseline the migration history before using CLI pushes
against this already-provisioned project.
