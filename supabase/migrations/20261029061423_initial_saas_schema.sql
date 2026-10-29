-- Techzolo Customer Workspaces: multi-tenant SaaS schema for Supabase Auth.
-- Runtime migration note: the current Express server still uses SQLite. This
-- schema is the secure Postgres foundation for the planned Supabase cutover.

begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  email text not null default '',
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 48),
  name text not null check (char_length(name) between 1 and 120),
  brand_color text not null default '#087f5b' check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_path text,
  timezone text not null default 'Asia/Kolkata',
  business_phone text,
  privacy_text text not null default '',
  public_signup_enabled boolean not null default true,
  notifications_enabled boolean not null default true,
  plan text not null default 'growth' check (plan in ('starter','growth','scale')),
  subscription_status text not null default 'trialing' check (subscription_status in ('trialing','active','past_due','canceled','incomplete','unpaid')),
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  suspended_at timestamptz,
  suspension_reason text not null default '',
  state_version bigint not null default 1 check (state_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','agent','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create unique index workspace_one_owner on public.workspace_memberships(workspace_id) where role = 'owner';
create index workspace_memberships_user on public.workspace_memberships(user_id, workspace_id);

-- These narrow SECURITY DEFINER helpers let RLS inspect membership without
-- exposing private rows or creating recursive membership-table policies.
create or replace function app_private.is_workspace_member(target_workspace uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = target_workspace and m.user_id = (select auth.uid())
  );
$$;

create or replace function app_private.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = target_workspace
      and m.user_id = (select auth.uid())
      and m.role = any(allowed_roles)
  );
$$;

create or replace function app_private.can_view_profile(target_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select target_user = (select auth.uid()) or exists (
    select 1
    from public.workspace_memberships mine
    join public.workspace_memberships theirs using (workspace_id)
    where mine.user_id = (select auth.uid()) and theirs.user_id = target_user
  );
$$;

revoke all on function app_private.is_workspace_member(uuid) from public, anon;
revoke all on function app_private.has_workspace_role(uuid, text[]) from public, anon;
revoke all on function app_private.can_view_profile(uuid) from public, anon;
grant execute on function app_private.is_workspace_member(uuid) to authenticated;
grant execute on function app_private.has_workspace_role(uuid, text[]) to authenticated;
grant execute on function app_private.can_view_profile(uuid) to authenticated;

create or replace function app_private.sync_auth_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), coalesce(new.email, ''))
  on conflict (id) do update
    set email = excluded.email,
        display_name = case
          when coalesce(new.raw_user_meta_data ->> 'full_name', '') <> ''
          then new.raw_user_meta_data ->> 'full_name'
          else public.profiles.display_name
        end,
        updated_at = now();
  return new;
end;
$$;
revoke all on function app_private.sync_auth_profile() from public, anon, authenticated;
create trigger on_auth_user_profile_sync
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function app_private.sync_auth_profile();

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 160),
  phone text not null,
  email text,
  source text not null default 'manual',
  consent_status text not null default 'unknown' check (consent_status in ('unknown','pending','opted_in','opted_out')),
  consent_at timestamptz,
  tags text[] not null default '{}',
  custom_fields jsonb not null default '{}'::jsonb check (jsonb_typeof(custom_fields) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, phone)
);
create index contacts_workspace_name on public.contacts(workspace_id, full_name);
create index contacts_workspace_created on public.contacts(workspace_id, created_at desc);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null,
  whatsapp_phone_number_id text,
  last_inbound_at timestamptz,
  last_message_at timestamptz not null default now(),
  unread_count integer not null default 0 check (unread_count >= 0),
  assigned_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, contact_id, whatsapp_phone_number_id),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete cascade
);
create index conversations_inbox on public.conversations(workspace_id, last_message_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null,
  direction text not null check (direction in ('inbound','outbound')),
  message_type text not null default 'text' check (message_type in ('text','template','image','document','audio','video','location','interactive','unsupported')),
  body text not null default '',
  provider_message_id text,
  delivery_status text not null default 'received' check (delivery_status in ('sending','unknown','accepted','sent','delivered','read','received','failed')),
  error_message text not null default '',
  request_key text,
  request_fingerprint text,
  provider_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_payload) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id) on delete cascade,
  unique (workspace_id, request_key),
  unique (workspace_id, provider_message_id)
);
create index messages_thread on public.messages(workspace_id, conversation_id, created_at desc);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid,
  title text not null check (char_length(title) between 1 and 200),
  stage text not null default 'new',
  value numeric(14,2) not null default 0 check (value >= 0),
  currency char(3) not null default 'INR',
  probability smallint not null default 0 check (probability between 0 and 100),
  expected_close_date date,
  assigned_to uuid references auth.users(id) on delete set null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete set null (contact_id)
);
create index deals_pipeline on public.deals(workspace_id, stage, updated_at desc);

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  category text not null default 'utility' check (category in ('marketing','utility','authentication','service')),
  language text not null default 'en',
  body text not null check (char_length(body) <= 4096),
  variables jsonb not null default '[]'::jsonb check (jsonb_typeof(variables) = 'array'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name, language)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'draft' check (status in ('draft','scheduled','queued','sending','paused','completed','failed')),
  template_id uuid,
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, template_id) references public.message_templates(workspace_id, id) on delete set null (template_id)
);
create index campaigns_workspace_created on public.campaigns(workspace_id, created_at desc);

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  contact_id uuid not null,
  status text not null default 'pending' check (status in ('pending','queued','sent','delivered','read','failed','skipped')),
  message_id uuid references public.messages(id) on delete set null,
  error_message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete cascade,
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete cascade,
  unique (campaign_id, contact_id)
);

create table public.automations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  enabled boolean not null default false,
  trigger_type text not null default 'manual',
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assistant_configs (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  name text not null default 'Assistant',
  tone text not null default 'Warm and helpful',
  instructions text not null default '',
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_unread on public.notifications(user_id, created_at desc) where read_at is null;

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (char_length(email) <= 254),
  role text not null check (role in ('admin','agent','viewer')),
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);
create index workspace_invitations_pending on public.workspace_invitations(workspace_id, expires_at) where accepted_at is null;

create table public.public_signup_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  full_name text not null,
  phone text not null,
  consent_wording text not null,
  request_status text not null default 'pending' check (request_status in ('pending','confirmed','rejected')),
  created_at timestamptz not null default now(),
  unique (workspace_id, phone)
);

create table public.whatsapp_accounts (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  business_account_id text not null unique,
  phone_number_id text not null unique,
  display_phone text not null,
  business_name text not null default '',
  connection_status text not null default 'connected' check (connection_status in ('connected','disconnected','reauth_required')),
  token_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  last_webhook_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Never expose provider tokens, Stripe IDs, raw action links, or global admin
-- membership through PostgREST. The server uses the service_role key privately.
create table app_private.whatsapp_credentials (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  encrypted_access_token text not null,
  updated_at timestamptz not null default now()
);
create table app_private.billing_accounts (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  updated_at timestamptz not null default now()
);
create table app_private.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table app_private.action_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  token_type text not null check (token_type in ('verify_email','password_reset')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table app_private.whatsapp_oauth_states (
  state_hash text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table app_private.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('whatsapp','stripe')),
  provider_event_id text not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);
create table app_private.rate_limit_buckets (
  bucket_key text primary key,
  count integer not null check (count >= 0),
  expires_at timestamptz not null
);

create table public.whatsapp_templates (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider_template_id text not null,
  name text not null,
  language text not null,
  category text not null,
  approval_status text not null,
  components jsonb not null default '[]'::jsonb check (jsonb_typeof(components) = 'array'),
  synced_at timestamptz not null default now(),
  primary key (workspace_id, provider_template_id)
);

create table public.whatsapp_consent_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid,
  phone text not null,
  opted_in boolean not null,
  source_message_id text,
  consent_wording text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete set null (contact_id)
);
create index whatsapp_consent_events_contact on public.whatsapp_consent_events(workspace_id, phone, occurred_at desc);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_label text not null default '',
  action text not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);
create index audit_logs_workspace_recent on public.audit_logs(workspace_id, created_at desc);

-- Secure workspace branding. This bucket is public because logos are public
-- brand assets; all writes stay on the authenticated server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('workspace-logos', 'workspace-logos', true, 2097152, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Enable row security for every public table exposed through the Data API.
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.deals enable row level security;
alter table public.message_templates enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.automations enable row level security;
alter table public.assistant_configs enable row level security;
alter table public.notifications enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.public_signup_requests enable row level security;
alter table public.whatsapp_accounts enable row level security;
alter table public.whatsapp_templates enable row level security;
alter table public.whatsapp_consent_events enable row level security;
alter table public.audit_logs enable row level security;

alter table app_private.whatsapp_credentials enable row level security;
alter table app_private.billing_accounts enable row level security;
alter table app_private.platform_admins enable row level security;
alter table app_private.action_tokens enable row level security;
alter table app_private.whatsapp_oauth_states enable row level security;
alter table app_private.webhook_events enable row level security;
alter table app_private.rate_limit_buckets enable row level security;

create policy "Users can view themselves and workspace teammates" on public.profiles
  for select to authenticated using (app_private.can_view_profile(id));
create policy "Users can create their own profile" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy "Users can update their own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Workspace members can view their workspace" on public.workspaces
  for select to authenticated using (app_private.is_workspace_member(id));
create policy "Workspace admins can update workspace settings" on public.workspaces
  for update to authenticated
  using (app_private.has_workspace_role(id, array['owner','admin']))
  with check (app_private.has_workspace_role(id, array['owner','admin']));

create policy "Members can view workspace memberships" on public.workspace_memberships
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace admins can remove non-owner memberships" on public.workspace_memberships
  for delete to authenticated
  using (role <> 'owner' and app_private.has_workspace_role(workspace_id, array['owner','admin']));

create policy "Workspace members can view contacts" on public.contacts
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace agents can add contacts" on public.contacts
  for insert to authenticated with check (app_private.has_workspace_role(workspace_id, array['owner','admin','agent']));
create policy "Workspace agents can edit contacts" on public.contacts
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin','agent']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin','agent']));
create policy "Workspace agents can remove contacts" on public.contacts
  for delete to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin','agent']));

create policy "Workspace members can view conversations" on public.conversations
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace members can view messages" on public.messages
  for select to authenticated using (app_private.is_workspace_member(workspace_id));

create policy "Workspace members can view deals" on public.deals
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace agents can add deals" on public.deals
  for insert to authenticated with check (app_private.has_workspace_role(workspace_id, array['owner','admin','agent']));
create policy "Workspace agents can edit deals" on public.deals
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin','agent']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin','agent']));
create policy "Workspace agents can remove deals" on public.deals
  for delete to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin','agent']));

create policy "Workspace members can view message templates" on public.message_templates
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace admins can manage message templates" on public.message_templates
  for all to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));

create policy "Workspace members can view campaigns" on public.campaigns
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace admins can manage campaigns" on public.campaigns
  for all to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace members can view campaign recipients" on public.campaign_recipients
  for select to authenticated using (app_private.is_workspace_member(workspace_id));

create policy "Workspace members can view automations" on public.automations
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace admins can manage automations" on public.automations
  for all to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace members can view assistant configuration" on public.assistant_configs
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace admins can manage assistant configuration" on public.assistant_configs
  for all to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));

create policy "Users can view their own workspace notifications" on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) and app_private.is_workspace_member(workspace_id));
create policy "Users can mark their own notifications read" on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()) and app_private.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and app_private.is_workspace_member(workspace_id));

create policy "Workspace admins can view invitations" on public.workspace_invitations
  for select to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can revoke invitations" on public.workspace_invitations
  for delete to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can view signup requests" on public.public_signup_requests
  for select to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin']));

create policy "Workspace members can view WhatsApp account status" on public.whatsapp_accounts
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace members can view WhatsApp templates" on public.whatsapp_templates
  for select to authenticated using (app_private.is_workspace_member(workspace_id));
create policy "Workspace admins can view consent evidence" on public.whatsapp_consent_events
  for select to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can view audit history" on public.audit_logs
  for select to authenticated using (
    workspace_id is not null
    and app_private.has_workspace_role(workspace_id, array['owner','admin'])
  );

-- Revoke anonymous API access. Authenticated access is explicitly granted and
-- every public table above is protected by RLS; privileged writes are handled
-- by the server using a service_role credential that must never reach clients.
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all tables in schema app_private to service_role;
grant all on all sequences in schema public to service_role;
grant all on all sequences in schema app_private to service_role;
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_path, updated_at) on public.profiles to authenticated;

commit;
