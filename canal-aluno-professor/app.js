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
const formLogin = document.getElementById("form-login");
const botaoLogin = document.getElementById("btn-login");
const senhaLogin = document.getElementById("login-senha");
const mensagemLogin = document.getElementById("login-msg");

function mensagemErroLogin(error) {
  const texto = (error && error.message || "").toLowerCase();
  if (texto.includes("invalid login") || texto.includes("invalid_credentials")) return "E-mail ou senha incorretos. Confira os dados e tente novamente.";
  if (texto.includes("email not confirmed")) return "Seu e-mail ainda não foi confirmado. Peça ajuda à coordenação.";
  if (texto.includes("too many requests")) return "Muitas tentativas em sequência. Aguarde um pouco e tente novamente.";
  return "Não foi possível entrar agora. Verifique sua conexão e tente novamente.";
}

formLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const senha = senhaLogin.value;
  mensagemLogin.classList.remove("success");
  mensagemLogin.textContent = "";
  if (!email || !senha) {
    mensagemLogin.textContent = "Informe seu e-mail e sua senha para continuar.";
    return;
  }
  botaoLogin.disabled = true;
  botaoLogin.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span><span>Entrando...</span>';
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password: senha });
    if (error) {
      mensagemLogin.textContent = mensagemErroLogin(error);
      return;
    }
    mensagemLogin.textContent = "";
    await carregarSessao();
  } catch (err) {
    console.error("Falha ao conectar no Supabase:", err);
    mensagemLogin.textContent = "Não foi possível conectar ao servidor. Verifique sua internet e tente novamente.";
  } finally {
    botaoLogin.disabled = false;
    botaoLogin.innerHTML = '<span>Entrar na plataforma</span><span class="button-arrow" aria-hidden="true">→</span>';
  }
});

document.getElementById("btn-ver-senha").addEventListener("click", () => {
  const visivel = senhaLogin.type === "password";
  senhaLogin.type = visivel ? "text" : "password";
  const botao = document.getElementById("btn-ver-senha");
  botao.setAttribute("aria-label", visivel ? "Ocultar senha" : "Mostrar senha");
  botao.setAttribute("aria-pressed", String(visivel));
});

document.getElementById("btn-esqueci").addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  if (!email) {
    mensagemLogin.textContent = "Digite seu e-mail no campo acima para receber o link de recuperação.";
    document.getElementById("login-email").focus();
    return;
  }
  const link = document.getElementById("btn-esqueci");
  link.disabled = true;
  mensagemLogin.textContent = "Enviando link de recuperação...";
  try {
    const urlRedirecionamento = new URL("definir-senha.html", window.location.href).href;
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: urlRedirecionamento });
    if (error) throw error;
    mensagemLogin.classList.add("success");
    mensagemLogin.textContent = "Se o endereço estiver cadastrado, você receberá um e-mail com as instruções para redefinir sua senha.";
  } catch (error) {
    mensagemLogin.classList.remove("success");
    mensagemLogin.textContent = "Não foi possível solicitar a recuperação agora. Tente novamente mais tarde.";
  } finally {
    link.disabled = false;
  }
});

// ============================================================
// LIMPAR INTERFACE — zera tudo que era do usuário anterior
// (conversa aberta, mensagens na tela, listas, filtros e cache)
// Roda ao sair e antes de carregar a sessão de outra pessoa.
// ============================================================
const ESTADO_INICIAL_CHAT = document.getElementById("conversa-mensagens").innerHTML;

function limparInterface() {
  if (canalRealtime) {
    supabaseClient.removeChannel(canalRealtime);
    canalRealtime = null;
  }
  canalAtual = null;
  respondendoA = null;
  Object.keys(perfisPorId).forEach((id) => delete perfisPorId[id]);
  usuariosAdminCache = [];
  salasAdminCache = [];
  paginaUsuarios = 1;

  document.getElementById("conversa-mensagens").innerHTML = ESTADO_INICIAL_CHAT;
  document.getElementById("conversa-titulo").textContent = "Selecione uma matéria";
  document.getElementById("lista-contatos").innerHTML = "";
  document.getElementById("aviso-resposta").classList.add("hidden");
  document.getElementById("check-privada").checked = false;
  document.getElementById("input-mensagem").value = "";
  document.getElementById("input-mensagem").disabled = true;
  document.getElementById("btn-enviar").disabled = true;

  ["busca-usuarios", "filtro-papel", "filtro-sala"].forEach((id) => {
    const campo = document.getElementById(id);
    if (campo) campo.value = "";
  });
  document.getElementById("login-senha").value = "";
  document.getElementById("login-msg").textContent = "";
}

// ============================================================
// SAIR
// ============================================================
document.getElementById("btn-sair").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  usuarioAtual = null;
  limparInterface();
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

    limparInterface();
    usuarioAtual = perfil;
    document.getElementById("user-nome").textContent = perfil.nome;
    document.getElementById("user-papel").textContent = perfil.papel;
    document.getElementById("user-avatar").textContent = (perfil.nome || "U").trim().charAt(0).toUpperCase();
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
      const iconesMateria = { "Língua Portuguesa": "文", "Matemática": "∑", "Biologia": "❋", "Física": "⚛", "Química": "⚗", "História": "◷", "Geografia": "◎", "Filosofia": "◇", "Sociologia": "♧", "Língua Inglesa": "A", "Educação Física": "↗", "Arte": "✦" };
      item.textContent = (iconesMateria[canal.materias.nome] || "•") + "  " + rotulo(canal);
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

  document.getElementById("conversa-titulo").textContent = titulo;
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
  caixa.innerHTML = '<p class="hint">Carregando mensagens...</p>';

  const { data: mensagens } = await supabaseClient
    .from("mensagens")
    .select("*")
    .eq("canal_id", canalAtual.id)
    .order("criado_em", { ascending: true })
    .limit(200);

  caixa.innerHTML = "";
  if (!mensagens || mensagens.length === 0) {
    caixa.innerHTML = '<div class="empty-state"><div class="empty-art"><span class="empty-bubble bubble-a">•••</span><span class="empty-bubble bubble-b">✦</span><span class="empty-book">▱</span></div><h3>Esta conversa está começando</h3><p>Envie a primeira mensagem para iniciar a troca de conhecimento.</p></div>';
  }
  (mensagens || []).forEach(renderizarMensagem);
  caixa.scrollTop = caixa.scrollHeight;
}

function renderizarMensagem(msg) {
  const caixa = document.getElementById("conversa-mensagens");
  if (caixa.querySelector(".hint") || caixa.querySelector(".empty-state")) caixa.innerHTML = "";

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
  const avatar = document.createElement("span");
  avatar.className = "avatar-mini";
  avatar.textContent = (minha ? (usuarioAtual.nome || "V") : (autor.nome || "A")).trim().charAt(0).toUpperCase();
  const nomeAutor = document.createElement("span");
  nomeAutor.textContent = (minha ? "Você" : autor.nome) + etiqueta;
  topo.append(avatar, nomeAutor);

  const texto = document.createElement("div");
  texto.textContent = msg.conteudo;
  const hora = document.createElement("time");
  hora.className = "mensagem-hora";
  const dataMensagem = msg.criado_em ? new Date(msg.criado_em) : new Date();
  hora.dateTime = dataMensagem.toISOString();
  hora.textContent = dataMensagem.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  bolha.append(topo, texto, hora);

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

// Traduz o erro do Supabase em uma mensagem que ajuda a achar o problema
function mensagemErroEnvio(error) {
  const m = (error.message || "").toLowerCase();
  if (m.includes("fetch") || m.includes("network")) {
    return "Não foi possível enviar. Confira sua conexão e tente novamente.";
  }
  if (error.code === "42501" || m.includes("row-level security") || m.includes("permission denied")) {
    return "Você não tem permissão para escrever neste chat. Fale com a coordenação.";
  }
  if (error.code === "PGRST204" || m.includes("schema cache") || m.includes("column")) {
    return "O banco de dados está desatualizado. Peça ao administrador para rodar o schema.sql mais recente.";
  }
  return "Não foi possível enviar agora. Tente novamente em instantes.";
}

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

  const botaoEnviar = document.getElementById("btn-enviar");
  botaoEnviar.disabled = true;
  botaoEnviar.innerHTML = "Enviando...";
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
    botaoEnviar.disabled = false;
    botaoEnviar.innerHTML = '<span>Enviar</span><span aria-hidden="true">↑</span>';
    const aviso = document.getElementById("aviso-resposta");
    document.getElementById("aviso-texto").textContent = mensagemErroEnvio(error);
    aviso.classList.remove("hidden");
    return;
  }
  botaoEnviar.disabled = false;
  botaoEnviar.innerHTML = '<span>Enviado</span><span aria-hidden="true">✓</span>';
  window.setTimeout(() => { if (botaoEnviar.isConnected) botaoEnviar.innerHTML = '<span>Enviar</span><span aria-hidden="true">↑</span>'; }, 1200);
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

let usuariosAdminCache = [];
let salasAdminCache = [];
let paginaUsuarios = 1;
const USUARIOS_POR_PAGINA = 8;

function renderizarUsuariosAdmin() {
  const busca = (document.getElementById("busca-usuarios").value || "").trim().toLocaleLowerCase("pt-BR");
  const papel = document.getElementById("filtro-papel").value;
  const salaFiltro = document.getElementById("filtro-sala").value;
  const filtrados = usuariosAdminCache.filter((usr) => {
    const correspondeBusca = !busca || (usr.nome || "").toLocaleLowerCase("pt-BR").includes(busca) || (usr.email || "").toLocaleLowerCase("pt-BR").includes(busca);
    const correspondePapel = !papel || usr.papel === papel;
    const correspondeSala = !salaFiltro || (salaFiltro === "sem-sala" ? usr.papel === "aluno" && !usr.sala_id : String(usr.sala_id || "") === salaFiltro);
    return correspondeBusca && correspondePapel && correspondeSala;
  });
  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / USUARIOS_POR_PAGINA));
  paginaUsuarios = Math.min(paginaUsuarios, totalPaginas);
  const inicio = (paginaUsuarios - 1) * USUARIOS_POR_PAGINA;
  const pagina = filtrados.slice(inicio, inicio + USUARIOS_POR_PAGINA);
  const corpo = document.getElementById("tabela-usuarios-body");
  corpo.innerHTML = "";
  pagina.forEach((usr) => {
    const linha = document.createElement("tr");
    const sala = usr.papel === "aluno" ? document.createElement("select") : "—";
    if (usr.papel === "aluno") {
      if (!usr.sala_id) linha.classList.add("linha-sem-sala");
      opcoes(sala, salasAdminCache, "Sem sala");
      sala.value = usr.sala_id ?? "";
      sala.setAttribute("aria-label", "Sala de " + usr.nome);
      if (!usr.sala_id) sala.classList.add("sem-sala");
      sala.addEventListener("change", async () => {
        sala.disabled = true;
        const { data, error } = await supabaseClient.from("perfis").update({ sala_id: sala.value ? Number(sala.value) : null }).eq("id", usr.id).select();
        const falhou = error || !data || data.length === 0;
        if (!falhou) {
          usr.sala_id = sala.value ? Number(sala.value) : null;
          avisoAdmin(`${usr.nome} foi atualizado(a) para ${sala.selectedOptions[0].text}.`, false);
        } else {
          avisoAdmin("Não foi possível atualizar a sala. Verifique as permissões e tente novamente.", true);
          sala.value = usr.sala_id ?? "";
        }
        sala.disabled = false;
        sala.classList.toggle("sem-sala", !usr.sala_id);
        linha.classList.toggle("linha-sem-sala", !usr.sala_id);
        atualizarFiltroSalas();
      });
    }
    celula(linha, usr.nome || "Sem nome");
    celula(linha, usr.email || "—");
    const perfil = document.createElement("span");
    perfil.className = "role-badge role-" + usr.papel;
    perfil.textContent = usr.papel;
    celula(linha, perfil);
    celula(linha, sala);
    corpo.appendChild(linha);
  });
  if (!pagina.length) corpo.innerHTML = '<tr><td colspan="4" class="hint">Nenhum usuário encontrado com esses filtros.</td></tr>';
  document.getElementById("usuarios-contagem").textContent = `${filtrados.length} de ${usuariosAdminCache.length} usuários`;
  const paginacao = document.getElementById("usuarios-paginacao");
  paginacao.innerHTML = "";
  const anterior = document.createElement("button");
  anterior.type = "button"; anterior.textContent = "‹"; anterior.disabled = paginaUsuarios <= 1;
  anterior.setAttribute("aria-label", "Página anterior");
  anterior.addEventListener("click", () => { paginaUsuarios--; renderizarUsuariosAdmin(); });
  paginacao.appendChild(anterior);
  for (let i = 1; i <= totalPaginas; i++) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = String(i); b.classList.toggle("active", i === paginaUsuarios); b.setAttribute("aria-label", "Página " + i);
    b.addEventListener("click", () => { paginaUsuarios = i; renderizarUsuariosAdmin(); });
    paginacao.appendChild(b);
  }
  const proxima = document.createElement("button");
  proxima.type = "button"; proxima.textContent = "›"; proxima.disabled = paginaUsuarios >= totalPaginas;
  proxima.setAttribute("aria-label", "Próxima página");
  proxima.addEventListener("click", () => { paginaUsuarios++; renderizarUsuariosAdmin(); });
  paginacao.appendChild(proxima);
}

function atualizarFiltroSalas() {
  const filtro = document.getElementById("filtro-sala");
  const valorAtual = filtro.value;
  filtro.innerHTML = '<option value="">Todas as salas</option><option value="sem-sala">Sem sala</option>';
  salasAdminCache.forEach((s) => filtro.add(new Option(s.nome, String(s.id))));
  filtro.value = [...filtro.options].some((o) => o.value === valorAtual) ? valorAtual : "";
}

async function carregarPainelAdmin() {
  const ler = (tabela, ordem) => supabaseClient.from(tabela).select("*").order(ordem);
  const [u, s, m, t] = await Promise.all([
    ler("perfis", "nome"), ler("salas", "nome"), ler("materias", "nome"),
    supabaseClient.from("professor_turmas").select("*"),
  ]);
  const usuarios = u.data || [], salas = s.data || [], materias = m.data || [], turmas = t.data || [];
  usuariosAdminCache = usuarios;
  salasAdminCache = salas;
  atualizarFiltroSalas();
  ["busca-usuarios", "filtro-papel", "filtro-sala"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el.dataset.bound) {
      el.addEventListener(id === "busca-usuarios" ? "input" : "change", () => { paginaUsuarios = 1; renderizarUsuariosAdmin(); });
      el.dataset.bound = "true";
    }
  });
  renderizarUsuariosAdmin();
  const achar = (lista, id) => (lista.find((x) => String(x.id) === String(id)) || {}).nome || "?";
  opcoes(document.getElementById("sel-prof"), usuarios.filter((x) => x.papel === "professor"), "Selecione um professor");
  opcoes(document.getElementById("sel-sala"), salas, "Selecione uma sala");
  opcoes(document.getElementById("sel-materia"), materias, "Selecione uma matéria");

  document.getElementById("form-vinculo").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const botao = form.querySelector("button[type=submit]");
    botao.disabled = true;
    botao.innerHTML = "Vinculando...";
    const { error } = await supabaseClient.from("professor_turmas").insert({
      professor_id: document.getElementById("sel-prof").value,
      sala_id: Number(document.getElementById("sel-sala").value),
      materia_id: Number(document.getElementById("sel-materia").value),
    });
    if (error) {
      avisoAdmin(error.code === "23505" ? "Esse professor já está vinculado a essa matéria e sala." : "Não foi possível criar o vínculo. Verifique os dados e tente novamente.", true);
    } else {
      avisoAdmin("Professor vinculado com sucesso!", false);
      await carregarPainelAdmin();
    }
    botao.disabled = false;
    botao.innerHTML = '<span>Vincular professor</span><span aria-hidden="true">+</span>';
  };

  const corpoTurmas = document.getElementById("tabela-turmas-body");
  corpoTurmas.innerHTML = "";
  turmas.forEach((v) => {
    const linha = document.createElement("tr");
    const professorCell = document.createElement("td");
    const salaCell = document.createElement("td");
    const materiaCell = document.createElement("td");
    professorCell.textContent = achar(usuarios, v.professor_id);
    salaCell.textContent = achar(salas, v.sala_id);
    materiaCell.textContent = achar(materias, v.materia_id);
    const acoes = document.createElement("td");
    const editar = document.createElement("button");
    editar.type = "button"; editar.className = "btn-editar"; editar.textContent = "Editar";
    let editando = false;
    let editores = null;
    editar.addEventListener("click", async () => {
      if (!editando) {
        const selProfessor = document.createElement("select");
        const selSala = document.createElement("select");
        const selMateria = document.createElement("select");
        opcoes(selProfessor, usuarios.filter((x) => x.papel === "professor"));
        opcoes(selSala, salas);
        opcoes(selMateria, materias);
        selProfessor.value = v.professor_id; selSala.value = String(v.sala_id); selMateria.value = String(v.materia_id);
        professorCell.replaceChildren(selProfessor); salaCell.replaceChildren(selSala); materiaCell.replaceChildren(selMateria);
        editores = { selProfessor, selSala, selMateria };
        editando = true;
        editar.textContent = "Salvar"; editar.classList.add("btn-salvar-edicao");
        const cancelar = document.createElement("button"); cancelar.type = "button"; cancelar.className = "btn-remover"; cancelar.textContent = "Cancelar";
        acoes.appendChild(cancelar);
        cancelar.addEventListener("click", () => { carregarPainelAdmin(); });
        return;
      }
      editar.disabled = true;
      const novos = { professor_id: editores.selProfessor.value, sala_id: Number(editores.selSala.value), materia_id: Number(editores.selMateria.value) };
      const { error } = await supabaseClient.from("professor_turmas").update(novos).match(v);
      if (error) {
        editar.disabled = false;
        return avisoAdmin(error.code === "23505" ? "Esse vínculo já existe." : "Não foi possível atualizar o vínculo.", true);
      }
      await carregarPainelAdmin();
      avisoAdmin("Vínculo atualizado com sucesso.", false);
    });
    const remover = document.createElement("button");
    remover.type = "button"; remover.className = "btn-remover"; remover.textContent = "Remover";
    remover.addEventListener("click", async () => {
      if (!window.confirm("Deseja remover este vínculo de professor, sala e matéria?")) return;
      remover.disabled = true;
      const { error } = await supabaseClient.from("professor_turmas").delete().match(v);
      if (error) { remover.disabled = false; return avisoAdmin("Não foi possível remover o vínculo. Tente novamente.", true); }
      await carregarPainelAdmin();
      avisoAdmin("Vínculo removido com sucesso.", false);
    });
    acoes.append(editar, remover);
    linha.append(professorCell, salaCell, materiaCell, acoes);
    corpoTurmas.appendChild(linha);
  });
  if (turmas.length === 0) corpoTurmas.innerHTML = '<tr><td colspan="4" class="hint">Nenhum professor vinculado ainda. Use o formulário acima para começar.</td></tr>';
}
