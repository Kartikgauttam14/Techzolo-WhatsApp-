-- Keep authenticated SELECT checks to one policy per table. Separate write
-- actions avoid Supabase's multiple-permissive-policy advisor warnings.

begin;

drop policy "Workspace admins can manage assistant configuration" on public.assistant_configs;
create policy "Workspace admins can insert assistant configuration" on public.assistant_configs
  for insert to authenticated with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can update assistant configuration" on public.assistant_configs
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can delete assistant configuration" on public.assistant_configs
  for delete to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin']));

drop policy "Workspace admins can manage automations" on public.automations;
create policy "Workspace admins can insert automations" on public.automations
  for insert to authenticated with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can update automations" on public.automations
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can delete automations" on public.automations
  for delete to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin']));

drop policy "Workspace admins can manage campaigns" on public.campaigns;
create policy "Workspace admins can insert campaigns" on public.campaigns
  for insert to authenticated with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can update campaigns" on public.campaigns
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can delete campaigns" on public.campaigns
  for delete to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin']));

drop policy "Workspace admins can manage message templates" on public.message_templates;
create policy "Workspace admins can insert message templates" on public.message_templates
  for insert to authenticated with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can update message templates" on public.message_templates
  for update to authenticated
  using (app_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (app_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy "Workspace admins can delete message templates" on public.message_templates
  for delete to authenticated using (app_private.has_workspace_role(workspace_id, array['owner','admin']));

commit;
