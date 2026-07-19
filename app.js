/* ============================================================
   A Minha Coleção Magic
   - Dados/imagens: API pública da Scryfall (sem chave)
   - Persistência: localStorage (+ export/import JSON)
   ============================================================ */

const STORAGE_KEY = "mtg-collection-v1";
const SCRYFALL = "https://api.scryfall.com";

/* ---------- Estado ---------- */
// collection = { [cardId]: { qty, foil, card } }
let collection = loadCollection();
let searchState = { query: "", nextPage: null, loading: false };

/* ---------- Utilitários ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function loadCollection() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveCollection() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
}

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
  });
});

/* ============================================================
   PROCURAR NA SCRYFALL
   ============================================================ */
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  if (!q) return;
  searchState = { query: q, nextPage: null, loading: false };
  $("#search-results").innerHTML = "";
  $("#search-more").innerHTML = "";
  runSearch(`${SCRYFALL}/cards/search?q=${encodeURIComponent(q)}&unique=cards`);
});

async function runSearch(url) {
  if (searchState.loading) return;
  searchState.loading = true;
  setStatus("#search-status", `<span class="spinner"></span>A procurar…`);
  $("#search-more").innerHTML = "";

  try {
    const res = await fetch(url);
    if (res.status === 404) {
      setStatus("#search-status", "Nenhuma carta encontrada. Tenta outra pesquisa.");
      return;
    }
    if (!res.ok) throw new Error(`Erro ${res.status}`);
    const data = await res.json();

    setStatus("#search-status", `${data.total_cards.toLocaleString("pt-PT")} resultado(s).`);
    appendResults(data.data);

    searchState.nextPage = data.has_more ? data.next_page : null;
    if (searchState.nextPage) {
      $("#search-more").innerHTML =
        `<button class="btn" id="load-more-btn">Carregar mais</button>`;
      $("#load-more-btn").addEventListener("click", () => runSearch(searchState.nextPage));
    }
  } catch (err) {
    setStatus("#search-status", `Falha na pesquisa: ${esc(err.message)}`, true);
  } finally {
    searchState.loading = false;
  }
}

function appendResults(cards) {
  const grid = $("#search-results");
  cards.forEach((card) => grid.appendChild(searchCardEl(card)));
}

function searchCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";
  const entry = collection[card.id];
  const qty = entry ? entry.qty : 0;
  const price = cardPrice(card, false);

  el.innerHTML = `
    <div class="card-img-wrap" data-large="${esc(cardImage(card, "large"))}">
      <img loading="lazy" src="${esc(cardImage(card, "normal"))}" alt="${esc(card.name)}" />
      ${qty ? `<span class="card-qty-badge">×${qty}</span>` : ""}
    </div>
    <div class="card-body">
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-meta">${esc(card.set_name)} · ${esc((card.rarity || "").toUpperCase())}</div>
      <div class="card-price">${price ? eur(price) : "—"}</div>
      <div class="card-actions">
        <button class="btn btn-primary btn-sm add-btn">+ Adicionar</button>
      </div>
    </div>`;

  el.querySelector(".add-btn").addEventListener("click", () => {
    addToCollection(card);
    const badge = el.querySelector(".card-qty-badge");
    const newQty = collection[card.id].qty;
    if (badge) badge.textContent = `×${newQty}`;
    else el.querySelector(".card-img-wrap").insertAdjacentHTML(
      "beforeend", `<span class="card-qty-badge">×${newQty}</span>`);
  });

  el.querySelector(".card-img-wrap").addEventListener("click", (e) => {
    if (e.target.classList.contains("add-btn")) return;
    openPreview(el.querySelector(".card-img-wrap").dataset.large);
  });

  return el;
}

/* ============================================================
   COLEÇÃO — adicionar / remover
   ============================================================ */
function addToCollection(card, foil = false) {
  const id = card.id;
  if (collection[id]) {
    collection[id].qty += 1;
  } else {
    collection[id] = {
      qty: 1,
      foil,
      addedAt: Date.now(),
      card: slimCard(card),
    };
  }
  saveCollection();
}

// Guarda apenas os campos necessários para não encher o localStorage
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

function changeQty(id, delta) {
  if (!collection[id]) return;
  collection[id].qty += delta;
  if (collection[id].qty <= 0) delete collection[id];
  saveCollection();
  renderCollection();
}

function toggleFoil(id) {
  if (!collection[id]) return;
  collection[id].foil = !collection[id].foil;
  saveCollection();
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

  // Estatísticas
  const totalCards = entries.reduce((s, e) => s + e.qty, 0);
  const unique = entries.length;
  const totalValue = entries.reduce((s, e) => s + cardPrice(e.card, e.foil) * e.qty, 0);
  $("#collection-stats").innerHTML = `
    <div class="stat"><div class="stat-label">Cartas (total)</div><div class="stat-value">${totalCards.toLocaleString("pt-PT")}</div></div>
    <div class="stat"><div class="stat-label">Cartas únicas</div><div class="stat-value">${unique.toLocaleString("pt-PT")}</div></div>
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
      case "qty-desc": return b.qty - a.qty;
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
  const { card, qty, foil } = entry;
  const el = document.createElement("div");
  el.className = "card";
  const unit = cardPrice(card, foil);

  el.innerHTML = `
    <div class="card-img-wrap" data-large="${esc(cardImage(card, "large"))}">
      <img loading="lazy" src="${esc(cardImage(card, "normal"))}" alt="${esc(card.name)}" />
      <span class="card-qty-badge">×${qty}</span>
      ${foil ? `<span class="card-foil-badge">FOIL</span>` : ""}
    </div>
    <div class="card-body">
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-meta">${esc(card.set_name)} · Nº ${esc(card.collector_number || "?")}</div>
      <div class="card-price">${unit ? eur(unit) : "—"} <span style="color:var(--text-dim);font-weight:400">/ un.</span></div>
      <div class="card-actions">
        <div class="qty-controls">
          <button class="dec" aria-label="Menos">−</button>
          <span class="qty-num">${qty}</span>
          <button class="inc" aria-label="Mais">+</button>
        </div>
        <button class="btn btn-sm foil-btn" style="margin-left:auto">${foil ? "★ Foil" : "☆ Foil"}</button>
      </div>
    </div>`;

  el.querySelector(".dec").addEventListener("click", () => changeQty(card.id, -1));
  el.querySelector(".inc").addEventListener("click", () => changeQty(card.id, +1));
  el.querySelector(".foil-btn").addEventListener("click", () => toggleFoil(card.id));
  el.querySelector(".card-img-wrap").addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openPreview(el.querySelector(".card-img-wrap").dataset.large);
  });

  return el;
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
      "OK = juntar à coleção atual (somar quantidades)\n" +
      "Cancelar = substituir a coleção atual"
    );

    if (merge) {
      for (const [id, entry] of Object.entries(data)) {
        if (collection[id]) collection[id].qty += entry.qty || 1;
        else collection[id] = entry;
      }
    } else {
      collection = data;
    }
    saveCollection();
    renderCollection();
    setStatus("#collection-status", "Coleção importada com sucesso.");
  } catch (err) {
    setStatus("#collection-status", `Falha ao importar: ${esc(err.message)}`, true);
  } finally {
    e.target.value = "";
  }
});

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

/* ---------- Arranque ---------- */
$("#search-input").focus();
