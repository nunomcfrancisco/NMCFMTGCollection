/* ============================================================
   Data layer — the collection lives in the database (Firebase)
   ------------------------------------------------------------
   - Firestore is the SOURCE OF TRUTH (one document per card in
     users/{uid}/cards/{cardId}).
   - Offline cache + real-time sync are handled by Firestore
     itself (persistentLocalCache + onSnapshot).
   - Google login (required to use the app).
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, setDoc, deleteDoc, writeBatch, onSnapshot,
  getDocsFromServer, query, limit,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const cfg = window.FIREBASE_CONFIG || {};
const configured =
  cfg.apiKey && cfg.projectId &&
  !String(cfg.apiKey).includes("YOUR_") &&
  !String(cfg.projectId).includes("YOUR_");

// Single-owner app: only this account may sign in (empty = any account).
const allowedEmail = String(window.ALLOWED_EMAIL || "").trim().toLowerCase();
const isAllowed = (user) =>
  !allowedEmail ||
  String(user?.email || "").trim().toLowerCase() === allowedEmail;

const authArea = document.getElementById("auth-area");
const gate = document.getElementById("auth-gate");

let auth = null;
let db = null;
let currentUser = null;
let unsubscribe = null; // cancels the onSnapshot on sign-out
let rejected = false;   // true when an unauthorized account signed in

/* ============================================================
   Public API used by app.js
   ============================================================ */
window.Storage = {
  configured,
  // Writes/updates a card in the database.
  upsert(id, entry) {
    if (!db || !currentUser) return;
    setDoc(doc(db, "users", currentUser.uid, "cards", id), entry)
      .catch((e) => setSyncStatus("Failed to save: " + e.message, true));
  },
  // Removes a card from the database.
  remove(id) {
    if (!db || !currentUser) return;
    deleteDoc(doc(db, "users", currentUser.uid, "cards", id))
      .catch((e) => setSyncStatus("Failed to remove: " + e.message, true));
  },
  // Writes/removes many cards at once, in batches (for imports and bulk delete).
  // upserts: [{ id, entry }] ; deletes: [id]. Returns a Promise.
  // Detaches the live listener during a bulk write. The offline cache
  // (IndexedDB) can throw "INTERNAL ASSERTION FAILED: Unexpected state" when
  // the onSnapshot reader and a writeBatch hit the cache at the same time —
  // most often on mobile, where multi-tab coordination adds extra IndexedDB
  // pressure. Pausing the reader while we write avoids that collision.
  pauseSync() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  },
  // Re-attaches the listener (and re-renders from the database) after a bulk
  // write. Safe to call when already subscribed or signed out.
  resumeSync() {
    if (currentUser && !unsubscribe) subscribe();
  },
  async commitMany(upserts = [], deletes = []) {
    if (!db || !currentUser) return;
    const ref = (id) => doc(db, "users", currentUser.uid, "cards", id);
    const ops = [
      ...upserts.map((u) => ["set", u.id, u.entry]),
      ...deletes.map((id) => ["del", id]),
    ];

    const CHUNK = 400; // Firestore allows up to 500 operations per batch
    // Build all batches first…
    const batches = [];
    for (let i = 0; i < ops.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const [kind, id, entry] of ops.slice(i, i + CHUNK)) {
        if (kind === "set") batch.set(ref(id), entry);
        else batch.delete(ref(id));
      }
      batches.push(batch);
    }

    // …then commit them with limited concurrency. Running batches in parallel
    // (instead of one round-trip at a time) makes large deletes/imports much
    // faster, while the cap keeps us from flooding Firestore all at once.
    const CONCURRENCY = 6;
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        await batch.commit();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker)
    );
  },
  // Deletes EVERY card straight from the server, not just the ones currently in
  // memory. The in-memory collection can be stale (e.g. loaded from the offline
  // cache, or only partially synced after a big import), so deleting by
  // Object.keys(collection) could leave server documents behind that reappear on
  // the next sync. This reads a page from the server, deletes it, and repeats
  // until the collection is truly empty. Returns the number of cards removed.
  async deleteAll(onProgress) {
    if (!db || !currentUser) return 0;
    const col = collection(db, "users", currentUser.uid, "cards");
    let total = 0;
    for (;;) {
      // Read from the server (not the cache) so we see what's really there.
      const snap = await getDocsFromServer(query(col, limit(300)));
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      total += snap.size;
      if (onProgress) onProgress(total);
      // Fewer than a full page means we just cleared the last of them.
      if (snap.size < 300) break;
    }
    return total;
  },
};

/* ============================================================
   Startup
   ============================================================ */
if (!configured) {
  renderGateNeedsConfig();
  authArea.innerHTML = `<span class="auth-note" title="Configure config.js">⚠️ No database</span>`;
} else {
  const app = initializeApp(cfg);
  auth = getAuth(app);
  // Firestore with persistent offline cache (works without a connection).
  // Single-tab manager on purpose: the multi-tab manager coordinates the
  // IndexedDB cache across tabs with extra locking that some mobile browsers
  // (notably iOS Safari/WebKit) handle badly, throwing "INTERNAL ASSERTION
  // FAILED: Unexpected state" when a large collection is first loaded into an
  // empty cache — which left the listener never delivering the cards on the
  // phone even though the PC import had written them to the server. This is a
  // single-owner app, so cross-tab sync buys us nothing; single-tab is far
  // more stable on mobile.
  db = initializeFirestore(app, {
    ignoreUndefinedProperties: true, // slimCard may have card_faces: undefined
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) }),
  });
  init();
}

function init() {
  onAuthStateChanged(auth, (user) => {
    // Authenticated but unauthorized account → reject and sign out.
    if (user && !isAllowed(user)) {
      rejected = true;
      signOut(auth); // triggers a new onAuthStateChanged with user = null
      return;
    }
    if (user) rejected = false; // the right account signed in

    const wasSignedIn = !!currentUser;
    currentUser = user || null;
    renderAuth();
    updateGate();
    if (currentUser && !wasSignedIn) start();
    if (!currentUser && wasSignedIn) stop();
  });
}

/* ============================================================
   Session started → listen to the collection in real time
   ============================================================ */
function start() {
  setSyncStatus(`<span class="spinner"></span>Loading from the database…`);
  subscribe();
}

// Attaches the real-time listener. Extracted from start() so it can be
// re-attached after a bulk write (see Storage.pauseSync / resumeSync).
function subscribe() {
  if (!db || !currentUser || unsubscribe) return;
  const col = collection(db, "users", currentUser.uid, "cards");
  unsubscribe = onSnapshot(
    col,
    (snap) => {
      const data = {};
      snap.forEach((d) => { data[d.id] = d.data(); });
      window.applyRemoteCollection(data);
      setSyncStatus(
        snap.metadata.fromCache
          ? "Offline — showing the last local copy."
          : "Connected to the database ✓"
      );
    },
    (err) => {
      // If the live listener fails (e.g. the IndexedDB cache tripping the
      // "Unexpected state" assertion on a mobile browser), don't leave the
      // user staring at an empty collection: detach and read the cards once
      // straight from the server so they still load. Live sync stays off until
      // the next reload, but the collection is visible.
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      loadFromServerOnce(err.message);
    }
  );
}

// One-time read of the whole collection from the server (not the cache).
// Used as a fallback when the real-time listener can't deliver the data.
async function loadFromServerOnce(reason) {
  if (!db || !currentUser) return;
  try {
    const col = collection(db, "users", currentUser.uid, "cards");
    const snap = await getDocsFromServer(col);
    const data = {};
    snap.forEach((d) => { data[d.id] = d.data(); });
    window.applyRemoteCollection(data);
    setSyncStatus("Loaded from the database (live sync off — reload to reconnect).");
  } catch (e) {
    setSyncStatus("Database error: " + (reason || e.message), true);
  }
}

function stop() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  window.applyRemoteCollection({}); // clears the view on sign-out
}

/* ============================================================
   UI — top corner + entry gate (login required)
   ============================================================ */
function renderAuth() {
  if (!configured) return;
  if (currentUser) {
    authArea.innerHTML = `
      <button class="btn btn-sm btn-icon" id="logout-btn" aria-label="Log out" title="Log out">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 3.5v8" />
          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6.6 6.9a7.5 7.5 0 1 0 10.8 0" />
        </svg>
      </button>`;
    document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));
  } else {
    authArea.innerHTML = `<span class="auth-note">🔒 Signed out</span>`;
  }
}

// Shows/hides the entry gate depending on whether a session is active.
function updateGate() {
  if (!gate) return;
  if (currentUser) { gate.hidden = true; return; }

  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-box">
      <h2><img class="brand-icon" src="icon.svg?v=29" alt="" /> MTG Collection</h2>
      <button class="btn btn-google" id="google-btn" type="button">
        <span class="g-icon" aria-hidden="true">G</span> Sign in with Google
      </button>
      <p class="gate-note ${rejected ? "gate-error" : ""}" id="gate-note">${
        rejected
          ? "This account doesn't have access to this collection. Sign in with the authorized account."
          : ""
      }</p>
    </div>`;

  document.getElementById("google-btn").addEventListener("click", () => {
    const note = document.getElementById("gate-note");
    note.textContent = "Opening the Google window…";
    signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => {
      note.textContent =
        e.code === "auth/popup-closed-by-user"
          ? "Window closed before you signed in. Try again."
          : "Sign-in error: " + e.message;
    });
  });
}

// No Firebase configured: explain how to enable the database.
function renderGateNeedsConfig() {
  if (!gate) return;
  gate.hidden = false;
  gate.innerHTML = `
    <div class="gate-box">
      <h2><img class="brand-icon" src="icon.svg?v=29" alt="" /> MTG Collection</h2>
      <p>The database still needs to be configured.</p>
      <p class="gate-note">
        Create a free project on the
        <a href="https://console.firebase.google.com" target="_blank" rel="noopener">Firebase Console</a>,
        enable <strong>Firestore</strong> and <strong>Google</strong> login, publish the
        <code>firestore.rules</code> and paste the Web app configuration into the
        <code>config.js</code> file. See the <strong>README</strong> for the step-by-step.
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
