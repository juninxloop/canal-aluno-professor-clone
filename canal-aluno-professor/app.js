// ============================================================
// ESTADO GLOBAL
// ============================================================
let usuarioAtual = null;      // { id, nome, email, papel }
let canalAtual = null;         // { id, salas:{nome}, materias:{nome} } do chat aberto
let canalRealtime = null;      // inscrição do chat em tempo real
const perfisPorId = {};        // id -> { nome, papel } (para mostrar quem escreveu)
let respondendoA = null;       // professor: id do aluno que recebe a resposta particular

// ============================================================
// ELEMENTOS
// ============================================================
const telaAuth = document.getElementById("tela-auth");
const telaChat = document.getElementById("tela-chat");
const telaAdmin = document.getElementById("tela-admin");
const userInfo = document.getElementById("user-info");

// ============================================================
// LOGIN
// (Não existe fluxo de cadastro aqui — contas são criadas pelo
// admin no painel do Supabase, já com o papel correto definido.)
// ============================================================
document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const senha = document.getElementById("login-senha").value;
  const msg = document.getElementById("login-msg");
  msg.style.color = "#e53935";
  msg.textContent = "Entrando...";

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password: senha });

    if (error) {
      // Mostra o motivo real do Supabase (ex: "Invalid login credentials",
      // "Email not confirmed") em vez de esconder o problema.
      msg.textContent = "Erro ao entrar: " + error.message;
      return;
    }
    msg.textContent = "";
    await carregarSessao();
  } catch (err) {
    // Cai aqui se o problema for de conexão (URL/chave erradas no
    // supabaseClient.js, CDN bloqueado, sem internet, etc).
    console.error("Falha ao conectar no Supabase:", err);
    msg.textContent = "Não foi possível conectar ao servidor. Veja o Console (F12) para detalhes.";
  }
});

// ============================================================
// SAIR
// ============================================================
document.getElementById("btn-sair").addEventListener("click", async () => {
  if (canalRealtime) supabaseClient.removeChannel(canalRealtime);
  await supabaseClient.auth.signOut();
  usuarioAtual = null;
  mostrarTela("auth");
  userInfo.classList.add("hidden");
});

// ============================================================
// AO CARREGAR A PÁGINA: verifica se já existe uma sessão ativa
// ============================================================
window.addEventListener("DOMContentLoaded", carregarSessao);

async function carregarSessao() {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      mostrarTela("auth");
      return;
    }

    // Busca o perfil (nome + papel) do usuário logado
    const { data: perfil, error } = await supabaseClient
      .from("perfis")
      .select("*")
      .eq("id", user.id)
      .single();

    if (error || !perfil) {
      // Login funcionou, mas não existe linha em "perfis" pra esse
      // usuário (o trigger não rodou, ou o metadata do cadastro
      // estava errado). Avisa em vez de simplesmente voltar pro login.
      console.error("Perfil não encontrado para este usuário:", error);
      const msg = document.getElementById("login-msg");
      msg.style.color = "#e53935";
      msg.textContent = "Login ok, mas não existe perfil pra este usuário no banco. Veja o checklist.";
      mostrarTela("auth");
      return;
    }

    usuarioAtual = perfil;
    document.getElementById("user-nome").textContent = perfil.nome;
    document.getElementById("user-papel").textContent = perfil.papel;
    userInfo.classList.remove("hidden");

    if (perfil.papel === "admin") {
      await carregarPainelAdmin();
      mostrarTela("admin");
    } else {
      await carregarNomes();
      await carregarCanais();
      mostrarTela("chat");
    }
  } catch (err) {
    console.error("Falha ao carregar sessão:", err);
    mostrarTela("auth");
  }
}

function mostrarTela(nome) {
  telaAuth.classList.toggle("hidden", nome !== "auth");
  telaChat.classList.toggle("hidden", nome !== "chat");
  telaAdmin.classList.toggle("hidden", nome !== "admin");
}

// ============================================================
// CHAT — nomes dos usuários (para exibir o autor de cada mensagem)
// ============================================================
async function carregarNomes() {
  const { data } = await supabaseClient.from("perfis").select("id, nome, papel");
  (data || []).forEach((p) => (perfisPorId[p.id] = p));
}

// ============================================================
// CHAT — lista de canais (um por matéria)
// O banco (RLS) já devolve só os canais que o usuário pode ver:
//   aluno     -> todas as matérias da sua sala
//   professor -> as matérias que ele dá, em cada sala
// ============================================================
async function carregarCanais() {
  const ehAluno = usuarioAtual.papel === "aluno";
  document.getElementById("contatos-titulo").textContent = ehAluno ? "Matérias" : "Minhas turmas";
  document.getElementById("opcao-privada").classList.toggle("hidden", !ehAluno);

  const { data: canais, error } = await supabaseClient
    .from("canais")
    .select("id, salas(nome), materias(nome)");
  if (error) console.error("Erro ao carregar canais:", error);

  const lista = document.getElementById("lista-contatos");
  lista.innerHTML = "";
  const rotulo = (c) => (ehAluno ? c.materias.nome : `${c.salas.nome} · ${c.materias.nome}`);

  (canais || [])
    .sort((a, b) => rotulo(a).localeCompare(rotulo(b), "pt-BR"))
    .forEach((canal) => {
      const item = document.createElement("div");
      item.className = "contato-item";
      item.textContent = rotulo(canal);
      item.addEventListener("click", () => selecionarCanal(canal, rotulo(canal), item));
      lista.appendChild(item);
    });

  if (!canais || canais.length === 0) {
    lista.innerHTML = `<p class="hint">${ehAluno
      ? "Você ainda não foi colocado em uma sala. Fale com a coordenação."
      : "Você ainda não foi vinculado a nenhuma turma. Fale com a coordenação."}</p>`;
  }
}

async function selecionarCanal(canal, titulo, elementoClicado) {
  cancelarResposta();
  canalAtual = canal;
  document.querySelectorAll(".contato-item").forEach((el) => el.classList.remove("ativo"));
  elementoClicado.classList.add("ativo");

  document.getElementById("conversa-header").textContent = titulo;
  document.getElementById("input-mensagem").disabled = false;
  document.getElementById("btn-enviar").disabled = false;

  await carregarMensagens();
  inscreverRealtime();
}

// ============================================================
// CHAT — histórico do canal
// ============================================================
async function carregarMensagens() {
  const caixa = document.getElementById("conversa-mensagens");
  caixa.textContent = "Carregando...";

  const { data: mensagens } = await supabaseClient
    .from("mensagens")
    .select("*")
    .eq("canal_id", canalAtual.id)
    .order("criado_em", { ascending: true })
    .limit(200);

  caixa.innerHTML = "";
  if (!mensagens || mensagens.length === 0) {
    caixa.innerHTML = '<p class="hint">Nenhuma mensagem ainda. Seja o primeiro a escrever.</p>';
  }
  (mensagens || []).forEach(renderizarMensagem);
  caixa.scrollTop = caixa.scrollHeight;
}

function renderizarMensagem(msg) {
  const caixa = document.getElementById("conversa-mensagens");
  if (caixa.querySelector(".hint")) caixa.innerHTML = "";

  const minha = msg.remetente_id === usuarioAtual.id;
  const autor = perfisPorId[msg.remetente_id] || { nome: "Alguém", papel: "" };
  const bolha = document.createElement("div");
  bolha.className = "bolha " + (minha ? "minha" : "dele") + (msg.privada ? " privada" : "");

  let etiqueta = "";
  if (msg.privada) {
    const dest = msg.destinatario_id;
    etiqueta = dest
      ? " · 🔒 só para " + (dest === usuarioAtual.id ? "você" : (perfisPorId[dest] || {}).nome || "o aluno")
      : " · 🔒 só professor";
  }
  const topo = document.createElement("span");
  topo.className = "autor";
  topo.textContent = (minha ? "Você" : autor.nome) + etiqueta;

  const texto = document.createElement("div");
  texto.textContent = msg.conteudo;
  bolha.append(topo, texto);

  // O professor pode responder em particular a qualquer mensagem de aluno.
  if (usuarioAtual.papel === "professor" && autor.papel === "aluno") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-responder";
    btn.textContent = "Responder só para " + autor.nome.split(" ")[0];
    btn.addEventListener("click", () => iniciarResposta(msg.remetente_id));
    bolha.appendChild(btn);
  }

  caixa.appendChild(bolha);
  caixa.scrollTop = caixa.scrollHeight;
}

function iniciarResposta(alunoId) {
  respondendoA = alunoId;
  document.getElementById("aviso-texto").textContent =
    "🔒 Sua próxima mensagem vai só para " + perfisPorId[alunoId].nome;
  document.getElementById("aviso-resposta").classList.remove("hidden");
  document.getElementById("input-mensagem").focus();
}

function cancelarResposta() {
  respondendoA = null;
  document.getElementById("aviso-resposta").classList.add("hidden");
}
document.getElementById("btn-cancelar-resposta").addEventListener("click", cancelarResposta);

// ============================================================
// CHAT — enviar mensagem
//   aluno: pública, ou privada (checkbox "Só professor")
//   professor: pública, ou privada para um aluno (botão "Responder só para...")
// ============================================================
document.getElementById("form-mensagem").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("input-mensagem");
  const texto = input.value.trim();
  if (!texto || !canalAtual) return;

  const ehAluno = usuarioAtual.papel === "aluno";
  const privada = ehAluno ? document.getElementById("check-privada").checked : !!respondendoA;

  input.value = "";
  const { error } = await supabaseClient.from("mensagens").insert({
    canal_id: canalAtual.id,
    remetente_id: usuarioAtual.id,
    conteudo: texto,
    privada,
    destinatario_id: !ehAluno && respondendoA ? respondendoA : null,
  });
  if (error) {
    console.error("Erro ao enviar:", error);
    input.value = texto;
    alert("Não foi possível enviar: " + error.message);
    return;
  }
  if (!ehAluno) cancelarResposta();
  // A mensagem aparece pelo realtime (abaixo), para quem tem permissão de ver.
});

// ============================================================
// CHAT — tempo real: ouve só o canal aberto. O RLS do banco também
// filtra aqui, então mensagens privadas não chegam para os colegas.
// ============================================================
function inscreverRealtime() {
  if (canalRealtime) supabaseClient.removeChannel(canalRealtime);

  canalRealtime = supabaseClient
    .channel("canal-" + canalAtual.id)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "mensagens", filter: `canal_id=eq.${canalAtual.id}` },
      (payload) => renderizarMensagem(payload.new)
    )
    .subscribe();
}

// ============================================================
// PAINEL ADMIN — alunos em salas e professores em matérias
// (as permissões de escrita estão no schema.sql; só o admin passa)
// ============================================================
function avisoAdmin(texto, erro) {
  const el = document.getElementById("admin-msg");
  el.style.color = erro ? "#d32f2f" : "#1a7f4b";
  el.textContent = texto;
}

function opcoes(select, itens, vazio) {
  select.innerHTML = "";
  if (vazio) select.add(new Option(vazio, ""));
  itens.forEach((i) => select.add(new Option(i.nome, i.id)));
}

function celula(linha, conteudo) {
  const td = document.createElement("td");
  if (conteudo instanceof Node) td.appendChild(conteudo);
  else td.textContent = conteudo;
  linha.appendChild(td);
}

async function carregarPainelAdmin() {
  const ler = (tabela, ordem) => supabaseClient.from(tabela).select("*").order(ordem);
  const [u, s, m, t] = await Promise.all([
    ler("perfis", "nome"), ler("salas", "nome"), ler("materias", "nome"),
    supabaseClient.from("professor_turmas").select("*"),
  ]);
  const usuarios = u.data || [], salas = s.data || [], materias = m.data || [], turmas = t.data || [];
  const achar = (lista, id) => (lista.find((x) => x.id === id) || {}).nome || "?";

  // --- Alunos e salas
  const corpo = document.getElementById("tabela-usuarios-body");
  corpo.innerHTML = "";
  usuarios.forEach((usr) => {
    const linha = document.createElement("tr");
    let sala = "—";
    if (usr.papel === "aluno") {
      sala = document.createElement("select");
      opcoes(sala, salas, "Sem sala");
      sala.value = usr.sala_id ?? "";
      sala.addEventListener("change", async () => {
        const { data, error } = await supabaseClient
          .from("perfis")
          .update({ sala_id: sala.value ? Number(sala.value) : null })
          .eq("id", usr.id)
          .select();
        const falhou = error || !data || data.length === 0;
        avisoAdmin(falhou ? "Não foi possível salvar: " + (error ? error.message : "sem permissão")
                          : `${usr.nome} agora está em: ${sala.selectedOptions[0].text}.`, falhou);
      });
    }
    celula(linha, usr.nome);
    celula(linha, usr.email);
    celula(linha, usr.papel);
    celula(linha, sala);
    corpo.appendChild(linha);
  });

  // --- Professores e turmas
  opcoes(document.getElementById("sel-prof"), usuarios.filter((x) => x.papel === "professor"));
  opcoes(document.getElementById("sel-sala"), salas);
  opcoes(document.getElementById("sel-materia"), materias);

  document.getElementById("form-vinculo").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabaseClient.from("professor_turmas").insert({
      professor_id: document.getElementById("sel-prof").value,
      sala_id: Number(document.getElementById("sel-sala").value),
      materia_id: Number(document.getElementById("sel-materia").value),
    });
    if (error) {
      avisoAdmin(error.code === "23505" ? "Esse vínculo já existe." : "Erro: " + error.message, true);
      return;
    }
    await carregarPainelAdmin();
    avisoAdmin("Vínculo criado.", false);
  };

  const corpoTurmas = document.getElementById("tabela-turmas-body");
  corpoTurmas.innerHTML = "";
  turmas.forEach((v) => {
    const linha = document.createElement("tr");
    const remover = document.createElement("button");
    remover.type = "button";
    remover.className = "btn-remover";
    remover.textContent = "Remover";
    remover.addEventListener("click", async () => {
      const { error } = await supabaseClient.from("professor_turmas").delete().match(v);
      if (error) return avisoAdmin("Erro: " + error.message, true);
      await carregarPainelAdmin();
      avisoAdmin("Vínculo removido.", false);
    });
    celula(linha, achar(usuarios, v.professor_id));
    celula(linha, achar(salas, v.sala_id));
    celula(linha, achar(materias, v.materia_id));
    celula(linha, remover);
    corpoTurmas.appendChild(linha);
  });
  if (turmas.length === 0) {
    corpoTurmas.innerHTML = '<tr><td colspan="4" class="hint">Nenhum professor vinculado ainda.</td></tr>';
  }
}
