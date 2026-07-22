/* ============================================================
   My Magic Collection
   - Data/images: Scryfall public API (no key)
   - Persistence: Firestore database (Firebase) — see auth.js.
     The offline cache is handled by Firestore itself.
   ============================================================ */

const SCRYFALL = "https://api.scryfall.com";

/* ---------- State ---------- */
// collection = { [cardId]: { qty, foil, card } }
// Starts empty; the data layer (auth.js) loads it from the database
// as soon as a session is active.
let collection = {};

// While true, Firestore snapshots don't touch the in-memory collection
// — during an import it is the source of truth (otherwise the partial
// snapshots of each batch would delete cards not yet written).
let importing = false;

/* ---------- Utilities ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ---------- Persistence (delegated to the data layer / auth.js) ---------- */
// Writes to the database: if the card exists in memory, upsert; otherwise remove.
function persist(id) {
  if (!window.Storage) return;
  if (collection[id]) window.Storage.upsert(id, collection[id]);
  else window.Storage.remove(id);
}
// Writes many cards at once (in a batch) — avoids bursts of individual
// writes that break the Firestore SDK on large imports.
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

/* ---------- Bridge with the data layer (auth.js) ---------- */
// Returns the current collection (used when writing to the database).
window.getCollection = () => collection;

// Replaces the collection with the data from the database (does not re-write).
window.applyRemoteCollection = (data) => {
  if (importing) return; // during an import, ignore snapshots (see 'importing')
  collection = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  // Enforce the max-1-copy rule.
  for (const entry of Object.values(collection)) {
    if (entry && entry.qty > 1) entry.qty = 1;
  }
  renderCollection();
  // Update the sets view (set grid and/or the open set detail).
  if (editionsState.setsLoaded && !$("#edition-picker").hidden) renderEditionPicker();
  if (editionsState.cards.length && !$("#edition-detail").hidden) renderEdition();
};

// Formatters created once — building an Intl.NumberFormat is expensive and
// these are used for every card drawn.
const eurFmt = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const numFmt = new Intl.NumberFormat("en-GB");

// Reused collators: String.localeCompare builds one per call, which is
// costly inside a sort() with thousands of comparisons.
const nameCollator = new Intl.Collator("en");
// Sorts collector numbers naturally ("2" < "10" < "12a").
const numberCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function eur(value) {
  return eurFmt.format(value || 0);
}

// Defers repeated calls (used in the search boxes, which fire on every keystroke).
function debounce(fn, ms = 150) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Card price in EUR (Scryfall gives EUR and USD). Uses EUR; falls back to USD*0.92.
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
  // Double-faced cards have their images in card_faces
  if (card.image_uris) return card.image_uris[size] || card.image_uris.normal;
  if (card.card_faces && card.card_faces[0].image_uris) {
    return card.card_faces[0].image_uris[size] || card.card_faces[0].image_uris.normal;
  }
  return "";
}

// Default filters passed to Cardmarket: English cards, sellers in Portugal,
// minimum card condition Near Mint.
// (language=1 → English; sellerCountry=26 → Portugal; minCondition=2 → Near Mint,
//  matching Cardmarket's IDs — 1=MT, 2=NM, 3=EX, 4=GD, 5=LP, 6=PL, 7=PO.)
const CARDMARKET_FILTERS = { language: 1, sellerCountry: 26, minCondition: 2 };

// Applies the default filters to a Cardmarket URL. Uses set() so our values
// override any params already on the URL — older collection entries carry a
// Scryfall product URL that already embeds e.g. language=8 (Portuguese), and a
// naive append would leave a duplicate key that Cardmarket resolves to the
// wrong value while dropping the rest of our filters.
function withCardmarketFilters(url) {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(CARDMARKET_FILTERS)) {
      u.searchParams.set(k, v);
    }
    return u.toString();
  } catch {
    // Fallback for unexpected (e.g. relative) URLs: append naively.
    const sep = url.includes("?") ? "&" : "?";
    const qs = Object.entries(CARDMARKET_FILTERS)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return url + sep + qs;
  }
}

// Cardmarket link for a card. Prefers Scryfall's precise product URL
// (purchase_uris.cardmarket); falls back to a Cardmarket search by name
// for older collection entries that don't carry that field.
function cardmarketUrl(card) {
  if (card && card.purchase_uris && card.purchase_uris.cardmarket) {
    return withCardmarketFilters(card.purchase_uris.cardmarket);
  }
  const name = (card && card.name) || "";
  return withCardmarketFilters(
    "https://www.cardmarket.com/en/Magic/Products/Search?searchString=" +
    encodeURIComponent(name)
  );
}

// Resolves the precise Cardmarket product URL, fetching the missing
// purchase_uris from Scryfall on demand. Older collection entries were stored
// before slimCard kept purchase_uris; without it the link falls back to a name
// search that the site redirects, dropping our language/sellerCountry filters.
// The fetched value is persisted, so each card is resolved at most once.
// Falls back to the search URL if Scryfall can't be reached.
async function resolveCardmarketUrl(card) {
  if (!card || (card.purchase_uris && card.purchase_uris.cardmarket) || !card.id) {
    return cardmarketUrl(card);
  }
  try {
    const data = await scryfallCollection([{ id: card.id }]);
    const fresh = (data.data || [])[0];
    if (fresh && fresh.purchase_uris) {
      card.purchase_uris = fresh.purchase_uris; // also patches the stored entry
      const entry = collection[card.id];
      if (entry && window.Storage) window.Storage.upsert(card.id, entry);
    }
  } catch { /* offline / rate-limited: fall through to the search URL */ }
  return cardmarketUrl(card);
}

// Opens the card's Cardmarket page in a new tab.
function openCardmarket(card) {
  // Fast path: the product URL is already known — open it directly.
  if (card && card.purchase_uris && card.purchase_uris.cardmarket) {
    window.open(cardmarketUrl(card), "_blank", "noopener");
    return;
  }
  // Otherwise open the tab now — synchronously, inside the click gesture, so
  // it isn't popup-blocked — then point it at the product URL once Scryfall
  // resolves it. (No noopener here: we need the handle to set its location.)
  const tab = window.open("about:blank", "_blank");
  resolveCardmarketUrl(card).then((url) => {
    if (tab && !tab.closed) tab.location.href = url;
    else window.open(url, "_blank", "noopener");
  });
}

// Shows a loader (spinner) while the card image loads and fades it in
// when ready. Handles the case where the image is already cached.
function wireCardImageLoader(imgWrap) {
  if (!imgWrap) return;
  const img = imgWrap.querySelector("img");
  if (!img) return;
  const done = () => imgWrap.classList.add("img-loaded");
  if (img.complete && img.naturalWidth > 0) { done(); return; }
  img.addEventListener("load", done, { once: true });
  img.addEventListener("error", done, { once: true }); // avoids an infinite spinner
}

/* ---------- Escape HTML (security) ---------- */
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Rarity abbreviated to its first letter: C(ommon), U(ncommon), R(are), M(ythic).
function rarityLetter(rarity) {
  return ({ common: "C", uncommon: "U", rare: "R", mythic: "M" }[rarity] ||
    (rarity ? rarity[0].toUpperCase() : ""));
}

// Rarity letter colored by rarity (C white, U gray, R yellow, M orange).
function rarityLetterHtml(rarity) {
  const letter = rarityLetter(rarity);
  if (!letter) return "";
  const key = ["common", "uncommon", "rare", "mythic"].includes(rarity) ? rarity : "other";
  return `<span class="rarity-letter rarity-${key}">${letter}</span>`;
}

/* ============================================================
   NAVIGATION BETWEEN VIEWS
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
    if (view === "stats") renderStats();
    // Every new view starts at the top, not at the previous scroll position.
    window.scrollTo(0, 0);
  });
});

/* Button that toggles adding/removing the card (max. 1 copy).
   Used in Sets. Returns a function that rebuilds the visual state.
   `afterToggle` runs after each ownership change. */
function makeOwnToggle(card, cardEl, actionsEl, afterToggle) {
  function sync() {
    const owned = !!collection[card.id];
    cardEl.classList.toggle("not-owned", !owned);
    actionsEl.innerHTML = owned
      ? `<button class="btn btn-sm remove-btn">✓ In collection · Remove</button>`
      : `<button class="btn btn-primary btn-sm add-btn">+ Add</button>`;
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
   COLLECTION — add / remove
   ============================================================ */
function addToCollection(card, foil = false, defer = false) {
  const id = card.id;
  // At most 1 copy: if it already exists, just ensure qty = 1 (and update foil).
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
  // defer = leave the write for a later batch (used in imports).
  if (!defer) persist(id);
}

function removeFromCollection(id) {
  if (!collection[id]) return;
  delete collection[id];
  persist(id);
}

// Keeps only the necessary fields so as not to bloat the database
function slimCard(card) {
  return {
    id: card.id,
    name: card.name,
    set: card.set,
    set_name: card.set_name,
    rarity: card.rarity,
    collector_number: card.collector_number,
    prices: card.prices,
    purchase_uris: card.purchase_uris,
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
   "%" VIEW — general statistics + chart by rarity
   ============================================================ */
// Rarities in the order they appear in the chart/legend. The colors match
// the rarity letters on the cards (.rarity-* in the CSS).
const RARITY_CHART = [
  { key: "common", label: "Common", color: "#e7ecff" },
  { key: "uncommon", label: "Uncommon", color: "#9aa0a6" },
  { key: "rare", label: "Rare", color: "#f2c94c" },
  { key: "mythic", label: "Mythic", color: "#ff8c42" },
  { key: "other", label: "Other", color: "#7a83b8" },
];

function renderStats() {
  const entries = Object.values(collection);
  const unique = entries.length;
  const totalValue = entries.reduce((s, e) => s + cardPrice(e.card, e.foil), 0);

  $("#stats-summary").innerHTML = `
    <div class="stat"><div class="stat-label">Cards</div><div class="stat-value">${numFmt.format(unique)}</div></div>
    <div class="stat"><div class="stat-label">Estimated value</div><div class="stat-value">${eur(totalValue)}</div></div>`;

  renderRarityChart(entries);
}

// Pie (donut) chart with the number of cards by rarity.
function renderRarityChart(entries) {
  const el = $("#rarity-chart");
  if (!el) return;

  const total = entries.length;
  if (total === 0) {
    el.innerHTML = `<p class="hint" style="margin:0;">You don't have any cards in your collection yet.</p>`;
    return;
  }

  const counts = {};
  for (const o of RARITY_CHART) counts[o.key] = 0;
  for (const e of entries) {
    const r = e.card.rarity;
    counts[r in counts ? r : "other"]++;
  }

  // Only rarities with at least one card enter the chart.
  const segs = RARITY_CHART.filter((o) => counts[o.key] > 0);

  // conic-gradient: one arc per rarity, proportional to the count.
  let acc = 0;
  const stops = segs.map((o) => {
    const start = (acc / total) * 360;
    acc += counts[o.key];
    const end = (acc / total) * 360;
    return `${o.color} ${start}deg ${end}deg`;
  }).join(", ");

  const legend = segs.map((o) => {
    const pct = Math.round((counts[o.key] / total) * 100);
    return `<li class="rarity-legend-item">
        <span class="rarity-swatch" style="background:${o.color}"></span>
        <span class="rarity-legend-label">${o.label}</span>
        <span class="rarity-legend-count">${numFmt.format(counts[o.key])} · ${pct}%</span>
      </li>`;
  }).join("");

  el.innerHTML = `
    <div class="rarity-pie" style="background: conic-gradient(${stops});">
      <div class="rarity-pie-center">
        <span class="rarity-pie-total">${numFmt.format(total)}</span>
        <span class="rarity-pie-total-label">cards</span>
      </div>
    </div>
    <ul class="rarity-legend">${legend}</ul>`;
}

/* ============================================================
   COLLECTION RENDER
   ============================================================ */
// Collection view state: setCode = null → set grid; otherwise → detail.
let collectionView = { setCode: null };

// The two text filters are independent: one filters the SETS grid, the other
// the CARDS within a set. Typing in one doesn't affect the other.
// Debounce: typing redraws the whole grid; without this it would be per keystroke.
$("#collection-set-filter").addEventListener("input", debounce(() => renderCollection(), 150));
$("#collection-card-filter").addEventListener("input", debounce(() => renderCollection(), 150));
$("#collection-sort").addEventListener("change", renderCollection);
$("#collection-rarity").addEventListener("change", renderCollection);
$("#collection-show-missing").addEventListener("change", renderCollection);
$("#collection-back").addEventListener("click", () => {
  collectionView.setCode = null;
  renderCollection();
  window.scrollTo(0, 0);
});

function renderCollection() {
  const entries = Object.values(collection);
  const unique = entries.length;

  // The general statistics (Cards / Value / chart) live in the "%" view.
  renderStats();

  if (unique === 0) {
    collectionView.setCode = null;
    $("#collection-detail").hidden = true;
    $("#collection-picker").hidden = false;
    $("#collection-status").innerHTML = "";
    $("#collection-sets").innerHTML = `
      <div class="empty" style="grid-column: 1 / -1;">
        <h3>Your collection is empty</h3>
        <p>Go to <strong>Sets</strong>, pick a set and mark the cards you have, or use <strong>Import</strong>.</p>
      </div>`;
    return;
  }

  // If the chosen set no longer has cards (e.g. you removed the last one), go back to the grid.
  // Exception: with "Show missing cards" active it still makes sense to view the set
  // (you can add cards back from there).
  if (collectionView.setCode && !ownedInSet(collectionView.setCode) &&
      !$("#collection-show-missing").checked) {
    collectionView.setCode = null;
  }

  if (collectionView.setCode) renderCollectionDetail();
  else renderCollectionPicker();

  // Load the set symbols/percentages ONCE and re-render when they arrive.
  // The guard avoids attaching several .then (which would cause repeated
  // re-renders that clear the status).
  if (!setsByCode && !collectionView.loadingSets) {
    collectionView.loadingSets = true;
    ensureSets().then(renderCollection).catch(() => {});
  }
}

// Groups the collection by set code.
function collectionBySet() {
  const bySet = {};
  for (const e of Object.values(collection)) {
    const code = e.card.set || "?";
    (bySet[code] ||= []).push(e);
  }
  return bySet;
}

// Compares collector numbers ("1", "2", "10", "12a", "★123") naturally
// (numeric when possible). asc = ascending.
function cmpCollector(a, b, asc = true) {
  const r = numberCollator.compare(String(a ?? ""), String(b ?? ""));
  return asc ? r : -r;
}

function setDisplayName(code, fallbackEntry) {
  return (setsByCode && setsByCode[code] && setsByCode[code].name) ||
    (fallbackEntry && fallbackEntry.card.set_name) || code.toUpperCase();
}

// GRID of sets you have in your collection (symbol + name + %), Sets style.
function renderCollectionPicker() {
  $("#collection-detail").hidden = true;
  $("#collection-picker").hidden = false;

  const bySet = collectionBySet();
  const filter = $("#collection-set-filter").value.trim().toLowerCase();
  // Name and date of each set computed ONCE (the sort compares O(n log n) times).
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
    : (setsByCode ? "" : `<span class="spinner"></span>Loading sets…`);

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
      ? `${name} — ${owned} card(s)`
      : `${name} — ${owned}/${total} (${pct}%)`;
    cell.innerHTML = `
      <img class="set-symbol" loading="lazy" src="${esc(meta ? meta.icon_svg_uri || "" : "")}" alt="" />
      <span class="set-name">${esc(name)}</span>
      <span class="set-pct">${pct === null ? owned : pct + "%"}</span>`;
    cell.addEventListener("click", () => {
      collectionView.setCode = code;
      $("#collection-show-missing").checked = false; // default: only owned cards
      // Enters the set without inherited card filters (otherwise the grid could
      // open empty because of an old search). The sets filter stays intact.
      $("#collection-card-filter").value = "";
      $("#collection-rarity").value = "";
      renderCollection();
    });
    frag.appendChild(cell);
  });
  grid.innerHTML = "";
  grid.appendChild(frag);
}

// DETAIL: your cards from a chosen set.
function renderCollectionDetail() {
  $("#collection-picker").hidden = true;
  $("#collection-detail").hidden = false;
  window.scrollTo(0, 0);

  const code = collectionView.setCode;
  const meta = setsByCode && setsByCode[code];
  let entries = Object.values(collection).filter((e) => (e.card.set || "?") === code);
  const name = setDisplayName(code, entries[0]);
  const owned = entries.length;
  const total = meta ? meta.card_count : 0;
  const pct = total ? Math.round((owned / total) * 100) : null;

  // Set symbol before the name (once the metadata is loaded).
  const icon = meta && meta.icon_svg_uri;
  $("#collection-set-title").innerHTML =
    (icon ? `<img class="set-symbol set-title-symbol" src="${esc(icon)}" alt="" />` : "") +
    `<span>${esc(name)}</span>`;
  $("#collection-set-stats").innerHTML =
    `<div class="stat"><div class="stat-label">You have</div><div class="stat-value">${numFmt.format(owned)}</div></div>` +
    (total
      ? `<div class="stat"><div class="stat-label">Cards in set</div><div class="stat-value">${numFmt.format(total)}</div></div>
         <div class="stat"><div class="stat-label">Complete</div><div class="stat-value">${pct}%</div></div>`
      : "");

  const filter = $("#collection-card-filter").value.trim().toLowerCase();
  const rarity = $("#collection-rarity").value;
  const sort = $("#collection-sort").value;
  const grid = $("#collection-grid");
  const showMissing = $("#collection-show-missing").checked;

  // "Show missing cards" mode: shows ALL cards of the set (the missing ones
  // appear grayed out with an add button). Needs the full list from Scryfall.
  if (showMissing) {
    if (!setCardsCache[code]) {
      grid.innerHTML = "";
      setStatus("#collection-status", `<span class="spinner"></span>Loading set cards…`);
      fetchSetCards(code)
        .then(() => { if (collectionView.setCode === code) renderCollection(); })
        .catch((err) => {
          setStatus("#collection-status", `Failed to load cards: ${esc(err.message)}`, true);
          $("#collection-show-missing").checked = false;
          if (collectionView.setCode === code) renderCollection();
        });
      return;
    }

    let cards = setCardsCache[code].slice();
    if (filter) cards = cards.filter((c) => c.name.toLowerCase().includes(filter));
    if (rarity) cards = cards.filter((c) => c.rarity === rarity);
    // Price and date computed ONCE per card (the sort would call this on every
    // comparison, i.e. O(n log n) parseFloat per render).
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
    setStatus("#collection-status", `${cards.length} card(s) · ${missing} missing.`);

    const frag = document.createDocumentFragment();
    cards.forEach((c) => frag.appendChild(
      collection[c.id] ? collectionCardEl(collection[c.id]) : collectionMissingCardEl(c)
    ));
    grid.innerHTML = "";
    grid.appendChild(frag);
    return;
  }

  // Default: only the cards you have (filter + rarity + sorting).
  if (filter) entries = entries.filter((e) => e.card.name.toLowerCase().includes(filter));
  if (rarity) entries = entries.filter((e) => e.card.rarity === rarity);
  // Price computed once per entry, not on every sort comparison.
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

  $("#collection-status").innerHTML = filter ? `${entries.length} card(s).` : "";

  const frag = document.createDocumentFragment();
  entries.forEach((entry) => frag.appendChild(collectionCardEl(entry)));
  grid.innerHTML = "";
  grid.appendChild(frag);
}

// Missing card in the Collection (not owned): grayed out, with an add button.
function collectionMissingCardEl(card) {
  const el = document.createElement("div");
  el.className = "card not-owned";
  const price = cardPrice(card, false);

  el.innerHTML = `
    <div class="card-img-wrap" data-large="${esc(cardImage(card, "large"))}">
      <img loading="lazy" src="${esc(cardImage(card, "small"))}" alt="${esc(card.name)}" />
    </div>
    <div class="card-body">
      <div class="card-meta">No. ${esc(card.collector_number || "?")} · ${rarityLetterHtml(card.rarity)}</div>
      <div class="card-price">${price ? eur(price) : "—"}</div>
      <div class="card-actions"></div>
    </div>`;

  const actions = el.querySelector(".card-actions");
  makeOwnToggle(card, el, actions, () => renderCollection())();

  const imgWrap = el.querySelector(".card-img-wrap");
  wireCardImageLoader(imgWrap);
  imgWrap.addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openCardmarket(card);
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
      <div class="card-meta">No. ${esc(card.collector_number || "?")} · ${rarityLetterHtml(card.rarity)}</div>
      <div class="card-price">${unit ? eur(unit) : "—"}</div>
      <div class="card-actions">
        <button class="btn btn-sm foil-btn">${foil ? "★ Foil" : "☆ Foil"}</button>
        <button class="btn btn-sm remove-btn" style="margin-left:auto">🗑 Remove</button>
      </div>
    </div>`;

  el.querySelector(".foil-btn").addEventListener("click", () => toggleFoil(card.id));
  el.querySelector(".remove-btn").addEventListener("click", () => {
    removeFromCollection(card.id);
    renderCollection();
  });
  const imgWrap = el.querySelector(".card-img-wrap");
  wireCardImageLoader(imgWrap);
  imgWrap.addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openCardmarket(card);
  });

  return el;
}

/* ============================================================
   SETS — pick a set and see all its cards
   (those not in the collection appear in grayscale)
   ============================================================ */
let editionsState = { setsLoaded: false, loading: false, sets: [], cards: [], setCode: "" };

// code→set map (all Scryfall sets), shared by Sets and Collection.
let setsByCode = null;

// Cache of each set's cards (by code), shared by Sets and Collection —
// avoids re-fetching the full list from Scryfall when switching views.
const setCardsCache = {};

// Fetches ALL cards of a set from Scryfall (paging through the results).
async function fetchSetCards(code) {
  if (setCardsCache[code]) return setCardsCache[code];
  let url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(`set:${code} unique:prints`)}&order=set`;
  const all = [];
  while (url) {
    const res = await fetch(url);
    if (res.status === 404) break; // set with no searchable cards
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const data = await res.json();
    all.push(...data.data);
    url = data.has_more ? data.next_page : null;
  }
  setCardsCache[code] = all;
  return all;
}

// Local cache of the sets list (rarely changes) — avoids fetching ~1 MB each visit.
const SETS_CACHE_KEY = "mtg-sets-cache-v2";
const SETS_TTL = 24 * 60 * 60 * 1000; // 1 day

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

// Loads the sets list only once (shared between views), using the local cache.
async function ensureSets() {
  if (setsByCode) return setsByCode;
  if (!ensureSets._p) {
    ensureSets._p = (async () => {
      let list = readSetsCache(false); // fresh cache (< 1 day)?
      if (!list) {
        try {
          const res = await fetch(`${SCRYFALL}/sets`);
          if (!res.ok) throw new Error(`Error ${res.status}`);
          const data = await res.json();
          // Keep only the used fields, so the cache stays small.
          list = (data.data || []).map((s) => ({
            code: s.code, name: s.name, icon_svg_uri: s.icon_svg_uri,
            card_count: s.card_count, released_at: s.released_at, digital: s.digital,
            set_type: s.set_type,
          }));
          writeSetsCache(list);
        } catch (err) {
          list = readSetsCache(true); // offline: use the cache even if stale
          if (!list) throw err;
        }
      }
      const map = {};
      for (const s of list) map[s.code] = s;
      setsByCode = map;
      // Also feeds the Sets grid (only sets with real cards).
      // Excludes "Art Series" (art only) and token sets (set_type "token") —
      // none of those are playable cards for the collection.
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

// Number of cards in the collection belonging to a given set code.
function ownedInSet(code) {
  let n = 0;
  for (const e of Object.values(collection)) {
    if (e.card && e.card.set === code) n++;
  }
  return n;
}

// Count by set code in a single pass over the collection. Use this when the
// total for MANY sets is needed in a row (e.g. the grid of ~900 sets):
// calling ownedInSet() per set would be O(sets × collection).
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
  setStatus("#edition-status", `<span class="spinner"></span>Loading sets…`);
  try {
    await ensureSets();
    setStatus("#edition-status", "");
    renderEditionPicker();
  } catch (err) {
    setStatus("#edition-status", `Failed to load sets: ${esc(err.message)}`, true);
  } finally {
    editionsState.loading = false;
  }
}

// Grid of set symbols (4 per row). Each cell shows symbol, name and % in the collection.
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
  window.scrollTo(0, 0);
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
  renderEditionPicker(); // reflects cards added/removed in this set
  window.scrollTo(0, 0);
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
  setStatus("#edition-status", `<span class="spinner"></span>Loading cards…`);

  try {
    const all = await fetchSetCards(code);
    // Avoids rendering stale results if the user switches set in the meantime.
    if (editionsState.setCode !== code) return;
    editionsState.cards = all;
    setStatus("#edition-status", "");
    renderEdition();
  } catch (err) {
    setStatus("#edition-status", `Failed to load cards: ${esc(err.message)}`, true);
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
    <div class="stat"><div class="stat-label">Cards in set</div><div class="stat-value">${numFmt.format(total)}</div></div>
    <div class="stat"><div class="stat-label">You have</div><div class="stat-value">${numFmt.format(owned)}</div></div>
    <div class="stat"><div class="stat-label">Complete</div><div class="stat-value">${pct}%</div></div>`;

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
      <div class="card-meta">No. ${esc(card.collector_number || "?")} · ${rarityLetterHtml(card.rarity)}</div>
      <div class="card-price">${price ? eur(price) : "—"}</div>
      <div class="card-actions"></div>
    </div>`;

  const actions = el.querySelector(".card-actions");
  makeOwnToggle(card, el, actions, () => {
    // If the "missing only" filter is active, rebuild the list; otherwise just the stats.
    if ($("#edition-missing-only").checked) renderEdition();
    else refreshEditionStats();
  })();

  const imgWrap = el.querySelector(".card-img-wrap");
  wireCardImageLoader(imgWrap);
  imgWrap.addEventListener("click", (e) => {
    if (e.target.closest(".card-actions")) return;
    openCardmarket(card);
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
   EXPORT / IMPORT / DELETE (Settings view)
   ------------------------------------------------------------
   The status of these actions goes to #settings-status, next to the buttons:
   if it went to #collection-status, the user would be on another view without
   seeing the progress, and collection re-renders would clear the message.
   ============================================================ */
const ACTION_STATUS = "#settings-status";

$("#export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(collection, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `magic-collection-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ---------- Delete the whole collection ---------- */
$("#clear-btn").addEventListener("click", async () => {
  const ids = Object.keys(collection);
  if (!ids.length) {
    setStatus(ACTION_STATUS, "The collection is already empty.");
    return;
  }
  const ok = confirm(
    `Delete ALL ${ids.length} cards from the collection?\n\n` +
    `This removes them from the database and cannot be undone. ` +
    `If you want a backup, cancel and use Export first.`
  );
  if (!ok) return;

  setStatus(ACTION_STATUS, `<span class="spinner"></span>Deleting…`);
  importing = true; // prevents partial snapshots from touching the collection
  try {
    if (window.Storage && window.Storage.commitMany) {
      await window.Storage.commitMany([], ids); // deletes in batches
    }
    collection = {};
    collectionView.setCode = null;
    renderCollection();
    setStatus(ACTION_STATUS, "Collection deleted.");
  } catch (err) {
    setStatus(ACTION_STATUS, `Failed to delete: ${esc(err.message)} — reload the page.`, true);
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
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid format");

    const merge = confirm(
      "Import collection:\n\n" +
      "OK = merge into the current collection\n" +
      "Cancel = replace the current collection"
    );

    // Affected ids (before + after) to write/delete in the database.
    const affected = new Set(Object.keys(collection));

    if (merge) {
      for (const [id, entry] of Object.entries(data)) {
        if (!collection[id]) collection[id] = entry;
      }
    } else {
      collection = data;
    }
    // Enforce the max-1-copy rule.
    for (const entry of Object.values(collection)) {
      if (entry && entry.qty > 1) entry.qty = 1;
    }
    Object.keys(collection).forEach((id) => affected.add(id));
    importing = true; // don't let partial snapshots touch the collection
    try {
      await persistMany([...affected]);
    } finally {
      importing = false;
    }
    renderCollection();
    setStatus(ACTION_STATUS, "Collection imported successfully.");
  } catch (err) {
    setStatus(ACTION_STATUS, `Failed to import: ${esc(err.message)}`, true);
  } finally {
    e.target.value = "";
  }
});

/* ---------- Import Moxfield CSV ---------- */
$("#import-csv-btn").addEventListener("click", () => $("#import-csv-file").click());

$("#import-csv-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    await importMoxfieldCSV(text);
  } catch (err) {
    setStatus(ACTION_STATUS, `Failed to import CSV: ${esc(err.message)}`, true);
  } finally {
    e.target.value = "";
  }
});

// Parses CSV respecting quotes and commas inside fields.
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

// Scryfall request with retry (backoff) on rate limit (429) or server error.
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
    if (!res.ok) throw new Error(`Error ${res.status} from Scryfall`);
    return res.json();
  }
  throw new Error("Scryfall is rate-limiting the requests");
}

async function importMoxfieldCSV(text) {
  const rows = parseCSV(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 2) throw new Error("Empty CSV or no cards.");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iEdition = col("edition");
  const iNumber = col("collector number");
  const iFoil = col("foil");
  const iProxy = col("proxy");
  if (iEdition === -1 || iNumber === -1) {
    throw new Error("This doesn't look like a Moxfield CSV (missing Edition / Collector Number columns).");
  }

  // Builds set+collector_number identifiers and remembers each one's foil.
  // Ignores cards marked as Proxy (playtest/proxies used for playing).
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
        ? `No valid cards — the ${skippedProxy} cards in the CSV are proxies (playtest).`
        : "No valid card found in the CSV."
    );
  }

  let imported = 0, notFound = 0, aborted = null;
  const buffer = []; // {id, entry} not yet written to the database

  // Writes the buffer in batches of 400 (only removes from the buffer after a successful write).
  async function flush(force) {
    while (buffer.length >= (force ? 1 : 400)) {
      const chunk = buffer.slice(0, 400);
      await window.Storage.commitMany(chunk, []);
      buffer.splice(0, 400);
    }
  }

  importing = true; // from here on, snapshots don't touch the collection
  try {
    for (let i = 0; i < items.length; i += 75) { // 75 = Scryfall limit per request
      const batch = items.slice(i, i + 75);
      setStatus(ACTION_STATUS,
        `<span class="spinner"></span>Importing from Moxfield… ${Math.min(i + 75, items.length)}/${items.length} (saved ${imported - buffer.length})`);
      let data;
      try {
        data = await scryfallCollection(batch);
      } catch (err) { aborted = err.message; break; }

      for (const card of (data.data || [])) {
        const foil = foilByKey[`${card.set}|${card.collector_number}`] || false;
        addToCollection(card, foil, true); // defer: we write in batches
        buffer.push({ id: card.id, entry: collection[card.id] });
        imported++;
      }
      notFound += (data.not_found || []).length;

      try { await flush(false); }
      catch (err) { aborted = "failed to save (" + err.message + ")"; break; }

      await sleep(90); // respects the pace requested by Scryfall
    }

    // Write whatever is left.
    if (!aborted) {
      try { await flush(true); }
      catch (err) { aborted = "failed to save (" + err.message + ")"; }
    }
  } finally {
    importing = false;
  }

  // Ensures the set symbols/percentages have loaded (avoids a re-render
  // that would clear the final message).
  await ensureSets().catch(() => {});
  renderCollection();
  if (editionsState.setsLoaded && !$("#edition-picker").hidden) renderEditionPicker();

  const saved = imported - buffer.length;
  setStatus(ACTION_STATUS,
    (aborted
      ? `Import interrupted: ${aborted}. Saved ${saved} card(s) — run the import again to continue.`
      : `Imported ${imported} card(s) from Moxfield.`) +
    (skippedProxy ? ` ${skippedProxy} proxy(ies) ignored.` : "") +
    (notFound ? ` ${notFound} not found on Scryfall.` : ""),
    !!aborted);
}

/* ============================================================
   PREVIEW
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

