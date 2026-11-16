-- ============================================================
-- CANAL ALUNO PROFESSOR — Schema v2: salas + um chat por matéria
-- Cole no SQL Editor do Supabase e clique em "Run".
-- Serve para projeto novo E para o projeto atual (pode rodar de novo).
-- ATENÇÃO: apaga as mensagens antigas (o modelo antigo era 1 a 1).
-- ============================================================

-- 1) PERFIS (papel de cada usuário; senhas ficam em auth.users)
create table if not exists public.perfis (
  id uuid primary key references auth.users (id) on delete cascade,
  nome text not null,
  email text not null,
  papel text not null check (papel in ('aluno', 'professor', 'admin')),
  criado_em timestamptz default now()
);

-- 2) SALAS, MATÉRIAS E CANAIS (1 canal = 1 matéria dentro de 1 sala)
create table if not exists public.salas (
  id bigserial primary key,
  nome text not null unique
);
create table if not exists public.materias (
  id bigserial primary key,
  nome text not null unique
);
create table if not exists public.canais (
  id bigserial primary key,
  sala_id bigint not null references public.salas (id) on delete cascade,
  materia_id bigint not null references public.materias (id) on delete cascade,
  unique (sala_id, materia_id)
);

-- Aluno pertence a UMA sala.
alter table public.perfis
  add column if not exists sala_id bigint references public.salas (id) on delete set null;

-- Professor dá uma matéria em uma sala (pode ter várias linhas).
create table if not exists public.professor_turmas (
  professor_id uuid not null references public.perfis (id) on delete cascade,
  sala_id bigint not null references public.salas (id) on delete cascade,
  materia_id bigint not null references public.materias (id) on delete cascade,
  primary key (professor_id, sala_id, materia_id)
);

-- 3) MENSAGENS (de um canal; "privada" = só o professor do canal vê)
drop table if exists public.mensagens cascade;
create table public.mensagens (
  id bigserial primary key,
  canal_id bigint not null references public.canais (id) on delete cascade,
  remetente_id uuid not null references public.perfis (id) on delete cascade,
  conteudo text not null check (char_length(conteudo) between 1 and 2000),
  privada boolean not null default false,
  criado_em timestamptz default now()
);
create index on public.mensagens (canal_id, criado_em);

-- 4) DADOS INICIAIS: grade do 1º ano do Ensino Médio (protótipo)
insert into public.salas (nome) values ('1º A'), ('1º B') on conflict do nothing;
insert into public.materias (nome) values
  ('Língua Portuguesa'), ('Matemática'), ('Biologia'), ('Física'),
  ('Química'), ('História'), ('Geografia'), ('Filosofia'),
  ('Sociologia'), ('Língua Inglesa'), ('Educação Física'), ('Arte')
on conflict do nothing;
insert into public.canais (sala_id, materia_id)
  select s.id, m.id from public.salas s cross join public.materias m
on conflict do nothing;

-- 5) TRIGGER: cria o perfil quando o admin cria o usuário no Auth
create or replace function public.lidar_novo_usuario()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfis (id, nome, email, papel)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'nome', 'Sem nome'),
          new.email,
          coalesce(new.raw_user_meta_data->>'papel', 'aluno'));
  return new;
end;
$$;
drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute procedure public.lidar_novo_usuario();

-- 6) FUNÇÕES DE PERMISSÃO (usadas pelo RLS)
-- Professor deste canal? (dá a matéria do canal na sala do canal)
create or replace function public.e_professor_do_canal(p_canal bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.canais c
    join public.professor_turmas t
      on t.sala_id = c.sala_id and t.materia_id = c.materia_id
    where c.id = p_canal and t.professor_id = auth.uid());
$$;

-- Pode entrar no canal? Aluno da sala do canal OU professor do canal.
create or replace function public.pode_ver_canal(p_canal bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select public.e_professor_do_canal(p_canal) or exists (
    select 1 from public.canais c
    join public.perfis p on p.sala_id = c.sala_id
    where c.id = p_canal and p.id = auth.uid() and p.papel = 'aluno');
$$;

create or replace function public.meu_papel()
returns text language sql stable security definer set search_path = public as $$
  select papel from public.perfis where id = auth.uid();
$$;

-- 7) SEGURANÇA — Row Level Security
alter table public.perfis enable row level security;
alter table public.salas enable row level security;
alter table public.materias enable row level security;
alter table public.canais enable row level security;
alter table public.professor_turmas enable row level security;
alter table public.mensagens enable row level security;

drop policy if exists "perfis_select_autenticados" on public.perfis;
create policy "perfis_select_autenticados" on public.perfis
  for select to authenticated using (true);

-- Removida de propósito: antes, qualquer usuário podia editar o PRÓPRIO
-- perfil (inclusive o papel e a sala). Agora só o admin altera pelo painel.
drop policy if exists "perfis_update_proprio" on public.perfis;

drop policy if exists "salas_select" on public.salas;
create policy "salas_select" on public.salas for select to authenticated using (true);
drop policy if exists "materias_select" on public.materias;
create policy "materias_select" on public.materias for select to authenticated using (true);

drop policy if exists "canais_select" on public.canais;
create policy "canais_select" on public.canais
  for select to authenticated using (public.pode_ver_canal(id));

drop policy if exists "turmas_select_proprias" on public.professor_turmas;
create policy "turmas_select_proprias" on public.professor_turmas
  for select to authenticated using (professor_id = auth.uid());

-- LER: precisa ver o canal; mensagem privada só para quem enviou
-- ou para o professor do canal. Colegas não veem.
drop policy if exists "mensagens_select" on public.mensagens;
create policy "mensagens_select" on public.mensagens
  for select to authenticated using (
    public.pode_ver_canal(canal_id)
    and (not privada
         or remetente_id = auth.uid()
         or public.e_professor_do_canal(canal_id)));

-- ENVIAR: como si mesmo, em canal que pode ver; privada só se for aluno.
drop policy if exists "mensagens_insert" on public.mensagens;
create policy "mensagens_insert" on public.mensagens
  for insert to authenticated with check (
    remetente_id = auth.uid()
    and public.pode_ver_canal(canal_id)
    and (not privada or public.meu_papel() = 'aluno'));

grant select on public.perfis, public.salas, public.materias,
  public.canais, public.professor_turmas to authenticated;
grant select, insert on public.mensagens to authenticated;
grant usage, select on sequence public.mensagens_id_seq to authenticated;

-- 8) REALTIME (o RLS acima também vale para as mensagens ao vivo)
alter publication supabase_realtime add table public.mensagens;

-- ============================================================
-- COMO CRIAR USUÁRIOS (não existe cadastro público no site)
-- Painel: Authentication > Users > Add user, com "Auto Confirm User"
-- e User Metadata: { "nome": "Maria Silva", "papel": "professor" }
--
-- COMO VINCULAR (rode no SQL Editor depois de criar o usuário):
--   -- aluno em uma sala
--   update public.perfis set sala_id = (select id from public.salas where nome = '1º A')
--    where email = 'ana.souza@escola.com';
--   -- professor dando uma matéria em uma sala
--   insert into public.professor_turmas (professor_id, sala_id, materia_id)
--   select p.id, s.id, m.id from public.perfis p, public.salas s, public.materias m
--    where p.email = 'carla.mendes@escola.com' and s.nome = '1º A' and m.nome = 'Matemática';
-- ============================================================
