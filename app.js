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
function persistMany(ids) { ids.forEach(persist); }

/* ---------- Ponte com a camada de dados (auth.js) ---------- */
// Devolve a coleção atual (usada ao gravar na base de dados).
window.getCollection = () => collection;

// Substitui a coleção com os dados vindos da base de dados (não re-grava).
window.applyRemoteCollection = (data) => {
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
    if (view === "collection") renderCollection();
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
function addToCollection(card, foil = false) {
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
  persist(id);
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
$("#collection-filter").addEventListener("input", renderCollection);
$("#collection-sort").addEventListener("change", renderCollection);

function renderCollection() {
  const grid = $("#collection-grid");
  const entries = Object.values(collection);

  // Estatísticas (máx. 1 cópia por carta → total = nº de cartas únicas)
  const unique = entries.length;
  const totalValue = entries.reduce((s, e) => s + cardPrice(e.card, e.foil), 0);
  $("#collection-stats").innerHTML = `
    <div class="stat"><div class="stat-label">Cartas</div><div class="stat-value">${unique.toLocaleString("pt-PT")}</div></div>
    <div class="stat"><div class="stat-label">Valor estimado</div><div class="stat-value">${eur(totalValue)}</div></div>`;

  if (unique === 0) {
    $("#collection-status").innerHTML = "";
    grid.innerHTML = `
      <div class="empty" style="grid-column: 1 / -1;">
        <h3>A tua coleção está vazia</h3>
        <p>Vai a <strong>Procurar</strong>, encontra cartas e clica em “+ Adicionar”.</p>
      </div>`;
    return;
  }

  // Filtrar
  const filter = $("#collection-filter").value.trim().toLowerCase();
  let list = entries.filter((e) =>
    !filter ||
    e.card.name.toLowerCase().includes(filter) ||
    (e.card.set_name || "").toLowerCase().includes(filter));

  // Ordenar
  const sort = $("#collection-sort").value;
  list.sort((a, b) => {
    switch (sort) {
      case "name-desc": return b.card.name.localeCompare(a.card.name);
      case "value-desc": return cardPrice(b.card, b.foil) - cardPrice(a.card, a.foil);
      case "value": return cardPrice(a.card, a.foil) - cardPrice(b.card, b.foil);
      case "recent": return (b.addedAt || 0) - (a.addedAt || 0);
      default: return a.card.name.localeCompare(b.card.name);
    }
  });

  $("#collection-status").innerHTML = filter
    ? `${list.length} de ${unique} cartas únicas.`
    : "";

  grid.innerHTML = "";
  list.forEach((entry) => grid.appendChild(collectionCardEl(entry)));
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

// Nº de cartas na coleção pertencentes a um dado código de set.
function ownedInSet(code) {
  let n = 0;
  for (const e of Object.values(collection)) {
    if (e.card && e.card.set === code) n++;
  }
  return n;
}

async function initEditions() {
  if (editionsState.setsLoaded || editionsState.loading) return;
  editionsState.loading = true;
  setStatus("#edition-status", `<span class="spinner"></span>A carregar edições…`);
  try {
    const res = await fetch(`${SCRYFALL}/sets`);
    if (!res.ok) throw new Error(`Erro ${res.status}`);
    const data = await res.json();

    // Só edições com cartas reais (ignora tokens/memorabilia sem cartas), ordenadas por data.
    editionsState.sets = (data.data || [])
      .filter((s) => s.card_count > 0 && !s.digital)
      .sort((a, b) => (b.released_at || "").localeCompare(a.released_at || ""));

    editionsState.setsLoaded = true;
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
    persistMany([...affected]);
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

  let imported = 0, notFound = 0;
  const batchSize = 75; // limite da Scryfall
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    setStatus("#collection-status",
      `<span class="spinner"></span>A importar do Moxfield… ${Math.min(i + batchSize, items.length)}/${items.length}`);
    const res = await fetch(`${SCRYFALL}/cards/collection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: batch }),
    });
    if (!res.ok) throw new Error(`Erro ${res.status} na Scryfall`);
    const data = await res.json();
    (data.data || []).forEach((card) => {
      const foil = foilByKey[`${card.set}|${card.collector_number}`] || false;
      addToCollection(card, foil);
      imported++;
    });
    notFound += (data.not_found || []).length;
    if (i + batchSize < items.length) await new Promise((r) => setTimeout(r, 100));
  }

  renderCollection();
  if (editionsState.setsLoaded && !$("#edition-picker").hidden) renderEditionPicker();
  setStatus("#collection-status",
    `Importadas ${imported} carta(s) do Moxfield.` +
    (skippedProxy ? ` ${skippedProxy} proxy(s) ignorada(s).` : "") +
    (notFound ? ` ${notFound} não foram encontradas na Scryfall.` : ""));
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

