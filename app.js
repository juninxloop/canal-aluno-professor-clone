// ============================================================
// ESTADO GLOBAL
// ============================================================
let usuarioAtual = null;      // { id, nome, email, papel }
let contatoSelecionado = null; // perfil com quem estou conversando
let canalRealtime = null;      // inscrição do chat em tempo real

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
  msg.textContent = "Entrando...";

  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });

  if (error) {
    msg.textContent = "E-mail ou senha inválidos.";
    return;
  }
  msg.textContent = "";
  await carregarSessao();
});

// ============================================================
// SAIR
// ============================================================
document.getElementById("btn-sair").addEventListener("click", async () => {
  if (canalRealtime) supabase.removeChannel(canalRealtime);
  await supabase.auth.signOut();
  usuarioAtual = null;
  mostrarTela("auth");
  userInfo.classList.add("hidden");
});

// ============================================================
// AO CARREGAR A PÁGINA: verifica se já existe uma sessão ativa
// ============================================================
window.addEventListener("DOMContentLoaded", carregarSessao);

async function carregarSessao() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    mostrarTela("auth");
    return;
  }

  // Busca o perfil (nome + papel) do usuário logado
  const { data: perfil, error } = await supabase
    .from("perfis")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error || !perfil) {
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
    await carregarListaContatos();
    mostrarTela("chat");
  }
}

function mostrarTela(nome) {
  telaAuth.classList.toggle("hidden", nome !== "auth");
  telaChat.classList.toggle("hidden", nome !== "chat");
  telaAdmin.classList.toggle("hidden", nome !== "admin");
}

// ============================================================
// CHAT — lista de contatos
// Aluno vê professores. Professor vê alunos.
// ============================================================
async function carregarListaContatos() {
  const papelOposto = usuarioAtual.papel === "aluno" ? "professor" : "aluno";
  document.getElementById("contatos-titulo").textContent =
    usuarioAtual.papel === "aluno" ? "Professores" : "Alunos";

  const { data: contatos } = await supabase
    .from("perfis")
    .select("*")
    .eq("papel", papelOposto);

  const lista = document.getElementById("lista-contatos");
  lista.innerHTML = "";

  (contatos || []).forEach((contato) => {
    const item = document.createElement("div");
    item.className = "contato-item";
    item.textContent = contato.nome;
    item.addEventListener("click", () => selecionarContato(contato, item));
    lista.appendChild(item);
  });

  if (!contatos || contatos.length === 0) {
    lista.innerHTML = `<p class="hint">Nenhum ${papelOposto} cadastrado ainda.</p>`;
  }
}

async function selecionarContato(contato, elementoClicado) {
  contatoSelecionado = contato;

  document.querySelectorAll(".contato-item").forEach((el) => el.classList.remove("ativo"));
  elementoClicado.classList.add("ativo");

  document.getElementById("conversa-header").textContent = contato.nome;
  document.getElementById("input-mensagem").disabled = false;
  document.getElementById("btn-enviar").disabled = false;

  await carregarMensagens();
  inscreverRealtime();
}

// ============================================================
// CHAT — carregar histórico de mensagens entre os dois usuários
// ============================================================
async function carregarMensagens() {
  const caixa = document.getElementById("conversa-mensagens");
  caixa.innerHTML = "Carregando...";

  const { data: mensagens } = await supabase
    .from("mensagens")
    .select("*")
    .or(
      `and(remetente_id.eq.${usuarioAtual.id},destinatario_id.eq.${contatoSelecionado.id}),` +
      `and(remetente_id.eq.${contatoSelecionado.id},destinatario_id.eq.${usuarioAtual.id})`
    )
    .order("criado_em", { ascending: true });

  caixa.innerHTML = "";
  (mensagens || []).forEach(renderizarMensagem);
  caixa.scrollTop = caixa.scrollHeight;
}

function renderizarMensagem(msg) {
  const caixa = document.getElementById("conversa-mensagens");
  const bolha = document.createElement("div");
  bolha.className = "bolha " + (msg.remetente_id === usuarioAtual.id ? "minha" : "dele");
  bolha.textContent = msg.conteudo;
  caixa.appendChild(bolha);
  caixa.scrollTop = caixa.scrollHeight;
}

// ============================================================
// CHAT — enviar mensagem
// ============================================================
document.getElementById("form-mensagem").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("input-mensagem");
  const texto = input.value.trim();
  if (!texto || !contatoSelecionado) return;

  input.value = "";
  await supabase.from("mensagens").insert({
    remetente_id: usuarioAtual.id,
    destinatario_id: contatoSelecionado.id,
    conteudo: texto,
  });
  // Não precisamos renderizar manualmente aqui: a inscrição
  // realtime abaixo vai receber esta mesma mensagem de volta
  // e desenhar na tela — inclusive para o outro usuário, ao vivo.
});

// ============================================================
// CHAT — tempo real (Supabase Realtime)
// Fica "ouvindo" a tabela mensagens; quando chega uma linha nova
// relevante para esta conversa, desenha na tela na hora.
// ============================================================
function inscreverRealtime() {
  if (canalRealtime) supabase.removeChannel(canalRealtime);

  canalRealtime = supabase
    .channel("mensagens-realtime")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "mensagens" },
      (payload) => {
        const nova = payload.new;
        const ehDestaConversa =
          (nova.remetente_id === usuarioAtual.id && nova.destinatario_id === contatoSelecionado.id) ||
          (nova.remetente_id === contatoSelecionado.id && nova.destinatario_id === usuarioAtual.id);
        if (ehDestaConversa) renderizarMensagem(nova);
      }
    )
    .subscribe();
}

// ============================================================
// PAINEL ADMIN — lista todos os usuários do sistema
// ============================================================
async function carregarPainelAdmin() {
  const { data: usuarios } = await supabase
    .from("perfis")
    .select("*")
    .order("criado_em", { ascending: false });

  const corpo = document.getElementById("tabela-usuarios-body");
  corpo.innerHTML = "";

  (usuarios || []).forEach((u) => {
    const linha = document.createElement("tr");
    linha.innerHTML = `
      <td>${u.nome}</td>
      <td>${u.email}</td>
      <td>${u.papel}</td>
      <td>${new Date(u.criado_em).toLocaleString("pt-BR")}</td>
    `;
    corpo.appendChild(linha);
  });
}
