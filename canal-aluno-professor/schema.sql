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

-- 3) MENSAGENS (de um canal)
--   privada = true e destinatario_id vazio -> aluno falando só com o professor
--   privada = true e destinatario_id = aluno -> professor respondendo em particular
--                                               a UMA mensagem privada daquele aluno
--   resposta_a = id da mensagem que está sendo respondida (réplica pública ou privada)
-- Só recria a tabela se ela ainda for do modelo antigo (1 a 1).
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'mensagens')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'mensagens' and column_name = 'canal_id')
  then drop table public.mensagens cascade; end if;
end $$;
create table if not exists public.mensagens (
  id bigserial primary key,
  canal_id bigint not null references public.canais (id) on delete cascade,
  remetente_id uuid not null references public.perfis (id) on delete cascade,
  conteudo text not null check (char_length(conteudo) between 1 and 2000),
  privada boolean not null default false,
  criado_em timestamptz default now()
);
alter table public.mensagens
  add column if not exists destinatario_id uuid references public.perfis (id) on delete cascade;
create index if not exists mensagens_canal_idx on public.mensagens (canal_id, criado_em);

-- Réplica: aponta para a mensagem respondida. Se a original for apagada, vira null.
alter table public.mensagens
  add column if not exists resposta_a bigint references public.mensagens (id) on delete set null;
create index if not exists mensagens_resposta_idx on public.mensagens (resposta_a);

-- MENSAGENS APAGADAS: cópia arquivada de tudo que foi apagado no chat.
-- Ninguém lê esta tabela pelo site (sem policy de leitura): só o dono do projeto,
-- pelo painel do Supabase. Se o usuário ou o canal for excluído, a cópia vai junto.
create table if not exists public.mensagens_apagadas (
  id bigserial primary key,
  mensagem_id bigint not null,
  canal_id bigint not null references public.canais (id) on delete cascade,
  remetente_id uuid not null references public.perfis (id) on delete cascade,
  destinatario_id uuid references public.perfis (id) on delete cascade,
  conteudo text not null,
  privada boolean not null,
  resposta_a bigint,
  criada_em timestamptz,
  apagada_em timestamptz not null default now(),
  apagada_por uuid references public.perfis (id) on delete set null
);
create index if not exists mensagens_apagadas_canal_idx on public.mensagens_apagadas (canal_id, apagada_em);
alter table public.mensagens_apagadas enable row level security;
revoke all on public.mensagens_apagadas from anon, authenticated;

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

-- O aluno (p_aluno) pertence à sala deste canal?
create or replace function public.aluno_na_sala_do_canal(p_aluno uuid, p_canal bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.canais c
    join public.perfis p on p.sala_id = c.sala_id
    where c.id = p_canal and p.id = p_aluno and p.papel = 'aluno');
$$;

-- Autor de uma mensagem PRIVADA de aluno para o professor (sem destinatário) deste canal.
-- Usada para validar a réplica privada do professor. Devolve null se não existir.
create or replace function public.autor_de_privada_de_aluno(p_msg bigint, p_canal bigint)
returns uuid language sql stable security definer set search_path = public as $$
  select m.remetente_id from public.mensagens m
  where m.id = p_msg and m.canal_id = p_canal
    and m.privada and m.destinatario_id is null;
$$;

-- A mensagem é pública e é deste canal? (só dá para fazer réplica pública a mensagem pública)
create or replace function public.mensagem_publica_do_canal(p_msg bigint, p_canal bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.mensagens m
    where m.id = p_msg and m.canal_id = p_canal and not m.privada);
$$;

-- APAGAR: guarda a cópia em mensagens_apagadas e remove da conversa, tudo numa
-- transação. Pode apagar: quem escreveu, ou o professor do canal.
create or replace function public.apagar_mensagem(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare m public.mensagens%rowtype;
begin
  select * into m from public.mensagens where id = p_id;
  if not found then
    raise exception 'mensagem_inexistente';
  end if;
  if not (m.remetente_id = auth.uid() or public.e_professor_do_canal(m.canal_id)) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  insert into public.mensagens_apagadas
    (mensagem_id, canal_id, remetente_id, destinatario_id, conteudo, privada, resposta_a, criada_em, apagada_por)
  values
    (m.id, m.canal_id, m.remetente_id, m.destinatario_id, m.conteudo, m.privada, m.resposta_a, m.criado_em, auth.uid());
  delete from public.mensagens where id = p_id;
end;
$$;
revoke all on function public.apagar_mensagem(bigint) from public, anon;
grant execute on function public.apagar_mensagem(bigint) to authenticated;

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

-- LER: precisa ver o canal. Mensagem privada só aparece para quem enviou,
-- para o destinatário (aluno que recebeu resposta) e para o professor do canal.
drop policy if exists "mensagens_select" on public.mensagens;
create policy "mensagens_select" on public.mensagens
  for select to authenticated using (
    public.pode_ver_canal(canal_id)
    and (not privada
         or remetente_id = auth.uid()
         or destinatario_id = auth.uid()
         or public.e_professor_do_canal(canal_id)));

-- ENVIAR: como si mesmo, em canal que pode ver. Formas válidas:
--   1) pública (pode ser réplica a uma mensagem pública do mesmo canal)
--   2) privada de aluno para o professor (sem destinatário, não é réplica)
--   3) privada de professor: SÓ como réplica a uma mensagem privada de aluno,
--      e o destinatário é o autor dessa mensagem (professor não inicia privado do zero)
drop policy if exists "mensagens_insert" on public.mensagens;
create policy "mensagens_insert" on public.mensagens
  for insert to authenticated with check (
    remetente_id = auth.uid()
    and public.pode_ver_canal(canal_id)
    and (
      (not privada and destinatario_id is null
        and (resposta_a is null or public.mensagem_publica_do_canal(resposta_a, canal_id)))
      or (privada and public.meu_papel() = 'aluno'
        and destinatario_id is null and resposta_a is null)
      or (privada and public.meu_papel() = 'professor'
        and public.e_professor_do_canal(canal_id)
        and resposta_a is not null
        and destinatario_id is not null
        and destinatario_id = public.autor_de_privada_de_aluno(resposta_a, canal_id)
        and public.aluno_na_sala_do_canal(destinatario_id, canal_id))
    ));

-- ADMIN: coloca alunos em salas e vincula professores a matérias.
-- (pelo site; só a coluna sala_id é liberada, o papel ninguém altera)
drop policy if exists "perfis_update_admin" on public.perfis;
create policy "perfis_update_admin" on public.perfis
  for update to authenticated
  using (public.meu_papel() = 'admin') with check (public.meu_papel() = 'admin');
drop policy if exists "turmas_admin" on public.professor_turmas;
create policy "turmas_admin" on public.professor_turmas
  for all to authenticated
  using (public.meu_papel() = 'admin') with check (public.meu_papel() = 'admin');

grant select on public.perfis, public.salas, public.materias,
  public.canais, public.professor_turmas to authenticated;
grant update (sala_id) on public.perfis to authenticated;
grant insert, delete on public.professor_turmas to authenticated;
grant select, insert on public.mensagens to authenticated;
grant usage, select on sequence public.mensagens_id_seq to authenticated;

-- 8) REALTIME (o RLS acima também vale para as mensagens ao vivo)
do $$ begin
  alter publication supabase_realtime add table public.mensagens;
exception when duplicate_object then null;
end $$;

-- ============================================================
-- COMO CRIAR USUÁRIOS (não existe cadastro público no site)
-- Painel: Authentication > Users > Add user, com "Auto Confirm User"
-- e User Metadata: { "nome": "Maria Silva", "papel": "professor" }
--
-- COMO VINCULAR: pelo painel do admin no site. Ou, por SQL:
--   -- aluno em uma sala
--   update public.perfis set sala_id = (select id from public.salas where nome = '1º A')
--    where email = 'ana.souza@escola.com';
--   -- professor dando uma matéria em uma sala
--   insert into public.professor_turmas (professor_id, sala_id, materia_id)
--   select p.id, s.id, m.id from public.perfis p, public.salas s, public.materias m
--    where p.email = 'carla.mendes@escola.com' and s.nome = '1º A' and m.nome = 'Matemática';
-- ============================================================
