-- 小太阳工作轨迹：用户云端状态表
-- 在 Supabase Dashboard -> SQL Editor 中执行此文件。

create table if not exists public.user_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_states enable row level security;

drop policy if exists "Users can read their own state" on public.user_states;
create policy "Users can read their own state"
  on public.user_states for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own state" on public.user_states;
create policy "Users can create their own state"
  on public.user_states for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own state" on public.user_states;
create policy "Users can update their own state"
  on public.user_states for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own state" on public.user_states;
create policy "Users can delete their own state"
  on public.user_states for delete
  to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.user_states to authenticated;

create or replace function public.set_user_state_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_state_updated_at on public.user_states;
create trigger set_user_state_updated_at
before update on public.user_states
for each row execute function public.set_user_state_updated_at();

-- 私有附件存储：对象路径的第一段必须是当前登录用户 ID。
insert into storage.buckets (id, name, public, file_size_limit)
values ('work-files', 'work-files', false, 10485760)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "Users can read their own work files" on storage.objects;
create policy "Users can read their own work files"
  on storage.objects for select to authenticated
  using (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users can upload their own work files" on storage.objects;
create policy "Users can upload their own work files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users can update their own work files" on storage.objects;
create policy "Users can update their own work files"
  on storage.objects for update to authenticated
  using (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users can delete their own work files" on storage.objects;
create policy "Users can delete their own work files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'work-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
