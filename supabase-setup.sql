-- ============================================================
-- Configuração da base de dados no Supabase (grátis)
-- Cola isto em: Supabase → SQL Editor → New query → Run
-- ============================================================

-- Tabela: uma linha por utilizador, com a coleção em JSON.
create table if not exists public.collections (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Ativar Row Level Security: cada utilizador só acede aos seus dados.
alter table public.collections enable row level security;

-- Política: o utilizador só pode ler/escrever a sua própria linha.
drop policy if exists "own collection" on public.collections;
create policy "own collection"
  on public.collections
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
