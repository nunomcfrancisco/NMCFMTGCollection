/* ============================================================
   A Minha Coleção Magic
   - Dados/imagens: API pública da Scryfall (sem chave)
   - Persistência: base de dados Firestore (Firebase) — ver auth.js.
     A cache offline é gerida pelo próprio Firestore.
   ============================================================ */

const SCRYFALL = "https://api.scryfall.com";

/* ---------- Estado ---------- */
// collection = { [cardId]: { qty, foil, card } }
// Arranca vazia; a camada de dados (auth.js) carrega-a da base de dados
// assim que houver sessão iniciada.
let collection = {};

// Enquanto está true, os snapshots do Firestore não mexem na coleção em
// memória — durante um import é ela a fonte de verdade (senão os snapshots
// parciais de cada lote apagariam cartas ainda por gravar).
let importing = false;

/* ---------- Utilitários ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ---------- Persistência (delegada à camada de dados / auth.js) ---------- */
// Grava na base de dados: se a carta existe em memória faz upsert, senão remove.
function persist(id) {
  if (!window.Storage) return;
  if (collection[id]) window.Storage.upsert(id, collection[id]);
  else window.Storage.remove(id);
}
// Grava muitas cartas de uma vez (em lote) — evita rajadas de escrituras
// individuais que rebentam o SDK do Firestore em imports grandes.
function persistMany(ids) {
  if (!window.Storage) return Promise.resolve();
  if (window.Storage.commitMany) {
    const upserts = [], deletes = [];
    for (const id of ids) {
      if (collection[id]) upserts.push({ id, entry: collection[id] });
      else deletes.push(id);
    }
    return window.Storage.commitMany(upserts, deletes);
  }
  ids.forEach(persist);
  return Promise.resolve();
}

/* ---------- Ponte com a camada de dados (auth.js) ---------- */
// Devolve a coleção atual (usada ao gravar na base de dados).
window.getCollection = () => collection;

// Substitui a coleção com os dados vindos da base de dados (não re-grava).
window.applyRemoteCollection = (data) => {
  if (importing) return; // durante um import ignora snapshots (ver 'importing')
  collection = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  // Aplica a regra de 1 cópia máxima.
  for (const entry of Object.values(collection)) {
    if (entry && entry.qty > 1) entry.qty = 1;
  }
  renderCollection();
  // Atualiza a vista de edições (grelha de sets e/ou detalhe da edição aberta).
  if (editionsState.setsLoaded && !$("#edition-picker").hidden) renderEditionPicker();
  if (editionsState.cards.length && !$("#edition-detail").hidden) renderEdition();
};

function eur(value) {
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(value || 0);
}

// Preço da carta em EUR (Scryfall dá EUR e USD). Usa EUR; cai para USD*0.92.
function cardPrice(card, foil) {
  const p = card.prices || {};
  if (foil) {
    if (p.eur_foil) return parseFloat(p.eur_foil);
    if (p.usd_foil) return parseFloat(p.usd_foil) * 0.92;
  }
  if (p.eur) return parseFloat(p.eur);
  if (p.usd) return parseFloat(p.usd) * 0.92;
  return 0;
}

function cardImage(card, size = "normal") {
  // Cartas de duas faces têm as imagens em card_faces
  if (card.image_uris) return card.image_uris[size] || card.image_uris.normal;
  if (card.card_faces && card.card_faces[0].image_uris) {
    return card.card_faces[0].image_uris[size] || card.card_faces[0].image_uris.normal;
  }
  return "";
}

/* ---------- Escape HTML (segurança) ---------- */
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ============================================================
   NAVEGAÇÃO ENTRE VISTAS
   ============================================================ */
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    $(`#view-${view}`).classList.add("active");
    if (view === "collection") { collectionView.setCode = null; renderCollection(); }
    if (view === "editions") initEditions();
  });
});

/* Botão que alterna entre adicionar/remover a carta (máx. 1 cópia).
   Usado nas Edições. Devolve uma função que refaz o estado visual.
   `afterToggle` corre depois de cada alteração de posse. */
function makeOwnToggle(card, cardEl, actionsEl, afterToggle) {
  function sync() {
    const owned = !!collection[card.id];
    cardEl.classList.toggle("not-owned", !owned);
    actionsEl.innerHTML = owned
      ? `<button class="btn btn-sm remove-btn">✓ Na coleção · Remover</button>`
      : `<button class="btn btn-primary btn-sm add-btn">+ Adicionar</button>`;
    actionsEl.querySelector("button").addEventListener("click", () => {
      if (collection[card.id]) removeFromCollection(card.id);
      else addToCollection(card);
      sync();
      if (afterToggle) afterToggle();
    });
  }
  return sync;
}

/* ============================================================
   COLEÇÃO — adicionar / remover
   ============================================================ */
function addToCollection(card, foil = false, defer = false) {
  const id = card.id;
  // No máximo 1 cópia: se já existe, apenas garante qty = 1 (e atualiza o foil).
  if (collection[id]) {
    collection[id].qty = 1;
    collection[id].foil = foil || collection[id].foil;
  } else {
    collection[id] = {
      qty: 1,
      foil,
      addedAt: Date.now(),
      card: slimCard(card),
    };
  }
  // defer = deixa a gravação para um lote posterior (usado nos imports).
  if (!defer) persist(id);
}

function removeFromCollection(id) {
  if (!collection[id]) return;
  delete collection[id];
  persist(id);
}

// Guarda apenas os campos necessários para não encher a base de dados
function slimCard(card) {
  return {
    id: card.id,
    name: card.name,
    set: card.set,
    set_name: card.set_name,
    rarity: card.rarity,
    collector_number: card.collector_number,
    prices: card.prices,
    image_uris: card.image_uris,
    card_faces: card.card_faces
      ? card.card_faces.map((f) => ({ image_uris: f.image_uris }))
      : undefined,
  };
}

function toggleFoil(id) {
  if (!collection[id]) return;
  collection[id].foil = !collection[id].foil;
  persist(id);
  renderCollection();
}

/* ============================================================
   RENDER DA COLEÇÃO
   ============================================================ */
// Estado da vista Coleção: setCode = null → grelha de edições; senão → detalhe.
let collectionView = { setCode: null };

$("#collection-filter").addEventListener("input", renderCollection);
$("#collection-sort").addEventListener("change", renderCollection);
$("#collection-back").addEventListener("click", () => {
  collectionView.setCode = null;
  renderCollection();
});

function renderCollection() {
  const entries = Object.values(collection);

  // Estatísticas gerais (topo)
  const unique = entries.length;
  const totalValue = entries.reduce((s, e) => s + cardPrice(e.card, e.foil), 0);
  $("#collection-stats").innerHTML = `
    <div class="stat"><div class="stat-label">Cartas</div><div class="stat-value">${unique.toLocaleString("pt-PT")}</div></div>
    <div class="stat"><div class="stat-label">Valor estimado</div><div class="stat-value">${eur(totalValue)}</div></div>`;

  if (unique === 0) {
    collectionView.setCode = null;
    $("#collection-detail").hidden = true;
    $("#collection-picker").hidden = false;
    $("#collection-status").innerHTML = "";
    $("#collection-sets").innerHTML = `
      <div class="empty" style="grid-column: 1 / -1;">
        <h3>A tua coleção está vazia</h3>
        <p>Vai a <strong>Edições</strong>, escolhe um set e marca as cartas que tens, ou usa <strong>Importar</strong>.</p>
      </div>`;
    return;
  }

  // Se o set escolhido já não tem cartas (ex.: removeste a última), volta à grelha.
  if (collectionView.setCode && !ownedInSet(collectionView.setCode)) {
    collectionView.setCode = null;
  }

  if (collectionView.setCode) renderCollectionDetail();
  else renderCollectionPicker();

  // Carrega os símbolos/percentagens dos sets UMA vez e re-renderiza quando
  // chegam. O guarda evita anexar vários .then (que causariam re-renders
  // repetidos a limpar o status).
  if (!setsByCode && !collectionView.loadingSets) {
    collectionView.loadingSets = true;
    ensureSets().then(renderCollection).catch(() => {});
  }
}

// Agrupa a coleção por código de set.
function collectionBySet() {
  const bySet = {};
  for (const e of Object.values(collection)) {
    const code = e.card.set || "?";
    (bySet[code] ||= []).push(e);
  }
  return bySet;
}

function setDisplayName(code, fallbackEntry) {
  return (setsByCode && setsByCode[code] && setsByCode[code].name) ||
    (fallbackEntry && fallbackEntry.card.set_name) || code.toUpperCase();
}

// GRELHA de edições que tens na coleção (símbolo + nome + %), estilo Edições.
function renderCollectionPicker() {
  $("#collection-detail").hidden = true;
  $("#collection-picker").hidden = false;

  const bySet = collectionBySet();
  const filter = $("#collection-filter").value.trim().toLowerCase();
  let codes = Object.keys(bySet);
  if (filter) {
    codes = codes.filter((c) =>
      setDisplayName(c, bySet[c][0]).toLowerCase().includes(filter) ||
      c.toLowerCase().includes(filter));
  }
  codes.sort((a, b) => {
    const da = (setsByCode && setsByCode[a] && setsByCode[a].released_at) || "";
    const db = (setsByCode && setsByCode[b] && setsByCode[b].released_at) || "";
    if (da !== db) return db.localeCompare(da);
    return setDisplayName(a, bySet[a][0]).localeCompare(setDisplayName(b, bySet[b][0]));
  });

  $("#collection-status").innerHTML = filter
    ? `${codes.length} edição(ões).`
    : (setsByCode ? "" : `<span class="spinner"></span>A carregar edições…`);

  const grid = $("#collection-sets");
  grid.innerHTML = "";
  codes.forEach((code) => {
    const meta = setsByCode && setsByCode[code];
    const owned = bySet[code].length;
    const total = meta ? meta.card_count : 0;
    const pct = total ? Math.round((owned / total) * 100) : null;
    const name = setDisplayName(code, bySet[code][0]);

    const cell = document.createElement("button");
    cell.className = "set-cell";
    cell.title = pct === null
      ? `${name} — ${owned} carta(s)`
      : `${name} — ${owned}/${total} (${pct}%)`;
    cell.innerHTML = `
      <img class="set-symbol" loading="lazy" src="${esc(meta ? meta.icon_svg_uri || "" : "")}" alt="" />
      <span class="set-name">${esc(name)}</span>
      <span class="set-pct">${pct === null ? owned : pct + "%"}</span>`;
    cell.addEventListener("click", () => { collectionView.setCode = code; renderCollection(); });
    grid.appendChild(cell);
  });
}

// DETALHE: as tuas cartas de uma edição escolhida.
function renderCollectionDetail() {
  $("#collection-picker").hidden = true;
  $("#collection-detail").hidden = false;

  const code = collectionView.setCode;
  const meta = setsByCode && setsByCode[code];
  let entries = Object.values(collection).filter((e) => (e.card.set || "?") === code);
  const name = setDisplayName(code, entries[0]);
  const owned = entries.length;
  const total = meta ? meta.card_count : 0;
  const pct = total ? Math.round((owned / total) * 100) : null;

  $("#collection-set-title").textContent = name;
  $("#collection-set-stats").innerHTML =
    `<div class="stat"><div class="stat-label">Já tens</div><div class="stat-value">${owned.toLocaleString("pt-PT")}</div></div>` +
    (total
      ? `<div class="stat"><div class="stat-label">Cartas na edição</div><div class="stat-value">${total.toLocaleString("pt-PT")}</div></div>
         <div class="stat"><div class="stat-label">Completa</div><div class="stat-value">${pct}%</div></div>`
      : "");

  // Filtro + ordenação das cartas
  const filter = $("#collection-filter").value.trim().toLowerCase();
  if (filter) entries = entries.filter((e) => e.card.name.toLowerCase().includes(filter));
  const sort = $("#collection-sort").value;
  entries.sort((a, b) => {
    switch (sort) {
      case "name-desc": return b.card.name.localeCompare(a.card.name);
      case "value-desc": return cardPrice(b.card, b.foil) - cardPrice(a.card, a.foil);
      case "value": return cardPrice(a.card, a.foil) - cardPrice(b.card, b.foil);
      case "recent": return (b.addedAt || 0) - (a.addedAt || 0);
      default: return a.card.name.localeCompare(b.card.name);
    }
  });

  $("#collection-status").innerHTML = filter ? `${entries.length} carta(s).` : "";

  const grid = $("#collection-grid");
  grid.innerHTML = "";
  entries.forEach((entry) => grid.appendChild(collectionCardEl(entry)));
}

function collectionCardEl(entry) {
  const { card, foil } = entry;
  const el = document.createElement("div");
  el.className = "card";
  const unit = cardPrice(card, foil);

  el.innerHTML = `
    <div class="card-img-wrap" data-large="${esc(cardImage(card, "large"))}">
      <img loading="lazy" src="${esc(cardImage(card, "normal"))}" alt="${esc(card.name)}" />
      ${foil ? `<span class="card-foil-badge">FOIL</span>` : ""}
    </div>
    <div class="card-body">
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-meta">${esc(card.set_name)} · Nº ${esc(card.collector_number || "?")}</div>
      <div class="card-price">${unit ? eur(unit) : "—"}</div>
      <div class="card-actions">
        <button class="btn btn-sm foil-btn">${foil ? "★ Foil" : "☆ Foil"}</button>
        <button class="btn btn-sm remove-btn" style="margin-left:auto">🗑 Remover</button>
      </div>
    </div>`;

  el.querySelector(".foil-btn").addEventListener("click", () => toggleFoil(card.id));
  el.querySelector(".remove-btn").addEventListener("click", () => {
    removeFromCollection(card.id);
    renderCollection();
  });
  el.querySelector(".card-img-wrap").addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openPreview(el.querySelector(".card-img-wrap").dataset.large);
  });

  return el;
}

/* ============================================================
   EDIÇÕES — escolher um set e ver todas as cartas
   (as que não estão na coleção aparecem em grayscale)
   ============================================================ */
let editionsState = { setsLoaded: false, loading: false, sets: [], cards: [], setCode: "" };

// Mapa código→set (todos os sets da Scryfall), partilhado por Edições e Coleção.
let setsByCode = null;

// Carrega a lista de sets da Scryfall uma única vez (partilhada entre vistas).
async function ensureSets() {
  if (setsByCode) return setsByCode;
  if (!ensureSets._p) {
    ensureSets._p = (async () => {
      const res = await fetch(`${SCRYFALL}/sets`);
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const data = await res.json();
      const list = data.data || [];
      const map = {};
      for (const s of list) map[s.code] = s;
      setsByCode = map;
      // Alimenta também a grelha das Edições (só sets com cartas reais).
      editionsState.sets = list
        .filter((s) => s.card_count > 0 && !s.digital)
        .sort((a, b) => (b.released_at || "").localeCompare(a.released_at || ""));
      editionsState.setsLoaded = true;
      return map;
    })();
  }
  return ensureSets._p;
}

// Nº de cartas na coleção pertencentes a um dado código de set.
function ownedInSet(code) {
  let n = 0;
  for (const e of Object.values(collection)) {
    if (e.card && e.card.set === code) n++;
  }
  return n;
}

async function initEditions() {
  if (editionsState.setsLoaded) { renderEditionPicker(); return; }
  if (editionsState.loading) return;
  editionsState.loading = true;
  setStatus("#edition-status", `<span class="spinner"></span>A carregar edições…`);
  try {
    await ensureSets();
    setStatus("#edition-status", "");
    renderEditionPicker();
  } catch (err) {
    setStatus("#edition-status", `Falha ao carregar edições: ${esc(err.message)}`, true);
  } finally {
    editionsState.loading = false;
  }
}

// Grelha de símbolos dos sets (4 por linha). Cada célula mostra símbolo, nome e % na coleção.
function renderEditionPicker() {
  const grid = $("#edition-sets");
  const filter = $("#edition-search").value.trim().toLowerCase();
  const sets = filter
    ? editionsState.sets.filter((s) =>
        s.name.toLowerCase().includes(filter) || s.code.toLowerCase().includes(filter))
    : editionsState.sets;

  grid.innerHTML = "";
  sets.forEach((s) => {
    const owned = ownedInSet(s.code);
    const pct = s.card_count ? Math.round((owned / s.card_count) * 100) : 0;
    const cell = document.createElement("button");
    cell.className = "set-cell";
    cell.title = `${s.name} — ${owned}/${s.card_count} (${pct}%)`;
    cell.innerHTML = `
      <img class="set-symbol" loading="lazy" src="${esc(s.icon_svg_uri || "")}" alt="" />
      <span class="set-name">${esc(s.name)}</span>
      <span class="set-pct">${pct}%</span>`;
    cell.addEventListener("click", () => openEdition(s));
    grid.appendChild(cell);
  });
}

function openEdition(set) {
  $("#edition-picker").hidden = true;
  $("#edition-detail").hidden = false;
  $("#edition-title").textContent = set.name;
  $("#edition-missing-only").checked = false;
  loadEditionCards(set.code);
}

$("#edition-search").addEventListener("input", renderEditionPicker);
$("#edition-back").addEventListener("click", () => {
  $("#edition-detail").hidden = true;
  $("#edition-picker").hidden = false;
  editionsState.setCode = "";
  editionsState.cards = [];
  renderEditionPicker(); // reflete cartas adicionadas/removidas nesta edição
});
$("#edition-missing-only").addEventListener("change", renderEdition);

async function loadEditionCards(code) {
  editionsState.setCode = code;
  editionsState.cards = [];
  $("#edition-grid").innerHTML = "";
  $("#edition-stats").innerHTML = "";
  if (!code) return;

  editionsState.loading = true;
  setStatus("#edition-status", `<span class="spinner"></span>A carregar cartas…`);

  try {
    let url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(`set:${code} unique:prints`)}&order=set`;
    const all = [];
    // Percorre todas as páginas do set.
    while (url) {
      const res = await fetch(url);
      if (res.status === 404) break; // set sem cartas pesquisáveis
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const data = await res.json();
      all.push(...data.data);
      url = data.has_more ? data.next_page : null;
      // Guarda o set atual — evita render de resultados antigos se o utilizador trocar de set.
      if (editionsState.setCode !== code) return;
    }

    editionsState.cards = all;
    setStatus("#edition-status", "");
    renderEdition();
  } catch (err) {
    setStatus("#edition-status", `Falha ao carregar cartas: ${esc(err.message)}`, true);
  } finally {
    editionsState.loading = false;
  }
}

function renderEdition() {
  const grid = $("#edition-grid");
  const cards = editionsState.cards;
  if (!cards.length) return;

  const owned = cards.filter((c) => collection[c.id]).length;
  const total = cards.length;
  const pct = total ? Math.round((owned / total) * 100) : 0;
  $("#edition-stats").innerHTML = `
    <div class="stat"><div class="stat-label">Cartas na edição</div><div class="stat-value">${total.toLocaleString("pt-PT")}</div></div>
    <div class="stat"><div class="stat-label">Já tens</div><div class="stat-value">${owned.toLocaleString("pt-PT")}</div></div>
    <div class="stat"><div class="stat-label">Completa</div><div class="stat-value">${pct}%</div></div>`;

  const missingOnly = $("#edition-missing-only").checked;
  const list = missingOnly ? cards.filter((c) => !collection[c.id]) : cards;

  grid.innerHTML = "";
  list.forEach((card) => grid.appendChild(editionCardEl(card)));
}

function editionCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";
  const price = cardPrice(card, false);

  el.innerHTML = `
    <div class="card-img-wrap" data-large="${esc(cardImage(card, "large"))}">
      <img loading="lazy" src="${esc(cardImage(card, "normal"))}" alt="${esc(card.name)}" />
    </div>
    <div class="card-body">
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-meta">Nº ${esc(card.collector_number || "?")} · ${esc((card.rarity || "").toUpperCase())}</div>
      <div class="card-price">${price ? eur(price) : "—"}</div>
      <div class="card-actions"></div>
    </div>`;

  const actions = el.querySelector(".card-actions");
  makeOwnToggle(card, el, actions, () => {
    // Se o filtro "só em falta" estiver ativo, refaz a lista; senão só as estatísticas.
    if ($("#edition-missing-only").checked) renderEdition();
    else refreshEditionStats();
  })();

  el.querySelector(".card-img-wrap").addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openPreview(el.querySelector(".card-img-wrap").dataset.large);
  });

  return el;
}

function refreshEditionStats() {
  const cards = editionsState.cards;
  if (!cards.length) return;
  const owned = cards.filter((c) => collection[c.id]).length;
  const total = cards.length;
  const pct = total ? Math.round((owned / total) * 100) : 0;
  const values = $("#edition-stats").querySelectorAll(".stat-value");
  if (values.length === 3) {
    values[1].textContent = owned.toLocaleString("pt-PT");
    values[2].textContent = `${pct}%`;
  }
}

/* ============================================================
   EXPORTAR / IMPORTAR
   ============================================================ */
$("#export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `colecao-magic-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("#import-btn").addEventListener("click", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("Formato inválido");

    const merge = confirm(
      "Importar coleção:\n\n" +
      "OK = juntar à coleção atual\n" +
      "Cancelar = substituir a coleção atual"
    );

    // Ids afetados (antes + depois) para gravar/apagar na base de dados.
    const affected = new Set(Object.keys(collection));

    if (merge) {
      for (const [id, entry] of Object.entries(data)) {
        if (!collection[id]) collection[id] = entry;
      }
    } else {
      collection = data;
    }
    // Garante a regra de 1 cópia máxima.
    for (const entry of Object.values(collection)) {
      if (entry && entry.qty > 1) entry.qty = 1;
    }
    Object.keys(collection).forEach((id) => affected.add(id));
    importing = true; // não deixar snapshots parciais mexerem na coleção
    try {
      await persistMany([...affected]);
    } finally {
      importing = false;
    }
    renderCollection();
    setStatus("#collection-status", "Coleção importada com sucesso.");
  } catch (err) {
    setStatus("#collection-status", `Falha ao importar: ${esc(err.message)}`, true);
  } finally {
    e.target.value = "";
  }
});

/* ---------- Importar CSV do Moxfield ---------- */
$("#import-csv-btn").addEventListener("click", () => $("#import-csv-file").click());

$("#import-csv-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    await importMoxfieldCSV(text);
  } catch (err) {
    setStatus("#collection-status", `Falha ao importar CSV: ${esc(err.message)}`, true);
  } finally {
    e.target.value = "";
  }
});

// Interpreta CSV respeitando aspas e vírgulas dentro de campos.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pedido à Scryfall com repetição (backoff) quando há rate limit (429) ou erro de servidor.
async function scryfallCollection(identifiers) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${SCRYFALL}/cards/collection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers }),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(500 * Math.pow(2, attempt)); // 0.5s, 1s, 2s, 4s, 8s, 16s
      continue;
    }
    if (!res.ok) throw new Error(`Erro ${res.status} na Scryfall`);
    return res.json();
  }
  throw new Error("a Scryfall está a limitar os pedidos");
}

async function importMoxfieldCSV(text) {
  const rows = parseCSV(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 2) throw new Error("CSV vazio ou sem cartas.");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iEdition = col("edition");
  const iNumber = col("collector number");
  const iFoil = col("foil");
  const iProxy = col("proxy");
  if (iEdition === -1 || iNumber === -1) {
    throw new Error("Não parece um CSV do Moxfield (faltam colunas Edition / Collector Number).");
  }

  // Constrói identificadores set+collector_number e memoriza o foil de cada um.
  // Ignora cartas marcadas como Proxy (playtest/proxies usadas para jogar).
  const items = [];
  const foilByKey = {};
  let skippedProxy = 0;
  for (const r of rows.slice(1)) {
    const set = (r[iEdition] || "").trim().toLowerCase();
    const number = (r[iNumber] || "").trim();
    if (!set || !number) continue;
    if (iProxy !== -1 && /^(true|yes|1)$/i.test((r[iProxy] || "").trim())) { skippedProxy++; continue; }
    const foil = iFoil !== -1 && /foil|etched/i.test((r[iFoil] || "").trim());
    items.push({ set, collector_number: number });
    foilByKey[`${set}|${number}`] = foil;
  }
  if (!items.length) {
    throw new Error(
      skippedProxy
        ? `Nenhuma carta válida — as ${skippedProxy} cartas do CSV são proxies (playtest).`
        : "Nenhuma carta válida encontrada no CSV."
    );
  }

  let imported = 0, notFound = 0, aborted = null;
  const buffer = []; // {id, entry} ainda por gravar na base de dados

  // Grava o buffer em lotes de 400 (só remove do buffer após gravar com sucesso).
  async function flush(force) {
    while (buffer.length >= (force ? 1 : 400)) {
      const chunk = buffer.slice(0, 400);
      await window.Storage.commitMany(chunk, []);
      buffer.splice(0, 400);
    }
  }

  importing = true; // a partir daqui, os snapshots não mexem na coleção
  try {
    for (let i = 0; i < items.length; i += 75) { // 75 = limite da Scryfall por pedido
      const batch = items.slice(i, i + 75);
      setStatus("#collection-status",
        `<span class="spinner"></span>A importar do Moxfield… ${Math.min(i + 75, items.length)}/${items.length} (guardadas ${imported - buffer.length})`);
      let data;
      try {
        data = await scryfallCollection(batch);
      } catch (err) { aborted = err.message; break; }

      for (const card of (data.data || [])) {
        const foil = foilByKey[`${card.set}|${card.collector_number}`] || false;
        addToCollection(card, foil, true); // defer: gravamos por lotes
        buffer.push({ id: card.id, entry: collection[card.id] });
        imported++;
      }
      notFound += (data.not_found || []).length;

      try { await flush(false); }
      catch (err) { aborted = "falha ao guardar (" + err.message + ")"; break; }

      await sleep(90); // respeita o ritmo pedido pela Scryfall
    }

    // Grava o que sobrou.
    if (!aborted) {
      try { await flush(true); }
      catch (err) { aborted = "falha ao guardar (" + err.message + ")"; }
    }
  } finally {
    importing = false;
  }

  // Garante que os símbolos/percentagens dos sets já carregaram (evita re-render
  // que apague a mensagem final).
  await ensureSets().catch(() => {});
  renderCollection();
  if (editionsState.setsLoaded && !$("#edition-picker").hidden) renderEditionPicker();

  const saved = imported - buffer.length;
  setStatus("#collection-status",
    (aborted
      ? `Importação interrompida: ${aborted}. Guardadas ${saved} carta(s) — volta a correr o import para continuar.`
      : `Importadas ${imported} carta(s) do Moxfield.`) +
    (skippedProxy ? ` ${skippedProxy} proxy(s) ignorada(s).` : "") +
    (notFound ? ` ${notFound} não encontradas na Scryfall.` : ""),
    !!aborted);
}

/* ============================================================
   PRÉ-VISUALIZAÇÃO
   ============================================================ */
function openPreview(src) {
  if (!src) return;
  $("#preview-img").src = src;
  $("#preview").hidden = false;
}
$("#preview").addEventListener("click", () => { $("#preview").hidden = true; });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#preview").hidden = true;
});

/* ---------- helpers ---------- */
function setStatus(sel, html, isError = false) {
  const el = $(sel);
  el.innerHTML = html;
  el.classList.toggle("error", isError);
}

