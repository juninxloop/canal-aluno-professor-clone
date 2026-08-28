-- ============================================================
-- CANAL ALUNO PROFESSOR — Schema do banco (Supabase / Postgres)
-- Cole este arquivo inteiro no SQL Editor do seu projeto Supabase
-- e clique em "Run".
-- ============================================================

-- 1) TABELA DE PERFIS
-- Guarda o "papel" (nível de acesso) de cada usuário.
-- As senhas NÃO ficam aqui — elas ficam na tabela interna
-- auth.users, gerenciada e criptografada pelo próprio Supabase.
create table if not exists public.perfis (
  id uuid primary key references auth.users (id) on delete cascade,
  nome text not null,
  email text not null,
  papel text not null check (papel in ('aluno', 'professor', 'admin')),
  criado_em timestamp with time zone default now()
);

-- 2) TABELA DE MENSAGENS (o chat em si)
create table if not exists public.mensagens (
  id bigserial primary key,
  remetente_id uuid not null references public.perfis (id) on delete cascade,
  destinatario_id uuid not null references public.perfis (id) on delete cascade,
  conteudo text not null,
  criado_em timestamp with time zone default now()
);

-- 3) TRIGGER: ao criar um usuário no Auth, já cria a linha em "perfis"
-- automaticamente, usando o nome e o papel enviados no cadastro
-- (guardados em raw_user_meta_data). Papel padrão: aluno.
create or replace function public.lidar_novo_usuario()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.perfis (id, nome, email, papel)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', 'Sem nome'),
    new.email,
    coalesce(new.raw_user_meta_data->>'papel', 'aluno')
  );
  return new;
end;
$$;

drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario
  after insert on auth.users
  for each row execute procedure public.lidar_novo_usuario();

-- 4) SEGURANÇA — Row Level Security (RLS)
-- Sem isso, qualquer usuário logado poderia ler/editar tudo.
alter table public.perfis enable row level security;
alter table public.mensagens enable row level security;

-- Qualquer usuário autenticado pode VER a lista de perfis
-- (precisa disso para saber com quem pode falar no chat).
create policy "perfis_select_autenticados"
  on public.perfis for select
  to authenticated
  using (true);

-- Um usuário só pode editar o PRÓPRIO perfil.
create policy "perfis_update_proprio"
  on public.perfis for update
  to authenticated
  using (auth.uid() = id);

-- Só pode LER mensagens onde é remetente OU destinatário.
create policy "mensagens_select_participante"
  on public.mensagens for select
  to authenticated
  using (auth.uid() = remetente_id or auth.uid() = destinatario_id);

-- Só pode ENVIAR mensagem se o remetente for ele mesmo.
create policy "mensagens_insert_proprio"
  on public.mensagens for insert
  to authenticated
  with check (auth.uid() = remetente_id);

-- 5) REALTIME — permite que o chat receba mensagens em tempo real
alter publication supabase_realtime add table public.mensagens;

-- ============================================================
-- COMO CRIAR USUÁRIOS (não existe cadastro público no site)
-- ============================================================
-- Todo usuário (aluno, professor ou admin) é criado pelo ADMIN
-- direto no painel do Supabase. O painel:
--   Authentication > Users > Add user
--
-- Ao criar, preencha:
--   - Email
--   - Password
--   - Marque "Auto Confirm User" (senão o Supabase espera
--     confirmação por e-mail antes de liberar o login)
--   - No campo "User Metadata", cole um JSON assim:
--
--       { "nome": "Maria Silva", "papel": "professor" }
--
--     (papel pode ser: "aluno", "professor" ou "admin")
--
-- O trigger "ao_criar_usuario" (definido acima) lê esse JSON
-- automaticamente e já cria a linha em "perfis" com o nome e o
-- papel corretos. Não precisa rodar nenhum SQL depois.
--
-- Caso esqueça de preencher o metadata, ou precise corrigir o
-- papel de alguém depois, use:
--
--    update public.perfis set papel = 'admin' where email = 'pessoa@exemplo.com';
-- ============================================================
