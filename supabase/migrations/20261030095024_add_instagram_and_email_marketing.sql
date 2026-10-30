-- Email marketing and Instagram professional inbox additions.
-- Credentials and one-time OAuth states are private server-only records.
begin;

alter table public.campaigns
  add column channel text not null default 'whatsapp'
    check (channel in ('whatsapp','email')),
  add column email_subject text,
  add column email_body text;

create table public.email_marketing_subscriptions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null,
  email text not null check (char_length(email) <= 254),
  status text not null check (status in ('pending','confirmed','unsubscribed')),
  consent_source text not null,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, email),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id,id) on delete cascade
);
create index email_subscriptions_audience on public.email_marketing_subscriptions(workspace_id,status,email);

create table public.email_campaign_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  contact_id uuid not null,
  email text not null,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','unknown','suppressed')),
  error_message text not null default '',
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id,campaign_id) references public.campaigns(workspace_id,id) on delete cascade,
  foreign key (workspace_id,contact_id) references public.contacts(workspace_id,id) on delete cascade,
  unique (campaign_id,email)
);
create index email_campaign_queue on public.email_campaign_deliveries(workspace_id,campaign_id,status);

create table public.instagram_accounts (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  instagram_account_id text not null unique,
  username text not null default '',
  connection_status text not null default 'connected' check (connection_status in ('connected','disconnected','reauth_required')),
  token_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  last_webhook_at timestamptz,
  updated_at timestamptz not null default now()
);
create table app_private.instagram_credentials (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  encrypted_access_token text not null,
  updated_at timestamptz not null default now()
);
create table app_private.instagram_oauth_states (
  state_hash text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  expires_at timestamptz not null
);
create table public.instagram_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  instagram_account_id text not null,
  instagram_scoped_user_id text not null,
  contact_id uuid,
  display_name text not null default '',
  last_inbound_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id,contact_id) references public.contacts(workspace_id,id) on delete set null (contact_id),
  unique (workspace_id,instagram_account_id,instagram_scoped_user_id)
);
create index instagram_inbox_recent on public.instagram_conversations(workspace_id,updated_at desc);
create table public.instagram_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null,
  direction text not null check (direction in ('inbound','outbound')),
  body text not null default '',
  provider_message_id text,
  delivery_status text not null default 'received' check (delivery_status in ('sending','accepted','received','failed')),
  created_at timestamptz not null default now(),
  foreign key (workspace_id,conversation_id) references public.instagram_conversations(workspace_id,id) on delete cascade,
  unique (workspace_id,provider_message_id)
);
create index instagram_message_thread on public.instagram_messages(workspace_id,conversation_id,created_at desc);

alter table public.email_marketing_subscriptions enable row level security;
alter table public.email_campaign_deliveries enable row level security;
alter table public.instagram_accounts enable row level security;
alter table public.instagram_conversations enable row level security;
alter table public.instagram_messages enable row level security;
alter table app_private.instagram_credentials enable row level security;
alter table app_private.instagram_oauth_states enable row level security;

create policy "Workspace admins can view email permissions" on public.email_marketing_subscriptions
  for select to authenticated using (app_private.has_workspace_role(workspace_id,array['owner','admin']));
create policy "Workspace members can view email campaign deliveries" on public.email_campaign_deliveries
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace members can view Instagram account status" on public.instagram_accounts
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace members can view Instagram conversations" on public.instagram_conversations
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace members can view Instagram messages" on public.instagram_messages
  for select to authenticated using (app_private.is_workspace_member(workspace_id));

revoke all on public.email_marketing_subscriptions,public.email_campaign_deliveries,public.instagram_accounts,public.instagram_conversations,public.instagram_messages from anon;
grant select on public.email_marketing_subscriptions,public.email_campaign_deliveries,public.instagram_accounts,public.instagram_conversations,public.instagram_messages to authenticated;
grant all on public.email_marketing_subscriptions,public.email_campaign_deliveries,public.instagram_accounts,public.instagram_conversations,public.instagram_messages to service_role;
grant all on app_private.instagram_credentials,app_private.instagram_oauth_states to service_role;

commit;
