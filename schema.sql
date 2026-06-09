-- ============================================================
-- Summer Pages — Supabase Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor
-- ============================================================
-- Auth note: authentication is handled by j2auth (Jupiter 2).
-- Supabase is used as a plain database with the anon key.
-- User identity is the E.164 phone number (e.g. +15551234567).
-- Row-level security is intentionally disabled; data isolation
-- is enforced in app code by filtering on user_id.
-- ============================================================


-- ============================================================
-- TABLES
-- ============================================================

-- Profiles (one per user, keyed by E.164 phone number)
create table if not exists profiles (
  id           text primary key,          -- E.164 phone number
  name         text not null default 'Journaler',
  avatar_color text not null default '#534AB7',
  created_at   timestamptz default now()
);

-- Journal entries (one per user per prompt date)
-- Prompts are defined in prompts.json in the repo, not in the DB.
-- prompt_date is the ISO date string from that file (e.g. "2025-06-09").
create table if not exists entries (
  id          bigint generated always as identity primary key,
  user_id     text not null,              -- E.164 phone number
  prompt_date text not null,              -- matches "date" field in prompts.json
  body        text not null default '',
  mood        text check (mood in ('happy','excited','calm','thoughtful','silly','proud')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Photos attached to entries (stored in Supabase Storage bucket "photos")
create table if not exists entry_photos (
  id           bigint generated always as identity primary key,
  entry_id     bigint references entries on delete cascade not null,
  storage_path text not null,
  created_at   timestamptz default now()
);


-- ============================================================
-- INDEXES
-- ============================================================

create index if not exists entries_user_id_idx on entries (user_id);
create index if not exists entries_created_at_idx on entries (created_at desc);
create index if not exists entries_prompt_date_idx on entries (prompt_date);
create index if not exists entry_photos_entry_id_idx on entry_photos (entry_id);


-- ============================================================
-- STORAGE SETUP (manual steps — cannot be done via SQL)
-- ============================================================
-- 1. Go to Supabase Dashboard → Storage
-- 2. Click "New bucket", name it: photos
-- 3. Check "Public bucket" (so photo URLs work without auth)
-- 4. Under Storage → Policies, add a policy on the "photos" bucket:
--    - Policy name: "Public read, any upload"
--    - Allowed operations: SELECT (all), INSERT (all)
--    - This is intentionally permissive; tighten later if needed.
-- ============================================================
