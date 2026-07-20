/* ============================================================
   Camada de dados — a coleção vive na base de dados (Firebase)
   ------------------------------------------------------------
   - Firestore é a FONTE DE VERDADE (uma "document" por carta em
     users/{uid}/cards/{cardId}).
   - Cache offline + sincronização em tempo real são geridas pelo
     próprio Firestore (persistentLocalCache + onSnapshot).
   - Login com Google (obrigatório para usar a app).
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, writeBatch, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const cfg = window.FIREBASE_CONFIG || {};
const configured =
  cfg.apiKey && cfg.projectId &&
  !String(cfg.apiKey).includes("YOUR_") &&
  !String(cfg.projectId).includes("YOUR_");

// App de um só dono: só esta conta pode entrar (vazio = qualquer conta).
const allowedEmail = String(window.ALLOWED_EMAIL || "").trim().toLowerCase();
const isAllowed = (user) =>
  !allowedEmail ||
  String(user?.email || "").trim().toLowerCase() === allowedEmail;

const authArea = document.getElementById("auth-area");
const gate = document.getElementById("auth-gate");

let auth = null;
let db = null;
let currentUser = null;
let unsubscribe = null; // cancela o onSnapshot ao sair
let rejected = false;   // true quando entrou uma conta não autorizada

/* ============================================================
   API pública usada pelo app.js
   ============================================================ */
window.Storage = {
  configured,
  // Grava/atualiza uma carta na base de dados.
  upsert(id, entry) {
    if (!db || !currentUser) return;
    setDoc(doc(db, "users", currentUser.uid, "cards", id), entry)
      .catch((e) => setSyncStatus("Falha ao guardar: " + e.message, true));
  },
  // Remove uma carta da base de dados.
  remove(id) {
    if (!db || !currentUser) return;
    deleteDoc(doc(db, "users", currentUser.uid, "cards", id))
      .catch((e) => setSyncStatus("Falha ao remover: " + e.message, true));
  },
  // Grava/remove muitas cartas de uma vez, em lotes (para imports).
  // upserts: [{ id, entry }] ; deletes: [id]. Devolve uma Promise.
  async commitMany(upserts = [], deletes = []) {
    if (!db || !currentUser) return;
    const ref = (id) => doc(db, "users", currentUser.uid, "cards", id);
    const ops = [
      ...upserts.map((u) => ["set", u.id, u.entry]),
      ...deletes.map((id) => ["del", id]),
    ];
    const CHUNK = 400; // o Firestore permite até 500 operações por batch
    for (let i = 0; i < ops.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const [kind, id, entry] of ops.slice(i, i + CHUNK)) {
        if (kind === "set") batch.set(ref(id), entry);
        else batch.delete(ref(id));
      }
      await batch.commit();
      if (i + CHUNK < ops.length) await new Promise((r) => setTimeout(r, 40));
    }
  },
};

/* ============================================================
   Arranque
   ============================================================ */
if (!configured) {
  renderGateNeedsConfig();
  authArea.innerHTML = `<span class="auth-note" title="Configura o config.js">⚠️ Sem base de dados</span>`;
} else {
  const app = initializeApp(cfg);
  auth = getAuth(app);
  // Firestore com cache offline persistente (funciona sem ligação).
  db = initializeFirestore(app, {
    ignoreUndefinedProperties: true, // slimCard pode ter card_faces: undefined
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  init();
}

function init() {
  onAuthStateChanged(auth, (user) => {
    // Conta autenticada mas não autorizada → recusa e termina sessão.
    if (user && !isAllowed(user)) {
      rejected = true;
      signOut(auth); // dispara novo onAuthStateChanged com user = null
      return;
    }
    if (user) rejected = false; // entrou a conta certa

    const wasSignedIn = !!currentUser;
    currentUser = user || null;
    renderAuth();
    updateGate();
    if (currentUser && !wasSignedIn) start();
    if (!currentUser && wasSignedIn) stop();
  });
}

/* ============================================================
   Sessão iniciada → ouvir a coleção em tempo real
   ============================================================ */
function start() {
  setSyncStatus(`<span class="spinner"></span>A carregar da base de dados…`);
  const col = collection(db, "users", currentUser.uid, "cards");
  unsubscribe = onSnapshot(
    col,
    (snap) => {
      const data = {};
      snap.forEach((d) => { data[d.id] = d.data(); });
      window.applyRemoteCollection(data);
      setSyncStatus(
        snap.metadata.fromCache
          ? "Offline — a mostrar a última cópia local."
          : "Ligado à base de dados ✓"
      );
    },
    (err) => setSyncStatus("Erro na base de dados: " + err.message, true)
  );
}

function stop() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  window.applyRemoteCollection({}); // limpa a vista ao sair
}

/* ============================================================
   UI — canto superior + porta de entrada (login obrigatório)
   ============================================================ */
function renderAuth() {
  if (!configured) return;
  if (currentUser) {
    const label = currentUser.displayName || currentUser.email || "conta Google";
    authArea.innerHTML = `
      <span class="auth-email" title="${escAttr(label)}">☁️ ${escAttr(label)}</span>
      <button class="btn btn-sm" id="logout-btn">Sair</button>`;
    document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));
  } else {
    authArea.innerHTML = `<span class="auth-note">🔒 Sessão terminada</span>`;
  }
}

// Mostra/esconde a porta de entrada consoante haja sessão iniciada.
function updateGate() {
  if (!gate) return;
  if (currentUser) { gate.hidden = true; return; }

  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-box">
      <h2>🃏 A Minha Coleção Magic</h2>
      <p>A tua coleção fica guardada em segurança numa base de dados na nuvem.
         Entra com a tua conta Google para a veres e editares.</p>
      <button class="btn btn-google" id="google-btn" type="button">
        <span class="g-icon" aria-hidden="true">G</span> Entrar com Google
      </button>
      <p class="gate-note ${rejected ? "gate-error" : ""}" id="gate-note">${
        rejected
          ? "Esta conta não tem acesso a esta coleção. Entra com a conta autorizada."
          : "Um clique — sem passwords."
      }</p>
    </div>`;

  document.getElementById("google-btn").addEventListener("click", () => {
    const note = document.getElementById("gate-note");
    note.textContent = "A abrir a janela do Google…";
    signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => {
      note.textContent =
        e.code === "auth/popup-closed-by-user"
          ? "Janela fechada antes de entrares. Tenta de novo."
          : "Erro ao entrar: " + e.message;
    });
  });
}

// Sem Firebase configurado: explica como ativar a base de dados.
function renderGateNeedsConfig() {
  if (!gate) return;
  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-box">
      <h2>🃏 A Minha Coleção Magic</h2>
      <p>Falta configurar a base de dados.</p>
      <p class="gate-note">
        Cria um projeto grátis na
        <a href="https://console.firebase.google.com" target="_blank" rel="noopener">Firebase Console</a>,
        ativa o <strong>Firestore</strong> e o login <strong>Google</strong>, publica as
        <code>firestore.rules</code> e cola a configuração da Web app no
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
