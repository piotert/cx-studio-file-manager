-- Zgloszenia z add-inu CX Studio 2026.
-- Dostep wylacznie przez service role po stronie API (RLS bez polityk = deny all).

create table if not exists public.feedback (
  id                bigserial primary key,
  created_at        timestamptz not null default now(),
  -- czas z zegara uzytkownika, tylko do porownania; nie ufamy mu
  client_created_at timestamptz,
  kind              text        not null check (kind in ('Blad', 'Sugestia', 'Pytanie')),
  description       text        not null check (length(description) between 1 and 20000),
  user_name         text,
  addin_version     text,
  context           text,
  -- sciezka w prywatnym buckecie 'feedback'; null gdy uzytkownik nie dolaczyl logu
  log_path          text,
  -- ustawiane na true dopiero po potwierdzeniu wgrania ZIP-a przez klienta
  log_uploaded      boolean     not null default false,
  status            text        not null default 'new'
                                check (status in ('new', 'in_progress', 'done', 'wontfix')),
  notes             text,
  client_ip         inet,
  updated_at        timestamptz not null default now()
);

-- lista domyslnie filtruje po statusie i sortuje malejaco po dacie
create index if not exists feedback_status_created_idx on public.feedback (status, created_at desc);
create index if not exists feedback_created_idx        on public.feedback (created_at desc);
-- okno rate limitingu: liczymy zgloszenia z jednego IP z ostatniej godziny
create index if not exists feedback_ip_created_idx     on public.feedback (client_ip, created_at desc);

create or replace function public.feedback_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists feedback_set_updated_at on public.feedback;
create trigger feedback_set_updated_at
  before update on public.feedback
  for each row execute function public.feedback_touch_updated_at();

-- Brak polityk = tylko service role ma dostep. Klient przegladarki nie dotknie tabeli.
alter table public.feedback enable row level security;

revoke all on public.feedback from anon, authenticated;
revoke all on sequence public.feedback_id_seq from anon, authenticated;

-- Prywatny bucket na logi. 10 MB zgodnie z MaxUploadBytes w add-inie.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback', 'feedback', false, 10485760, array['application/zip'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
