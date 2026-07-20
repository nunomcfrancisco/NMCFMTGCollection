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

// Formatadores criados uma vez — construir um Intl.NumberFormat é caro e
// estes são usados por cada carta desenhada.
const eurFmt = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" });
const numFmt = new Intl.NumberFormat("pt-PT");

// Coladores reutilizados: String.localeCompare constrói um por chamada, o que
// pesa dentro de um sort() com milhares de comparações.
const nameCollator = new Intl.Collator("pt-PT");
// Ordena números de colecionador de forma natural ("2" < "10" < "12a").
const numberCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function eur(value) {
  return eurFmt.format(value || 0);
}

// Adia execuções seguidas (usado nas caixas de pesquisa, que disparam a cada tecla).
function debounce(fn, ms = 150) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
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

// Os dois filtros de texto são independentes: um filtra a grelha de SETS, o outro
// as CARTAS dentro de um set. Escrever num não afeta o outro.
// Debounce: escrever redesenha a grelha toda; sem isto seria a cada tecla.
$("#collection-set-filter").addEventListener("input", debounce(() => renderCollection(), 150));
$("#collection-card-filter").addEventListener("input", debounce(() => renderCollection(), 150));
$("#collection-sort").addEventListener("change", renderCollection);
$("#collection-rarity").addEventListener("change", renderCollection);
$("#collection-show-missing").addEventListener("change", renderCollection);
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
    <div class="stat"><div class="stat-label">Cartas</div><div class="stat-value">${numFmt.format(unique)}</div></div>
    <div class="stat"><div class="stat-label">Valor estimado</div><div class="stat-value">${eur(totalValue)}</div></div>`;

  if (unique === 0) {
    collectionView.setCode = null;
    $("#collection-detail").hidden = true;
    $("#collection-picker").hidden = false;
    $("#collection-stats").hidden = false;
    $("#collection-status").innerHTML = "";
    $("#collection-sets").innerHTML = `
      <div class="empty" style="grid-column: 1 / -1;">
        <h3>A tua coleção está vazia</h3>
        <p>Vai aos <strong>Sets</strong>, escolhe um set e marca as cartas que tens, ou usa <strong>Importar</strong>.</p>
      </div>`;
    return;
  }

  // Se o set escolhido já não tem cartas (ex.: removeste a última), volta à grelha.
  // Exceção: com "Mostrar cartas em falta" ativo continua a fazer sentido ver o set
  // (podes voltar a adicionar cartas dali).
  if (collectionView.setCode && !ownedInSet(collectionView.setCode) &&
      !$("#collection-show-missing").checked) {
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

// Compara números de colecionador ("1", "2", "10", "12a", "★123") de forma
// natural (numérica quando possível). asc = crescente.
function cmpCollector(a, b, asc = true) {
  const r = numberCollator.compare(String(a ?? ""), String(b ?? ""));
  return asc ? r : -r;
}

function setDisplayName(code, fallbackEntry) {
  return (setsByCode && setsByCode[code] && setsByCode[code].name) ||
    (fallbackEntry && fallbackEntry.card.set_name) || code.toUpperCase();
}

// GRELHA de edições que tens na coleção (símbolo + nome + %), estilo Edições.
function renderCollectionPicker() {
  $("#collection-detail").hidden = true;
  $("#collection-picker").hidden = false;
  $("#collection-stats").hidden = false;

  const bySet = collectionBySet();
  const filter = $("#collection-set-filter").value.trim().toLowerCase();
  // Nome e data de cada set calculados UMA vez (o sort compara O(n log n) vezes).
  const info = Object.create(null);
  for (const c of Object.keys(bySet)) {
    const name = setDisplayName(c, bySet[c][0]);
    info[c] = {
      name,
      lower: name.toLowerCase(),
      released: (setsByCode && setsByCode[c] && setsByCode[c].released_at) || "",
    };
  }

  let codes = Object.keys(bySet);
  if (filter) {
    codes = codes.filter((c) => info[c].lower.includes(filter) || c.toLowerCase().includes(filter));
  }
  codes.sort((a, b) => {
    if (info[a].released !== info[b].released) return info[b].released < info[a].released ? -1 : 1;
    return nameCollator.compare(info[a].name, info[b].name);
  });

  $("#collection-status").innerHTML = filter
    ? `${codes.length} set(s).`
    : (setsByCode ? "" : `<span class="spinner"></span>A carregar sets…`);

  const grid = $("#collection-sets");
  const frag = document.createDocumentFragment();
  codes.forEach((code) => {
    const meta = setsByCode && setsByCode[code];
    const owned = bySet[code].length;
    const total = meta ? meta.card_count : 0;
    const pct = total ? Math.round((owned / total) * 100) : null;
    const name = info[code].name;

    const cell = document.createElement("button");
    cell.className = "set-cell";
    cell.title = pct === null
      ? `${name} — ${owned} carta(s)`
      : `${name} — ${owned}/${total} (${pct}%)`;
    cell.innerHTML = `
      <img class="set-symbol" loading="lazy" src="${esc(meta ? meta.icon_svg_uri || "" : "")}" alt="" />
      <span class="set-name">${esc(name)}</span>
      <span class="set-pct">${pct === null ? owned : pct + "%"}</span>`;
    cell.addEventListener("click", () => {
      collectionView.setCode = code;
      $("#collection-show-missing").checked = false; // default: só cartas colecionadas
      // Entra no set sem filtros de carta herdados (senão a grelha podia abrir
      // vazia por causa de uma pesquisa antiga). O filtro de sets fica intacto.
      $("#collection-card-filter").value = "";
      $("#collection-rarity").value = "";
      renderCollection();
    });
    frag.appendChild(cell);
  });
  grid.innerHTML = "";
  grid.appendChild(frag);
}

// DETALHE: as tuas cartas de uma edição escolhida.
function renderCollectionDetail() {
  $("#collection-picker").hidden = true;
  $("#collection-detail").hidden = false;
  // Dentro de um set, os totais gerais (Cartas / Valor estimado) não interessam.
  $("#collection-stats").hidden = true;

  const code = collectionView.setCode;
  const meta = setsByCode && setsByCode[code];
  let entries = Object.values(collection).filter((e) => (e.card.set || "?") === code);
  const name = setDisplayName(code, entries[0]);
  const owned = entries.length;
  const total = meta ? meta.card_count : 0;
  const pct = total ? Math.round((owned / total) * 100) : null;

  // Símbolo do set antes do nome (quando já temos os metadados carregados).
  const icon = meta && meta.icon_svg_uri;
  $("#collection-set-title").innerHTML =
    (icon ? `<img class="set-symbol set-title-symbol" src="${esc(icon)}" alt="" />` : "") +
    `<span>${esc(name)}</span>`;
  $("#collection-set-stats").innerHTML =
    `<div class="stat"><div class="stat-label">Já tens</div><div class="stat-value">${numFmt.format(owned)}</div></div>` +
    (total
      ? `<div class="stat"><div class="stat-label">Cartas no set</div><div class="stat-value">${numFmt.format(total)}</div></div>
         <div class="stat"><div class="stat-label">Completa</div><div class="stat-value">${pct}%</div></div>`
      : "");

  const filter = $("#collection-card-filter").value.trim().toLowerCase();
  const rarity = $("#collection-rarity").value;
  const sort = $("#collection-sort").value;
  const grid = $("#collection-grid");
  const showMissing = $("#collection-show-missing").checked;

  // Modo "mostrar cartas em falta": mostra TODAS as cartas do set (as que faltam
  // aparecem a cinzento e com botão para adicionar). Precisa da lista completa da Scryfall.
  if (showMissing) {
    if (!setCardsCache[code]) {
      grid.innerHTML = "";
      setStatus("#collection-status", `<span class="spinner"></span>A carregar cartas do set…`);
      fetchSetCards(code)
        .then(() => { if (collectionView.setCode === code) renderCollection(); })
        .catch((err) => {
          setStatus("#collection-status", `Falha ao carregar cartas: ${esc(err.message)}`, true);
          $("#collection-show-missing").checked = false;
          if (collectionView.setCode === code) renderCollection();
        });
      return;
    }

    let cards = setCardsCache[code].slice();
    if (filter) cards = cards.filter((c) => c.name.toLowerCase().includes(filter));
    if (rarity) cards = cards.filter((c) => c.rarity === rarity);
    // Preço e data calculados UMA vez por carta (o sort chamaria isto a cada
    // comparação, ou seja O(n log n) parseFloat por render).
    const valOf = new Map(), addedOf = new Map();
    for (const c of cards) {
      const e = collection[c.id];
      valOf.set(c, e ? cardPrice(e.card, e.foil) : cardPrice(c, false));
      addedOf.set(c, (e && e.addedAt) || 0);
    }
    const val = (c) => valOf.get(c);
    const added = (c) => addedOf.get(c);
    cards.sort((a, b) => {
      switch (sort) {
        case "name-desc": return nameCollator.compare(b.name, a.name);
        case "value-desc": return val(b) - val(a);
        case "value": return val(a) - val(b);
        case "number": return cmpCollector(a.collector_number, b.collector_number, true);
        case "number-desc": return cmpCollector(a.collector_number, b.collector_number, false);
        case "recent": return added(b) - added(a);
        default: return nameCollator.compare(a.name, b.name);
      }
    });

    const missing = cards.filter((c) => !collection[c.id]).length;
    setStatus("#collection-status", `${cards.length} carta(s) · ${missing} em falta.`);

    const frag = document.createDocumentFragment();
    cards.forEach((c) => frag.appendChild(
      collection[c.id] ? collectionCardEl(collection[c.id]) : collectionMissingCardEl(c)
    ));
    grid.innerHTML = "";
    grid.appendChild(frag);
    return;
  }

  // Default: só as cartas que tens (filtro + raridade + ordenação).
  if (filter) entries = entries.filter((e) => e.card.name.toLowerCase().includes(filter));
  if (rarity) entries = entries.filter((e) => e.card.rarity === rarity);
  // Preço calculado uma vez por entrada, não a cada comparação do sort.
  const priceOf = new Map();
  if (sort === "value" || sort === "value-desc") {
    for (const e of entries) priceOf.set(e, cardPrice(e.card, e.foil));
  }
  entries.sort((a, b) => {
    switch (sort) {
      case "name-desc": return nameCollator.compare(b.card.name, a.card.name);
      case "value-desc": return priceOf.get(b) - priceOf.get(a);
      case "value": return priceOf.get(a) - priceOf.get(b);
      case "number": return cmpCollector(a.card.collector_number, b.card.collector_number, true);
      case "number-desc": return cmpCollector(a.card.collector_number, b.card.collector_number, false);
      case "recent": return (b.addedAt || 0) - (a.addedAt || 0);
      default: return nameCollator.compare(a.card.name, b.card.name);
    }
  });

  $("#collection-status").innerHTML = filter ? `${entries.length} carta(s).` : "";

  const frag = document.createDocumentFragment();
  entries.forEach((entry) => frag.appendChild(collectionCardEl(entry)));
  grid.innerHTML = "";
  grid.appendChild(frag);
}

// Carta em falta na Coleção (não colecionada): a cinzento, com botão para adicionar.
function collectionMissingCardEl(card) {
  const el = document.createElement("div");
  el.className = "card not-owned";
  const price = cardPrice(card, false);

  el.innerHTML = `
    <div class="card-img-wrap" data-large="${esc(cardImage(card, "large"))}">
      <img loading="lazy" src="${esc(cardImage(card, "small"))}" alt="${esc(card.name)}" />
    </div>
    <div class="card-body">
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-meta">Nº ${esc(card.collector_number || "?")} · ${esc((card.rarity || "").toUpperCase())}</div>
      <div class="card-price">${price ? eur(price) : "—"}</div>
      <div class="card-actions"></div>
    </div>`;

  const actions = el.querySelector(".card-actions");
  makeOwnToggle(card, el, actions, () => renderCollection())();

  const imgWrap = el.querySelector(".card-img-wrap");
  imgWrap.addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openPreview(imgWrap.dataset.large);
  });

  return el;
}

function collectionCardEl(entry) {
  const { card, foil } = entry;
  const el = document.createElement("div");
  el.className = "card";
  const unit = cardPrice(card, foil);

  el.innerHTML = `
    <div class="card-img-wrap" data-large="${esc(cardImage(card, "large"))}">
      <img loading="lazy" src="${esc(cardImage(card, "small"))}" alt="${esc(card.name)}" />
      ${foil ? `<span class="card-foil-badge">FOIL</span>` : ""}
    </div>
    <div class="card-body">
      <div class="card-meta">Nº ${esc(card.collector_number || "?")}</div>
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
  const imgWrap = el.querySelector(".card-img-wrap");
  imgWrap.addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openPreview(imgWrap.dataset.large);
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

// Cache das cartas de cada set (por código), partilhada por Sets e Coleção —
// evita voltar a puxar a lista completa da Scryfall ao alternar de vista.
const setCardsCache = {};

// Puxa TODAS as cartas de um set da Scryfall (percorrendo as páginas).
async function fetchSetCards(code) {
  if (setCardsCache[code]) return setCardsCache[code];
  let url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(`set:${code} unique:prints`)}&order=set`;
  const all = [];
  while (url) {
    const res = await fetch(url);
    if (res.status === 404) break; // set sem cartas pesquisáveis
    if (!res.ok) throw new Error(`Erro ${res.status}`);
    const data = await res.json();
    all.push(...data.data);
    url = data.has_more ? data.next_page : null;
  }
  setCardsCache[code] = all;
  return all;
}

// Cache local da lista de sets (não muda quase nunca) — evita puxar ~1 MB a cada visita.
const SETS_CACHE_KEY = "mtg-sets-cache-v2";
const SETS_TTL = 24 * 60 * 60 * 1000; // 1 dia

function readSetsCache(ignoreAge) {
  try {
    const raw = JSON.parse(localStorage.getItem(SETS_CACHE_KEY));
    if (raw && Array.isArray(raw.list) && (ignoreAge || Date.now() - raw.ts < SETS_TTL)) return raw.list;
  } catch {}
  return null;
}
function writeSetsCache(list) {
  try { localStorage.setItem(SETS_CACHE_KEY, JSON.stringify({ ts: Date.now(), list })); } catch {}
}

// Carrega a lista de sets uma única vez (partilhada entre vistas), usando cache local.
async function ensureSets() {
  if (setsByCode) return setsByCode;
  if (!ensureSets._p) {
    ensureSets._p = (async () => {
      let list = readSetsCache(false); // cache fresca (< 1 dia)?
      if (!list) {
        try {
          const res = await fetch(`${SCRYFALL}/sets`);
          if (!res.ok) throw new Error(`Erro ${res.status}`);
          const data = await res.json();
          // Guarda só os campos usados, para a cache ser pequena.
          list = (data.data || []).map((s) => ({
            code: s.code, name: s.name, icon_svg_uri: s.icon_svg_uri,
            card_count: s.card_count, released_at: s.released_at, digital: s.digital,
            set_type: s.set_type,
          }));
          writeSetsCache(list);
        } catch (err) {
          list = readSetsCache(true); // sem ligação: usa cache mesmo que velha
          if (!list) throw err;
        }
      }
      const map = {};
      for (const s of list) map[s.code] = s;
      setsByCode = map;
      // Alimenta também a grelha das Edições (só sets com cartas reais).
      // Exclui "Art Series" (só arte) e sets de tokens (set_type "token") —
      // nenhum são cartas jogáveis para a coleção.
      editionsState.sets = list
        .filter((s) =>
          s.card_count > 0 && !s.digital &&
          s.set_type !== "token" && !/art series/i.test(s.name))
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

// Contagem por código de set numa única passagem pela coleção. Usar isto quando
// se precisa do total de MUITOS sets de seguida (ex.: a grelha de ~900 sets):
// chamar ownedInSet() por set seria O(sets × coleção).
function ownedCountBySet() {
  const counts = Object.create(null);
  for (const e of Object.values(collection)) {
    const code = e.card && e.card.set;
    if (code) counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

async function initEditions() {
  if (editionsState.setsLoaded) { renderEditionPicker(); return; }
  if (editionsState.loading) return;
  editionsState.loading = true;
  setStatus("#edition-status", `<span class="spinner"></span>A carregar sets…`);
  try {
    await ensureSets();
    setStatus("#edition-status", "");
    renderEditionPicker();
  } catch (err) {
    setStatus("#edition-status", `Falha ao carregar sets: ${esc(err.message)}`, true);
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

  const counts = ownedCountBySet();
  const frag = document.createDocumentFragment();
  sets.forEach((s) => {
    const owned = counts[s.code] || 0;
    const pct = s.card_count ? Math.round((owned / s.card_count) * 100) : 0;
    const cell = document.createElement("button");
    cell.className = "set-cell";
    cell.title = `${s.name} — ${owned}/${s.card_count} (${pct}%)`;
    cell.innerHTML = `
      <img class="set-symbol" loading="lazy" src="${esc(s.icon_svg_uri || "")}" alt="" />
      <span class="set-name">${esc(s.name)}</span>
      <span class="set-pct">${pct}%</span>`;
    cell.addEventListener("click", () => openEdition(s));
    frag.appendChild(cell);
  });
  grid.innerHTML = "";
  grid.appendChild(frag);
}

function openEdition(set) {
  $("#edition-picker").hidden = true;
  $("#edition-detail").hidden = false;
  $("#edition-title").textContent = set.name;
  $("#edition-missing-only").checked = false;
  $("#edition-rarity").value = "";
  loadEditionCards(set.code);
}

$("#edition-search").addEventListener("input", debounce(() => renderEditionPicker(), 150));
$("#edition-back").addEventListener("click", () => {
  $("#edition-detail").hidden = true;
  $("#edition-picker").hidden = false;
  editionsState.setCode = "";
  editionsState.cards = [];
  renderEditionPicker(); // reflete cartas adicionadas/removidas nesta edição
});
$("#edition-missing-only").addEventListener("change", renderEdition);
$("#edition-rarity").addEventListener("change", renderEdition);

async function loadEditionCards(code) {
  editionsState.setCode = code;
  editionsState.cards = [];
  $("#edition-grid").innerHTML = "";
  $("#edition-stats").innerHTML = "";
  if (!code) return;

  editionsState.loading = true;
  setStatus("#edition-status", `<span class="spinner"></span>A carregar cartas…`);

  try {
    const all = await fetchSetCards(code);
    // Evita render de resultados antigos se o utilizador trocar de set entretanto.
    if (editionsState.setCode !== code) return;
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
    <div class="stat"><div class="stat-label">Cartas no set</div><div class="stat-value">${numFmt.format(total)}</div></div>
    <div class="stat"><div class="stat-label">Já tens</div><div class="stat-value">${numFmt.format(owned)}</div></div>
    <div class="stat"><div class="stat-label">Completa</div><div class="stat-value">${pct}%</div></div>`;

  const rarity = $("#edition-rarity").value;
  const missingOnly = $("#edition-missing-only").checked;
  let list = cards;
  if (rarity) list = list.filter((c) => c.rarity === rarity);
  if (missingOnly) list = list.filter((c) => !collection[c.id]);

  const frag = document.createDocumentFragment();
  list.forEach((card) => frag.appendChild(editionCardEl(card)));
  grid.innerHTML = "";
  grid.appendChild(frag);
}

function editionCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";
  const price = cardPrice(card, false);

  el.innerHTML = `
    <div class="card-img-wrap" data-large="${esc(cardImage(card, "large"))}">
      <img loading="lazy" src="${esc(cardImage(card, "small"))}" alt="${esc(card.name)}" />
    </div>
    <div class="card-body">
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

  const imgWrap = el.querySelector(".card-img-wrap");
  imgWrap.addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openPreview(imgWrap.dataset.large);
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
    values[1].textContent = numFmt.format(owned);
    values[2].textContent = `${pct}%`;
  }
}

/* ============================================================
   EXPORTAR / IMPORTAR / APAGAR (vista Definições)
   ------------------------------------------------------------
   O estado destas ações vai para #settings-status, junto dos botões: se
   fosse para #collection-status, o utilizador ficaria noutra vista sem ver
   o progresso, e os re-renders da coleção apagariam a mensagem.
   ============================================================ */
const ACTION_STATUS = "#settings-status";

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

/* ---------- Apagar toda a coleção ---------- */
$("#clear-btn").addEventListener("click", async () => {
  const ids = Object.keys(collection);
  if (!ids.length) {
    setStatus(ACTION_STATUS, "A coleção já está vazia.");
    return;
  }
  const ok = confirm(
    `Apagar TODAS as ${ids.length} cartas da coleção?\n\n` +
    `Isto remove-as da base de dados e não pode ser desfeito. ` +
    `Se quiseres um backup, cancela e usa Exportar primeiro.`
  );
  if (!ok) return;

  setStatus(ACTION_STATUS, `<span class="spinner"></span>A apagar…`);
  importing = true; // evita que snapshots parciais mexam na coleção
  try {
    if (window.Storage && window.Storage.commitMany) {
      await window.Storage.commitMany([], ids); // apaga em lotes
    }
    collection = {};
    collectionView.setCode = null;
    renderCollection();
    setStatus(ACTION_STATUS, "Coleção apagada.");
  } catch (err) {
    setStatus(ACTION_STATUS, `Falha ao apagar: ${esc(err.message)} — recarrega a página.`, true);
  } finally {
    importing = false;
  }
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
    setStatus(ACTION_STATUS, "Coleção importada com sucesso.");
  } catch (err) {
    setStatus(ACTION_STATUS, `Falha ao importar: ${esc(err.message)}`, true);
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
    setStatus(ACTION_STATUS, `Falha ao importar CSV: ${esc(err.message)}`, true);
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
      setStatus(ACTION_STATUS,
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
  setStatus(ACTION_STATUS,
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

