-- Paczki add-inu CX Studio 2026 do pobrania przez updater.
-- Dostep wylacznie przez service role po stronie API (RLS bez polityk = deny all).

create table if not exists public.releases (
  id            bigserial primary key,
  version       text        not null unique
                            check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$'),
  -- sciezka w prywatnym buckecie 'releases'
  storage_path  text        not null,
  -- 'pending' do czasu finalize: plik zapowiedziany, jeszcze niezweryfikowany
  status        text        not null default 'pending'
                            check (status in ('pending', 'published')),
  -- liczone przez serwer z pliku lezacego w Storage, nigdy przyjmowane od klienta
  sha256        text,
  size_bytes    bigint,
  notes         text,
  created_at    timestamptz not null default now(),
  published_at  timestamptz
);

create index if not exists releases_status_idx on public.releases (status);

alter table public.releases enable row level security;

revoke all on public.releases from anon, authenticated;
revoke all on sequence public.releases_id_seq from anon, authenticated;

-- Prywatny bucket na paczki. 50 MB = globalny limit pliku w planie Free Supabase.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('releases', 'releases', false, 52428800, array['application/zip'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
