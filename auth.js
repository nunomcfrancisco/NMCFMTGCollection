/* ============================================================
   Camada de dados — a coleção vive na base de dados (Supabase)
   ------------------------------------------------------------
   - A base de dados é a FONTE DE VERDADE (uma linha por carta).
   - O localStorage é só uma cache offline (para arrancar depressa
     e não perder alterações feitas sem ligação).
   - Login por email (link mágico) é OBRIGATÓRIO para usar a app.
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.SUPABASE_CONFIG || {};
const configured =
  cfg.url &&
  cfg.anonKey &&
  !cfg.url.includes("YOUR_PROJECT") &&
  !cfg.anonKey.includes("YOUR_ANON");

const TABLE = "collection_cards";

const authArea = document.getElementById("auth-area");
const gate = document.getElementById("auth-gate");

let supabase = null;
let currentUser = null;
let flushTimer = null;
let flushing = false;

/* ============================================================
   Cache local + fila de alterações por sincronizar (por utilizador)
   ============================================================ */
function cacheKey() { return currentUser ? `mtg-cache-${currentUser.id}` : null; }
function dirtyKey() { return currentUser ? `mtg-dirty-${currentUser.id}` : null; }

function loadCache() {
  const k = cacheKey();
  if (!k) return null;
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
}
function saveCache() {
  const k = cacheKey();
  if (!k) return;
  try { localStorage.setItem(k, JSON.stringify(window.getCollection())); } catch {}
}

// A fila é o conjunto de ids de cartas alteradas localmente ainda por gravar.
// Ao sincronizar, cada id é reconciliado com o estado atual em memória
// (existe → upsert; já não existe → delete), o que evita corridas.
function loadDirty() {
  const k = dirtyKey();
  if (!k) return [];
  try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; }
}
function saveDirty(arr) {
  const k = dirtyKey();
  if (k) localStorage.setItem(k, JSON.stringify(arr));
}
function markDirty(ids) {
  if (!currentUser) return;
  const set = new Set(loadDirty());
  for (const id of ids) set.add(id);
  saveDirty([...set]);
  saveCache();
  scheduleFlush();
}
function clearDirty(id) {
  saveDirty(loadDirty().filter((x) => x !== id));
}

/* ============================================================
   API pública usada pelo app.js
   ============================================================ */
window.Storage = {
  configured,
  // Marca cartas como alteradas para serem gravadas na base de dados.
  touch(id) { markDirty([id]); },
  touchAll(ids) { markDirty(ids); },
};

/* ============================================================
   Arranque
   ============================================================ */
if (!configured) {
  // Sem Supabase configurado não há base de dados — mostra instruções.
  renderGateNeedsConfig();
  authArea.innerHTML = `<span class="auth-note" title="Configura o config.js">⚠️ Sem base de dados</span>`;
} else {
  supabase = createClient(cfg.url, cfg.anonKey);
  init();
}

async function init() {
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user || null;
  renderAuth();
  updateGate();

  if (currentUser) await onSignedIn();

  supabase.auth.onAuthStateChange(async (_event, session) => {
    const wasSignedIn = !!currentUser;
    currentUser = session?.user || null;
    renderAuth();
    updateGate();
    if (currentUser && !wasSignedIn) await onSignedIn();
    if (!currentUser && wasSignedIn) window.applyRemoteCollection({}); // limpa a vista ao sair
  });

  // Ao voltar a ter ligação, tenta gravar o que ficou pendente.
  window.addEventListener("online", () => { if (currentUser) flush(); });
}

/* ============================================================
   Sessão iniciada → carregar a coleção da base de dados
   ============================================================ */
async function onSignedIn() {
  // Mostra já a última cópia local (rápido e funciona offline).
  const cached = loadCache();
  if (cached) window.applyRemoteCollection(cached);

  setSyncStatus(`<span class="spinner"></span>A carregar da base de dados…`);
  try {
    await flush();                 // grava primeiro alterações locais pendentes
    const remote = await fetchAll();

    // A base de dados é a fonte de verdade, mas preserva o que ainda
    // estiver por sincronizar (caso a gravação acima tenha falhado).
    const dirty = loadDirty();
    if (dirty.length) {
      const local = window.getCollection();
      for (const id of dirty) {
        if (local[id]) remote[id] = local[id];
        else delete remote[id];
      }
    }

    window.applyRemoteCollection(remote);
    saveCache();
    setSyncStatus(
      dirty.length
        ? "Ligado à base de dados — algumas alterações ainda por sincronizar."
        : "Ligado à base de dados ✓"
    );
  } catch (err) {
    setSyncStatus(
      "Sem ligação à base de dados — a mostrar a última cópia local guardada.",
      true
    );
  }
}

/* ============================================================
   Leitura / escrita na base de dados
   ============================================================ */
async function fetchAll() {
  const out = {};
  const pageSize = 1000; // o Supabase devolve no máximo 1000 linhas por pedido
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("card_id,qty,foil,added_at,card")
      .eq("user_id", currentUser.id)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    for (const r of data) {
      out[r.card_id] = { qty: r.qty, foil: r.foil, addedAt: r.added_at, card: r.card };
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 600);
}

// Grava na base de dados todas as cartas marcadas como alteradas.
async function flush() {
  if (!currentUser || flushing) return;
  const pending = loadDirty();
  if (!pending.length) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setSyncStatus("Offline — as alterações vão sincronizar quando houver ligação.");
    return;
  }

  flushing = true;
  setSyncStatus("A guardar na base de dados…");
  try {
    const coll = window.getCollection();
    for (const id of pending) {
      const e = coll[id];
      if (e) {
        const { error } = await supabase.from(TABLE).upsert(
          {
            user_id: currentUser.id,
            card_id: id,
            qty: e.qty ?? 1,
            foil: !!e.foil,
            added_at: e.addedAt ?? null,
            card: e.card,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,card_id" }
        );
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from(TABLE)
          .delete()
          .eq("user_id", currentUser.id)
          .eq("card_id", id);
        if (error) throw error;
      }
      clearDirty(id);
    }
    setSyncStatus("Guardado na base de dados ✓");
  } catch (err) {
    setSyncStatus(
      "Sem ligação à base de dados — guardado localmente; vai sincronizar mais tarde.",
      true
    );
  } finally {
    flushing = false;
  }
}

/* ============================================================
   UI — canto superior + porta de entrada (login obrigatório)
   ============================================================ */
function renderAuth() {
  if (!configured) return;
  if (currentUser) {
    authArea.innerHTML = `
      <span class="auth-email" title="${escAttr(currentUser.email)}">☁️ ${escAttr(currentUser.email)}</span>
      <button class="btn btn-sm" id="logout-btn">Sair</button>`;
    document.getElementById("logout-btn").addEventListener("click", async () => {
      await supabase.auth.signOut();
    });
  } else {
    authArea.innerHTML = `<span class="auth-note">🔒 Sessão terminada</span>`;
  }
}

// Mostra/esconde a porta de entrada consoante haja sessão iniciada.
function updateGate() {
  if (!gate) return;
  if (currentUser) {
    gate.hidden = true;
    return;
  }
  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-box">
      <h2>🃏 A Minha Coleção Magic</h2>
      <p>A tua coleção fica guardada em segurança numa base de dados na nuvem.
         Entra com o teu email para a veres e editares.</p>
      <form id="gate-form" class="gate-form" autocomplete="off">
        <input id="gate-email" type="email" required placeholder="o.teu.email@exemplo.com"
               aria-label="Email" />
        <button type="submit" class="btn btn-primary">Receber link de entrada</button>
      </form>
      <p class="gate-note" id="gate-note">Recebes um link mágico por email — sem password.</p>
    </div>`;

  const form = document.getElementById("gate-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("gate-email").value.trim();
    if (!email) return;
    const note = document.getElementById("gate-note");
    note.textContent = "A enviar…";
    supabase.auth
      .signInWithOtp({ email, options: { emailRedirectTo: window.location.href } })
      .then(({ error }) => {
        note.textContent = error
          ? "Erro ao enviar o link: " + error.message
          : "Link enviado! Verifica o teu email e clica no link para entrar.";
      });
  });
}

// Sem Supabase configurado: explica como ativar a base de dados.
function renderGateNeedsConfig() {
  if (!gate) return;
  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-box">
      <h2>🃏 A Minha Coleção Magic</h2>
      <p>Falta configurar a base de dados.</p>
      <p class="gate-note">
        Cria um projeto grátis em <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a>,
        corre o <code>supabase-setup.sql</code> e cola o URL e a <em>anon key</em> no
        ficheiro <code>config.js</code>. Vê o <strong>README</strong> para o passo a passo.
      </p>
    </div>`;
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
