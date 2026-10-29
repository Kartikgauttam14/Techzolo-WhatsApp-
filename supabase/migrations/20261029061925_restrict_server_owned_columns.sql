-- RLS controls which workspace row may be changed; column grants control
-- which fields authenticated users may change inside that row.

begin;

revoke update on public.workspaces from authenticated;
grant update (
  name,
  brand_color,
  logo_path,
  timezone,
  business_phone,
  privacy_text,
  public_signup_enabled,
  notifications_enabled,
  updated_at
) on public.workspaces to authenticated;

revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

commit;
