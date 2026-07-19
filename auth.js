/* ============================================================
   Sincronização na nuvem com Supabase (grátis)
   - Login por email (link mágico, sem password)
   - Guarda a coleção numa tabela `collections` (uma linha por utilizador)
   - Se o Supabase não estiver configurado, corre em modo local
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.SUPABASE_CONFIG || {};
const configured =
  cfg.url &&
  cfg.anonKey &&
  !cfg.url.includes("YOUR_PROJECT") &&
  !cfg.anonKey.includes("YOUR_ANON");

const authArea = document.getElementById("auth-area");
let supabase = null;
let currentUser = null;
let pushTimer = null;

/* ---------- Modo local (Supabase não configurado) ---------- */
if (!configured) {
  authArea.innerHTML = `<span class="auth-note" title="Configura o config.js para ativar a sincronização">💾 Local</span>`;
} else {
  supabase = createClient(cfg.url, cfg.anonKey);
  init();
}

async function init() {
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user || null;
  renderAuth();

  if (currentUser) await onSignedIn();

  supabase.auth.onAuthStateChange(async (_event, session) => {
    const wasNull = !currentUser;
    currentUser = session?.user || null;
    renderAuth();
    if (currentUser && wasNull) await onSignedIn();
    if (!currentUser) authArea.dataset.state = "out";
  });
}

/* ---------- UI de autenticação ---------- */
function renderAuth() {
  if (currentUser) {
    authArea.innerHTML = `
      <span class="auth-email" title="${escAttr(currentUser.email)}">☁️ ${escAttr(currentUser.email)}</span>
      <button class="btn btn-sm" id="logout-btn">Sair</button>`;
    document.getElementById("logout-btn").addEventListener("click", async () => {
      await supabase.auth.signOut();
      setSyncStatus("Sessão terminada. A coleção continua guardada localmente.");
    });
  } else {
    authArea.innerHTML = `<button class="btn btn-sm" id="login-btn">☁️ Entrar / Sincronizar</button>`;
    document.getElementById("login-btn").addEventListener("click", openLogin);
  }
}

function openLogin() {
  const email = prompt(
    "Introduz o teu email.\n\nVais receber um link mágico para entrar (sem password)."
  );
  if (!email) return;
  supabase.auth
    .signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.href },
    })
    .then(({ error }) => {
      if (error) alert("Erro ao enviar o link: " + error.message);
      else alert("Link enviado! Verifica o teu email e clica no link para entrar.");
    });
}

/* ---------- Sincronização ---------- */
async function onSignedIn() {
  setSyncStatus(`<span class="spinner"></span>A sincronizar…`);
  try {
    const remote = await fetchRemote();
    const local = window.getCollection();

    const merged = mergeCollections(local, remote);
    window.applyRemoteCollection(merged);
    await pushRemote(merged);

    setSyncStatus("Sincronizado com a nuvem ✓");
    window.addEventListener("collection-changed", schedulePush);
  } catch (err) {
    setSyncStatus("Falha na sincronização: " + err.message, true);
  }
}

async function fetchRemote() {
  const { data, error } = await supabase
    .from("collections")
    .select("data")
    .eq("user_id", currentUser.id)
    .maybeSingle();
  if (error) throw error;
  return data?.data || {};
}

async function pushRemote(collection) {
  const { error } = await supabase.from("collections").upsert(
    {
      user_id: currentUser.id,
      data: collection,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

// Push com debounce (evita gravar a cada clique de +/-)
function schedulePush() {
  if (!currentUser) return;
  clearTimeout(pushTimer);
  setSyncStatus("A guardar…");
  pushTimer = setTimeout(async () => {
    try {
      await pushRemote(window.getCollection());
      setSyncStatus("Guardado na nuvem ✓");
    } catch (err) {
      setSyncStatus("Falha ao guardar: " + err.message, true);
    }
  }, 900);
}

/* Merge seguro: união por id; em caso de sobreposição fica a maior quantidade
   (evita duplicação em logins repetidos). */
function mergeCollections(a, b) {
  const out = { ...b };
  for (const [id, entry] of Object.entries(a || {})) {
    if (!out[id]) out[id] = entry;
    else out[id] = { ...out[id], qty: Math.max(out[id].qty || 0, entry.qty || 0) };
  }
  return out;
}

/* ---------- helpers ---------- */
function setSyncStatus(html, isError = false) {
  const el = document.getElementById("collection-status");
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle("error", isError);
}

function escAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
