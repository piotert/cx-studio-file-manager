-- Informacja o aktualizacji add-inu CX Studio 2026.
-- Jeden wiersz konfiguracji; endpoint /api/update tylko go czyta.

create table if not exists public.app_release (
  -- Wymuszamy dokladnie jeden wiersz: konfiguracja, nie historia wydan.
  id           smallint    primary key default 1 check (id = 1),
  -- null = nic jeszcze nie opublikowano
  version      text        check (version ~ '^[0-9]{1,9}(\.[0-9]{1,9}){0,3}(-[0-9A-Za-z.-]{1,32})?$'),
  download_url text,
  notes        text,
  -- add-in ma potraktowac aktualizacje jako obowiazkowa
  mandatory    boolean     not null default false,
  -- suma kontrolna instalatora, zeby klient mogl zweryfikowac pobrany plik
  sha256       text        check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  released_at  timestamptz,
  -- wylaczone = endpoint oddaje "brak aktualizacji", mimo wypelnionych pol
  published    boolean     not null default false,
  updated_at   timestamptz not null default now()
);
insert into public.app_release (id) values (1) on conflict (id) do nothing;
-- Funkcja z migracji feedbacku jest generyczna (ustawia new.updated_at), wiec ja reuzywamy.
drop trigger if exists app_release_set_updated_at on public.app_release;
create trigger app_release_set_updated_at
  before update on public.app_release
  for each row execute function public.feedback_touch_updated_at();
-- Brak polityk = tylko service role. Tresc jest publiczna, ale wylacznie
-- przez /api/update — do tabeli klient przegladarki nie siega.
alter table public.app_release enable row level security;
revoke all on public.app_release from anon, authenticated;
