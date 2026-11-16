// ============================================================
// ESTADO GLOBAL
// ============================================================
let usuarioAtual = null;      // { id, nome, email, papel }
let canalAtual = null;         // { id, salas:{nome}, materias:{nome} } do chat aberto
let canalRealtime = null;      // inscrição do chat em tempo real
const nomes = {};              // id do usuário -> nome (para mostrar quem escreveu)

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
  const { data } = await supabaseClient.from("perfis").select("id, nome");
  (data || []).forEach((p) => (nomes[p.id] = p.nome));
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
  const bolha = document.createElement("div");
  bolha.className = "bolha " + (minha ? "minha" : "dele") + (msg.privada ? " privada" : "");

  const autor = document.createElement("span");
  autor.className = "autor";
  autor.textContent = (minha ? "Você" : nomes[msg.remetente_id] || "Alguém") +
    (msg.privada ? " · 🔒 só professor" : "");

  const texto = document.createElement("div");
  texto.textContent = msg.conteudo;

  bolha.append(autor, texto);
  caixa.appendChild(bolha);
  caixa.scrollTop = caixa.scrollHeight;
}

// ============================================================
// CHAT — enviar mensagem (aluno pode marcar "só para o professor")
// ============================================================
document.getElementById("form-mensagem").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("input-mensagem");
  const texto = input.value.trim();
  if (!texto || !canalAtual) return;

  const privada = usuarioAtual.papel === "aluno" && document.getElementById("check-privada").checked;
  input.value = "";
  const { error } = await supabaseClient.from("mensagens").insert({
    canal_id: canalAtual.id,
    remetente_id: usuarioAtual.id,
    conteudo: texto,
    privada,
  });
  if (error) {
    console.error("Erro ao enviar:", error);
    input.value = texto;
    alert("Não foi possível enviar: " + error.message);
  }
  // A mensagem aparece pelo realtime (abaixo), para todos do canal.
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
// PAINEL ADMIN — lista todos os usuários do sistema
// ============================================================
async function carregarPainelAdmin() {
  const { data: usuarios } = await supabaseClient
    .from("perfis")
    .select("*")
    .order("criado_em", { ascending: false });

  const corpo = document.getElementById("tabela-usuarios-body");
  corpo.innerHTML = "";

  (usuarios || []).forEach((u) => {
    const linha = document.createElement("tr");
    [u.nome, u.email, u.papel, new Date(u.criado_em).toLocaleString("pt-BR")].forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v;
      linha.appendChild(td);
    });
    corpo.appendChild(linha);
  });
}
