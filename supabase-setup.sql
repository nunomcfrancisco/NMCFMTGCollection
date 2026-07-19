-- ============================================================
-- Base de dados da coleção no Supabase (grátis)
-- Cola isto em: Supabase → SQL Editor → New query → Run
--
-- Modelo relacional: UMA LINHA POR CARTA.
-- A coleção passa a viver aqui (fonte de verdade), não no browser.
-- ============================================================

create table if not exists public.collection_cards (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  card_id    text        not null,                 -- id da carta na Scryfall
  qty        integer     not null default 1,
  foil       boolean     not null default false,
  added_at   bigint,                               -- timestamp (ms) de quando foi adicionada
  card       jsonb       not null,                 -- dados da carta (nome, set, preços, imagens…)
  updated_at timestamptz not null default now(),
  primary key (user_id, card_id)
);

-- Consultas por utilizador são o caso comum.
create index if not exists collection_cards_user_idx
  on public.collection_cards (user_id);

-- Ativar Row Level Security: cada utilizador só acede às suas cartas.
alter table public.collection_cards enable row level security;

-- Política: o utilizador só pode ler/escrever as suas próprias linhas.
drop policy if exists "own cards" on public.collection_cards;
create policy "own cards"
  on public.collection_cards
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- (Opcional) Migração da versão antiga
-- ------------------------------------------------------------
-- Se já tinhas a tabela `collections` (coleção num único JSON por
-- utilizador), corre também isto para converter para linhas por carta.
-- Podes apagar a tabela antiga depois de confirmares que ficou tudo.
-- ============================================================
-- insert into public.collection_cards (user_id, card_id, qty, foil, added_at, card)
-- select c.user_id,
--        e.key                              as card_id,
--        coalesce((e.value->>'qty')::int, 1),
--        coalesce((e.value->>'foil')::boolean, false),
--        (e.value->>'addedAt')::bigint,
--        e.value->'card'
--   from public.collections c,
--        lateral jsonb_each(c.data) as e(key, value)
--  where e.value ? 'card'
--     on conflict (user_id, card_id) do nothing;
