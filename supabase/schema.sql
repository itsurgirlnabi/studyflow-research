-- Run in the Supabase SQL Editor. Configure the study dates before enrolling students.
create extension if not exists pgcrypto;

create type public.research_period as enum ('BASELINE', 'INTERVENTION', 'OUTSIDE_STUDY');
create type public.app_role as enum ('participant', 'researcher');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'participant',
  created_at timestamptz not null default now()
);
create table public.participants (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique not null references auth.users(id) on delete cascade,
  participant_code text unique not null check (participant_code ~ '^[A-Za-z0-9-]{3,32}$'),
  created_at timestamptz not null default now()
);
create table public.study_settings (
  id boolean primary key default true check (id),
  baseline_start date not null,
  baseline_days int not null default 7 check (baseline_days > 0),
  intervention_days int not null default 7 check (intervention_days > 0),
  updated_at timestamptz not null default now()
);
-- Replace this date with your first baseline day, then keep one settings row only.
insert into public.study_settings(id, baseline_start) values(true, current_date)
on conflict (id) do nothing;

create or replace function public.current_period(for_date date)
returns public.research_period language sql stable security definer set search_path=public as $$
 select case when for_date >= baseline_start and for_date < baseline_start + baseline_days then 'BASELINE'::public.research_period
             when for_date >= baseline_start + baseline_days and for_date < baseline_start + baseline_days + intervention_days then 'INTERVENTION'::public.research_period
             else 'OUTSIDE_STUDY'::public.research_period end from public.study_settings where id=true
$$;
create or replace function public.is_researcher()
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.profiles where id=auth.uid() and role='researcher')
$$;

create table public.tasks (
  id uuid primary key default gen_random_uuid(), participant_id uuid not null references public.participants(id) on delete restrict,
  client_event_id uuid unique not null default gen_random_uuid(), title text not null check (char_length(title) between 1 and 200), subject text, estimated_pomodoros smallint not null default 1 check (estimated_pomodoros between 1 and 20),
  completed boolean not null default false, created_at timestamptz not null default now(), completed_at timestamptz
);
create index tasks_participant_created_idx on public.tasks(participant_id, created_at desc);
create table public.focus_sessions (
  id uuid primary key default gen_random_uuid(), client_event_id uuid unique not null, participant_id uuid not null references public.participants(id) on delete restrict,
  task_id uuid references public.tasks(id) on delete set null, session_number int not null check(session_number > 0), planned_duration int not null check(planned_duration > 0), actual_duration int not null check(actual_duration >= 0),
  completed boolean not null default false, started_at timestamptz not null, ended_at timestamptz
);
create index focus_sessions_participant_ended_idx on public.focus_sessions(participant_id, ended_at desc);
create table public.daily_productivity (
  id uuid primary key default gen_random_uuid(), participant_id uuid not null references public.participants(id) on delete restrict,
  date date not null, research_period public.research_period not null, tasks_created int not null default 0, tasks_completed int not null default 0,
  pomodoro_sessions int not null default 0, focused_minutes int not null default 0, unique(participant_id,date)
);
create index daily_productivity_period_idx on public.daily_productivity(research_period,date);

create or replace function public.ensure_daily(p_id uuid, p_date date) returns void language plpgsql security definer set search_path=public as $$
begin insert into public.daily_productivity(participant_id,date,research_period) values(p_id,p_date,public.current_period(p_date)) on conflict(participant_id,date) do nothing; end $$;
create or replace function public.task_daily_rollup() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='INSERT' then perform public.ensure_daily(new.participant_id,new.created_at::date); update public.daily_productivity set tasks_created=tasks_created+1 where participant_id=new.participant_id and date=new.created_at::date; end if;
 if tg_op='UPDATE' and old.completed is distinct from new.completed then
   perform public.ensure_daily(new.participant_id,current_date);
   update public.daily_productivity set tasks_completed=greatest(0,tasks_completed + case when new.completed then 1 else -1 end) where participant_id=new.participant_id and date=current_date;
 end if; return new;
end $$;
create trigger task_rollup after insert or update of completed on public.tasks for each row execute function public.task_daily_rollup();
create or replace function public.session_daily_rollup() returns trigger language plpgsql security definer set search_path=public as $$
begin if new.completed and (tg_op='INSERT' or old.completed=false) then perform public.ensure_daily(new.participant_id,new.ended_at::date); update public.daily_productivity set pomodoro_sessions=pomodoro_sessions+1,focused_minutes=focused_minutes+ceil(new.actual_duration/60.0)::int where participant_id=new.participant_id and date=new.ended_at::date; end if; return new; end $$;
create trigger session_rollup after insert or update of completed on public.focus_sessions for each row execute function public.session_daily_rollup();

alter table public.profiles enable row level security; alter table public.participants enable row level security; alter table public.tasks enable row level security; alter table public.focus_sessions enable row level security; alter table public.daily_productivity enable row level security; alter table public.study_settings enable row level security;
create policy "own profile" on public.profiles for select using(id=auth.uid());
create policy "own participant" on public.participants for select using(auth_user_id=auth.uid());
create policy "own tasks" on public.tasks for all using(participant_id=(select id from public.participants where auth_user_id=auth.uid())) with check(participant_id=(select id from public.participants where auth_user_id=auth.uid()));
create policy "own sessions" on public.focus_sessions for all using(participant_id=(select id from public.participants where auth_user_id=auth.uid())) with check(participant_id=(select id from public.participants where auth_user_id=auth.uid()));
create policy "own daily" on public.daily_productivity for select using(participant_id=(select id from public.participants where auth_user_id=auth.uid()));
create policy "researchers read profiles" on public.profiles for select using(public.is_researcher());
create policy "researchers read participants" on public.participants for select using(public.is_researcher());
create policy "researchers read tasks" on public.tasks for select using(public.is_researcher());
create policy "researchers read sessions" on public.focus_sessions for select using(public.is_researcher());
create policy "researchers read daily" on public.daily_productivity for select using(public.is_researcher());
create policy "researchers manage settings" on public.study_settings for all using(public.is_researcher()) with check(public.is_researcher());
create or replace function public.record_baseline_tasks(p_tasks_completed int) returns void language plpgsql security definer set search_path=public as $$
declare p_id uuid; today date := current_date;
begin
 if p_tasks_completed < 0 or p_tasks_completed > 99 or public.current_period(today) <> 'BASELINE' then raise exception 'Baseline entry is not available'; end if;
 select id into p_id from public.participants where auth_user_id=auth.uid(); if p_id is null then raise exception 'Participant account required'; end if;
 insert into public.daily_productivity(participant_id,date,research_period,tasks_completed) values(p_id,today,'BASELINE',p_tasks_completed)
 on conflict(participant_id,date) do update set tasks_completed=excluded.tasks_completed where public.daily_productivity.research_period='BASELINE';
end $$;
grant execute on function public.record_baseline_tasks(int) to authenticated;
create or replace function public.reset_research_records() returns void language plpgsql security definer set search_path=public as $$
begin if not public.is_researcher() then raise exception 'Researcher role required'; end if; delete from public.focus_sessions; delete from public.tasks; delete from public.daily_productivity; end $$;
grant execute on function public.reset_research_records() to authenticated;
-- Create a researcher in Authentication, then run exactly once with that user's UUID:
-- insert into public.profiles(id,role) values ('AUTH-USER-UUID','researcher') on conflict(id) do update set role='researcher';
