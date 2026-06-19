-- B3Cloud project/deployment persistence.
-- Run this in Supabase SQL Editor before deploying the API change.

create table if not exists public.b3cloud_deploy_jobs (
  job_id text primary key,
  user_id text not null,
  namespace text not null,
  app_name text not null,
  github_url text not null default '',
  git_revision text not null default '',
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  document jsonb not null default '{}'::jsonb
);

create index if not exists b3cloud_deploy_jobs_user_updated_idx
  on public.b3cloud_deploy_jobs (user_id, updated_at desc);

create index if not exists b3cloud_deploy_jobs_project_idx
  on public.b3cloud_deploy_jobs (namespace, app_name, updated_at desc);

alter table public.b3cloud_deploy_jobs enable row level security;

-- No anon/authenticated policies are defined intentionally.
-- The browser never talks to this table directly. The API server uses the
-- Supabase service-role key and enforces project ownership in user_api.py.
