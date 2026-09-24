(() => {
  "use strict";

  const CORE_URL = "./src/data/craft-db.json";
  const BASE_NAMES = ["Célébrités", "Objet", "Idée", "Internet"];
  const APP_SAVE_KEY = "deivyscraft-save-v3";
  const APP_SAVE_VERSION = 3;
  const FREE_KEY = "deivyscraft-free-v2";          // legacy v2
  const RECORDS_KEY = "deivyscraft-records-v1";    // legacy v1
  const MODE_KEY = "deivyscraft-mode-v1";          // legacy v1
  const LEGACY_KEYS = ["deivyscraft-foundations-200-v1", "deivyscraft-mobile-content-v2"];
  const RUN_ARCHIVE_LIMIT = 40;
  const RECORDS_LIMIT = 80;
  const RUN_HISTORY_LIMIT = 300;
  const CHALLENGE_EXCLUDED_CATEGORIES = new Set(["Fondamental", "Indice"]);
  const RUN_STATUS = Object.freeze({
    READY: "ready",
    PLAYING: "playing",
    WON: "won",
    LOST: "lost",
    ABANDONED: "abandoned"
  });
  const DIFFICULTY = Object.freeze({
    easy: { key: "easy", label: "Facile", min: 3, max: 5 },
    medium: { key: "medium", label: "Moyen", min: 6, max: 10 },
    hard: { key: "hard", label: "Difficile", min: 11, max: Infinity }
  });

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const norm = (s) => String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const state = {
    db: null,
    elements: [],
    byName: new Map(),
    byId: new Map(),
    recipes: new Map(),
    incoming: [],
    depth: [],
    bestParent: [],
    bases: [],
    mode: "free",
    selected: [],
    free: { discovered: {}, craftCount: 0 },
    sessionDiscovered: new Map(),
    sessionHistory: [],
    records: [],
    runArchive: [],
    settings: {
      mode: "free",
      difficulty: "__all__",
      category: "__all__",
      timerDuration: "180",
      customTimer: "120"
    },
    run: null,
    clockTimer: null,
    sequence: 0,
    runSequence: 0,
    targetRollToken: 0,
    targetRolling: false
  };

  function parsePacked(raw) {
    const cut = raw.indexOf("|");
    return {
      name: cut < 0 ? raw : raw.slice(0, cut),
      emoji: cut < 0 ? "✨" : (raw.slice(cut + 1) || "✨")
    };
  }

  function b36(s) {
    return parseInt(s, 36);
  }

  function pairKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  function runIs(...statuses) {
    return !!state.run && statuses.includes(state.run.status);
  }

  function transitionRun(nextStatus) {
    if (!state.run) return false;
    const allowed = {
      [RUN_STATUS.READY]: [RUN_STATUS.PLAYING],
      [RUN_STATUS.PLAYING]: [RUN_STATUS.WON, RUN_STATUS.LOST, RUN_STATUS.ABANDONED],
      [RUN_STATUS.WON]: [],
      [RUN_STATUS.LOST]: [],
      [RUN_STATUS.ABANDONED]: []
    };
    const current = state.run.status;
    if (current === nextStatus) return true;
    if (!(allowed[current] || []).includes(nextStatus)) {
      console.warn(`Transition de partie ignorée : ${current} → ${nextStatus}`);
      return false;
    }
    state.run.status = nextStatus;
    return true;
  }

  function difficultyInfo(index) {
    const depth = state.depth[index];
    if (!Number.isFinite(depth)) return null;
    if (depth <= DIFFICULTY.easy.max) return DIFFICULTY.easy;
    if (depth <= DIFFICULTY.medium.max) return DIFFICULTY.medium;
    return DIFFICULTY.hard;
  }

  function matchesDifficulty(index, filter) {
    if (!filter || filter === "__all__") return true;
    const info = difficultyInfo(index);
    return !!info && info.key === filter;
  }

  function decodeRecipes(db) {
    const map = new Map();
    const incoming = Array.from({ length: db.n }, () => []);
    const p = db.p || "";
    for (let o = 0; o < p.length; o += 9) {
      const a = b36(p.slice(o, o + 3));
      const b = b36(p.slice(o + 3, o + 6));
      const r = b36(p.slice(o + 6, o + 9));
      const rec = { a, b, r };
      map.set(pairKey(a, b), rec);
      incoming[r].push(rec);
    }
    state.recipes = map;
    state.incoming = incoming;
  }

  function buildElements(db) {
    state.elements = db.els.map((raw, index) => {
      const packed = parsePacked(raw);
      const id = db.ids?.[index] || `legacy.${index}`;
      return {
        index,
        id,
        name: packed.name,
        emoji: packed.emoji,
        meta: db.meta?.[id] || { category: "À classer", universe: "Général", tags: [] }
      };
    });
    state.byName = new Map();
    state.byId = new Map();
    state.elements.forEach((element) => {
      if (!state.byName.has(norm(element.name))) state.byName.set(norm(element.name), element.index);
      state.byId.set(element.id, element.index);
    });
    state.bases = BASE_NAMES.map((name) => state.byName.get(norm(name))).filter(Number.isInteger);
  }

  function computeDepths() {
    const n = state.elements.length;
    const depth = Array(n).fill(Infinity);
    const bestParent = Array(n).fill(null);
    state.bases.forEach((index) => { depth[index] = 0; });

    let changed = true;
    let guard = 0;
    const allRecipes = Array.from(state.recipes.values());
    while (changed && guard < n + 5) {
      changed = false;
      guard += 1;
      for (const rec of allRecipes) {
        if (!Number.isFinite(depth[rec.a]) || !Number.isFinite(depth[rec.b])) continue;
        const candidate = Math.max(depth[rec.a], depth[rec.b]) + 1;
        if (candidate < depth[rec.r]) {
          depth[rec.r] = candidate;
          bestParent[rec.r] = rec;
          changed = true;
        }
      }
    }
    state.depth = depth;
    state.bestParent = bestParent;
  }

  function nowStamp() {
    return Date.now();
  }

  function defaultSettings() {
    return {
      mode: "free",
      difficulty: "__all__",
      category: "__all__",
      timerDuration: "180",
      customTimer: "120"
    };
  }

  function normalizeSettings(raw) {
    const defaults = defaultSettings();
    const source = raw && typeof raw === "object" ? raw : {};
    const mode = ["free", "chrono", "timer"].includes(source.mode) ? source.mode : defaults.mode;
    const difficulty = ["__all__", "easy", "medium", "hard"].includes(source.difficulty)
      ? source.difficulty
      : defaults.difficulty;
    const timerDuration = ["60", "180", "300", "600", "custom"].includes(String(source.timerDuration))
      ? String(source.timerDuration)
      : defaults.timerDuration;
    const custom = Math.max(15, Math.min(3600, Number(source.customTimer) || Number(defaults.customTimer)));
    return {
      mode,
      difficulty,
      category: typeof source.category === "string" && source.category ? source.category : defaults.category,
      timerDuration,
      customTimer: String(custom)
    };
  }

  function ensureBaseDiscoveries() {
    let stamp = 1;
    const values = Object.values(state.free.discovered || {}).map(Number).filter(Number.isFinite);
    if (values.length) stamp = Math.max(...values) + 1;
    state.bases.forEach((index) => {
      const id = state.elements[index].id;
      if (!state.free.discovered[id]) state.free.discovered[id] = stamp++;
    });
  }

  function migrateLegacySave() {
    for (const key of LEGACY_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        let stamp = nowStamp() - parsed.length * 1000;
        for (const entry of parsed) {
          const name = typeof entry === "string" ? entry : entry?.nom || entry?.name;
          const index = state.byName.get(norm(name));
          if (Number.isInteger(index)) state.free.discovered[state.elements[index].id] = stamp += 1000;
        }
        return true;
      } catch (_) {}
    }
    return false;
  }

  function migratePreviousLocalStorage() {
    let imported = false;

    try {
      const parsed = JSON.parse(localStorage.getItem(FREE_KEY) || "null");
      if (parsed && parsed.v === 2 && parsed.discovered && typeof parsed.discovered === "object") {
        state.free = {
          discovered: { ...parsed.discovered },
          craftCount: Number(parsed.craftCount) || 0
        };
        imported = true;
      }
    } catch (_) {}

    if (!Object.keys(state.free.discovered).length) {
      imported = migrateLegacySave() || imported;
    }

    try {
      const parsed = JSON.parse(localStorage.getItem(RECORDS_KEY) || "[]");
      if (Array.isArray(parsed)) {
        state.records = parsed.slice(0, RECORDS_LIMIT);
        imported = imported || parsed.length > 0;
      }
    } catch (_) {}

    try {
      const legacyMode = localStorage.getItem(MODE_KEY);
      if (["free", "chrono", "timer"].includes(legacyMode)) {
        state.settings.mode = legacyMode;
        imported = true;
      }
    } catch (_) {}

    return imported;
  }

  function loadAppSave() {
    state.free = { discovered: {}, craftCount: 0 };
    state.records = [];
    state.runArchive = [];
    state.settings = defaultSettings();

    let loadedV3 = false;
    try {
      const parsed = JSON.parse(localStorage.getItem(APP_SAVE_KEY) || "null");
      if (parsed && parsed.version === APP_SAVE_VERSION) {
        const free = parsed.free && typeof parsed.free === "object" ? parsed.free : {};
        state.free = {
          discovered: free.discovered && typeof free.discovered === "object" ? { ...free.discovered } : {},
          craftCount: Number(free.craftCount) || 0
        };
        state.records = Array.isArray(parsed.records) ? parsed.records.slice(0, RECORDS_LIMIT) : [];
        state.runArchive = Array.isArray(parsed.runs) ? parsed.runs.slice(0, RUN_ARCHIVE_LIMIT) : [];
        state.settings = normalizeSettings(parsed.settings);
        loadedV3 = true;
      }
    } catch (_) {}

    if (!loadedV3) migratePreviousLocalStorage();
    ensureBaseDiscoveries();
    saveAppState();
  }

  function saveAppState() {
    try {
      const payload = {
        version: APP_SAVE_VERSION,
        updatedAt: Date.now(),
        free: {
          discovered: state.free.discovered,
          craftCount: Number(state.free.craftCount) || 0
        },
        records: state.records.slice(0, RECORDS_LIMIT),
        runs: state.runArchive.slice(0, RUN_ARCHIVE_LIMIT),
        settings: normalizeSettings(state.settings)
      };
      localStorage.setItem(APP_SAVE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function saveFree() {
    saveAppState();
  }

  function saveRecords() {
    saveAppState();
  }

  function persistSettingsFromUI() {
    state.settings = normalizeSettings({
      mode: state.mode,
      difficulty: $("#targetDifficulty")?.value || state.settings.difficulty,
      category: $("#targetCategory")?.value || state.settings.category,
      timerDuration: $("#timerDuration")?.value || state.settings.timerDuration,
      customTimer: $("#customTimer")?.value || state.settings.customTimer
    });
    saveAppState();
  }

  function restoreSavedControls() {
    const settings = normalizeSettings(state.settings);
    state.settings = settings;

    if ($("#targetDifficulty")) $("#targetDifficulty").value = settings.difficulty;
    if ($("#timerDuration")) $("#timerDuration").value = settings.timerDuration;
    if ($("#customTimer")) $("#customTimer").value = settings.customTimer;
    $("#customTimerWrap")?.classList.toggle("hidden", settings.timerDuration !== "custom");
  }

  function element(index) {
    return state.elements[index] || null;
  }

  function activeDiscoveryEntries() {
    if (state.mode === "free") {
      return Object.entries(state.free.discovered)
        .map(([id, timestamp]) => {
          const index = state.byId.get(id);
          return Number.isInteger(index) ? { index, timestamp: Number(timestamp) || 0 } : null;
        })
        .filter(Boolean);
    }
    return Array.from(state.sessionDiscovered.entries()).map(([index, timestamp]) => ({ index, timestamp }));
  }

  function activeDiscoverySet() {
    if (state.mode === "free") {
      return new Set(Object.keys(state.free.discovered).map((id) => state.byId.get(id)).filter(Number.isInteger));
    }
    return new Set(state.sessionDiscovered.keys());
  }

  function addDiscovery(index) {
    const item = element(index);
    if (!item) return false;
    if (state.mode === "free") {
      if (state.free.discovered[item.id]) return false;
      state.free.discovered[item.id] = nowStamp();
      saveFree();
      renderFreeProgress();
      renderPokedex();
      return true;
    }
    if (state.sessionDiscovered.has(index)) return false;
    state.sessionDiscovered.set(index, nowStamp());
    return true;
  }

  function resetSessionDiscoveries() {
    state.sessionDiscovered.clear();
    let stamp = 1;
    state.bases.forEach((index) => state.sessionDiscovered.set(index, stamp++));
    state.sessionHistory = [];
    state.sequence = 0;
    state.selected = [];
  }

  function explicitRecipe(a, b) {
    return state.recipes.get(pairKey(a, b)) || null;
  }

  function fallbackResult(a, b) {
    return Math.min(a, b);
  }

  function renderSlots() {
    for (let i = 0; i < 2; i += 1) {
      const slot = $(`#slot${i}`);
      const index = state.selected[i];
      const item = Number.isInteger(index) ? element(index) : null;
      slot.classList.toggle("empty", !item);
      slot.innerHTML = item
        ? `<span class="slotIndex">${i + 1}</span><b>${escapeHtml(item.emoji)}</b><strong>${escapeHtml(item.name)}</strong>`
        : `<span class="slotIndex">${i + 1}</span><b>＋</b><strong>Choisir</strong>`;
    }
    renderCollection();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setMessage(text, type = "muted", shake = false) {
    const box = $("#message");
    if (!box) return;
    box.textContent = text;
    box.className = `message ${type}`.trim();
    if (shake) {
      box.classList.remove("shake");
      void box.offsetWidth;
      box.classList.add("shake");
    }
  }

  function renderCollection() {
    const query = norm($("#search").value);
    const sort = $("#sortOrder").value;
    let entries = activeDiscoveryEntries().filter(({ index }) => {
      const item = element(index);
      return item && (!query || norm(item.name).includes(query));
    });

    if (sort === "alpha") {
      entries.sort((a, b) => element(a.index).name.localeCompare(element(b.index).name, "fr"));
    } else if (sort === "oldest") {
      entries.sort((a, b) => a.timestamp - b.timestamp || element(a.index).name.localeCompare(element(b.index).name, "fr"));
    } else {
      entries.sort((a, b) => b.timestamp - a.timestamp || element(a.index).name.localeCompare(element(b.index).name, "fr"));
    }

    const box = $("#collection");
    if (!entries.length) {
      box.innerHTML = `<span class="targetMeta">Aucun élément ne correspond à la recherche.</span>`;
      return;
    }

    box.innerHTML = entries.map(({ index }) => {
      const item = element(index);
      const first = state.selected[0] === index;
      const second = state.selected[1] === index;
      const classes = ["elementChip"];
      if (first || second) classes.push("selected");
      if (first) classes.push("selectionOne");
      if (second) classes.push("selectionTwo");
      return `<button type="button" class="${classes.join(" ")}" data-index="${index}" title="${escapeHtml(item.meta.category || "")}"><span class="emoji">${escapeHtml(item.emoji)}</span><span>${escapeHtml(item.name)}</span></button>`;
    }).join("");
  }

  function choose(index) {
    if (!Number.isInteger(index) || !activeDiscoverySet().has(index)) return;
    if (state.mode !== "free" && runIs(RUN_STATUS.READY)) startRun();
    if (state.mode !== "free" && runIs(RUN_STATUS.PLAYING)) {
      state.run.elementClicks += 1;
    }
    if (state.selected.length >= 2) state.selected = [];
    state.selected.push(index);
    renderSlots();
    if (state.selected.length === 2) setTimeout(fuse, 135);
  }

  function recordCraftAttempt() {
    if (state.mode === "free") {
      state.free.craftCount += 1;
      saveFree();
      renderFreeProgress();
    } else if (state.run) {
      state.run.crafts += 1;
      renderRunStats();
    }
  }

  function fuse() {
    if (state.selected.length !== 2) return;
    const [a, b] = state.selected;
    const rec = explicitRecipe(a, b);
    const resultIndex = rec ? rec.r : fallbackResult(a, b);
    const result = element(resultIndex);
    const aEl = element(a);
    const bEl = element(b);
    recordCraftAttempt();

    let newDiscovery = false;
    if (rec) {
      newDiscovery = addDiscovery(resultIndex);
      setMessage(
        `${aEl.name} + ${bEl.name} = ${result.name}`,
        newDiscovery ? "success" : "error",
        !newDiscovery
      );
    } else {
      setMessage(`Aucune recette définie : ${aEl.name} + ${bEl.name} → ${result.name} (repli fixe).`, "error", true);
    }

    if (state.mode !== "free" && state.run && runIs(RUN_STATUS.PLAYING)) {
      state.sessionHistory.push({
        seq: ++state.sequence,
        a,
        b,
        r: resultIndex,
        explicit: !!rec,
        newDiscovery,
        atMs: Math.round(currentRunElapsedMs()),
        wallAt: Date.now()
      });
    }

    $("#result").innerHTML = `<b>${escapeHtml(result.emoji)}</b><div><span class="eyebrow">RÉSULTAT</span><strong>${escapeHtml(result.name)}</strong></div>`;
    state.selected = [];
    renderSlots();
    renderRunStats();

    if (rec && state.mode !== "free" && runIs(RUN_STATUS.PLAYING) && resultIndex === state.run.targetIndex) {
      winRun();
    }
  }

  function categoryCounts() {
    const counts = new Map();
    state.elements.forEach((item) => counts.set(item.meta.category || "À classer", (counts.get(item.meta.category || "À classer") || 0) + 1));
    return counts;
  }

  function challengePool(category, difficulty = "__all__") {
    const baseAvailable = new Set(state.bases);
    return state.elements.filter((item) => {
      const cat = item.meta.category || "À classer";
      if (CHALLENGE_EXCLUDED_CATEGORIES.has(cat)) return false;
      if (category && category !== "__all__" && cat !== category) return false;
      if (!Number.isFinite(state.depth[item.index]) || state.depth[item.index] < 3) return false;
      if (!matchesDifficulty(item.index, difficulty)) return false;
      if (!(state.incoming[item.index]?.length > 0)) return false;
      return Number.isInteger(hintOneCandidateForTarget(item.index, baseAvailable));
    });
  }

  function currentDifficultyFilter() {
    return $("#targetDifficulty")?.value || "__all__";
  }

  function renderTargetCategories() {
    const select = $("#targetCategory");
    const previous = select.value || "__all__";
    const difficulty = currentDifficultyFilter();
    const categories = Array.from(new Set(state.elements.map((item) => item.meta.category || "À classer")))
      .filter((cat) => !CHALLENGE_EXCLUDED_CATEGORIES.has(cat))
      .map((cat) => ({ cat, count: challengePool(cat, difficulty).length }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => a.cat.localeCompare(b.cat, "fr"));

    select.innerHTML = `<option value="__all__">Toutes les catégories (${challengePool("__all__", difficulty).length})</option>` +
      categories.map(({ cat, count }) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)} (${count})</option>`).join("");

    const values = new Set(["__all__", ...categories.map((entry) => entry.cat)]);
    select.value = values.has(previous) ? previous : "__all__";
  }


  function optionLabel(option, fallback = "") {
    if (!option) return fallback;
    const value = option.value || fallback;
    if (value === "__all__") return fallback || "Tout";
    return String(option.textContent || value).replace(/\s*\([^)]*\)\s*$/g, "").trim();
  }

  function syncPillState(containerSelector, value) {
    const container = $(containerSelector);
    if (!container) return;
    $$(containerSelector + " .choicePill").forEach((button) => {
      button.classList.toggle("active", button.dataset.value === value);
    });
  }

  function renderCategoryPills() {
    const container = $("#categoryPills");
    const select = $("#targetCategory");
    if (!container || !select) return;
    const options = Array.from(select.options);
    container.innerHTML = options.map((option, index) => {
      const label = option.value === "__all__" ? "Tout" : optionLabel(option, "Tout");
      return `<button type="button" class="choicePill${index === 0 ? " active" : ""}" data-value="${escapeHtml(option.value)}">${escapeHtml(label)}</button>`;
    }).join("");
    syncPillState("#categoryPills", select.value || "__all__");
  }

  function renderDifficultyPills() {
    const container = $("#difficultyPills");
    const select = $("#targetDifficulty");
    if (!container || !select) return;
    const colorFor = (value) => value === "easy" ? " lime" : value === "medium" ? "" : value === "hard" ? " cyan" : "";
    container.innerHTML = Array.from(select.options)
      .filter((option) => option.value !== "__all__")
      .map((option) => `<button type="button" class="choicePill${colorFor(option.value)}" data-value="${escapeHtml(option.value)}">${escapeHtml(optionLabel(option, option.value))}</button>`)
      .join("");
    syncPillState("#difficultyPills", select.value || "__all__");
  }

  function renderTimerPills() {
    const container = $("#timerPills");
    const select = $("#timerDuration");
    if (!container || !select) return;
    container.innerHTML = Array.from(select.options).map((option) => {
      const label = option.value === "custom" ? "Perso" : String(option.textContent || option.value).replace(/\s+/g, "");
      return `<button type="button" class="choicePill cyan" data-value="${escapeHtml(option.value)}">${escapeHtml(label)}</button>`;
    }).join("");
    syncPillState("#timerPills", select.value || "180");
  }

  function renderVisualControls() {
    renderCategoryPills();
    renderDifficultyPills();
    renderTimerPills();
  }

  function pickFinalRecipe(targetIndex) {
    const preferred = state.bestParent[targetIndex];
    if (preferred) return preferred;
    const incoming = state.incoming[targetIndex] || [];
    return incoming.slice().sort((x, y) => {
      const xd = Math.max(state.depth[x.a] || 999, state.depth[x.b] || 999);
      const yd = Math.max(state.depth[y.a] || 999, state.depth[y.b] || 999);
      return xd - yd;
    })[0] || null;
  }

  function setTargetSetupDisabled(disabled) {
    $("#randomTarget").disabled = disabled;
    $("#targetCategory").disabled = disabled;
    $("#targetDifficulty").disabled = disabled;
    $("#timerDuration").disabled = disabled;
    $("#customTimer").disabled = disabled;
    ["#categoryPills .choicePill", "#difficultyPills .choicePill", "#timerPills .choicePill"].forEach((selector) => {
      $$(selector).forEach((button) => { button.disabled = !!disabled; });
    });
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function randomPoolItem(pool, avoid = null) {
    if (!pool.length) return null;
    if (pool.length === 1) return pool[0];
    let item = pool[Math.floor(Math.random() * pool.length)];
    let guard = 0;
    while (item.index === avoid && guard < 8) {
      item = pool[Math.floor(Math.random() * pool.length)];
      guard += 1;
    }
    return item;
  }

  async function animateTargetRoll(target, pool, token) {
    const card = $(".objectiveCard");
    const display = $("#targetDisplay");
    const meta = $("#targetMeta");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const frames = reducedMotion ? 7 : 21;
    const decoys = pool.length > 1 ? pool.filter((item) => item.index !== target.index) : pool;
    let lastIndex = null;

    card.classList.add("isRolling");
    display.classList.remove("settled");
    display.classList.add("rolling");
    meta.textContent = "Tirage de l'objectif…";

    for (let i = 0; i < frames; i += 1) {
      if (token !== state.targetRollToken) return false;
      const item = randomPoolItem(decoys.length ? decoys : pool, lastIndex);
      if (item) {
        lastIndex = item.index;
        display.innerHTML = `${escapeHtml(item.emoji)} ${escapeHtml(item.name)}`;
      }
      const progress = frames <= 1 ? 1 : i / (frames - 1);
      const delay = reducedMotion ? 28 : 38 + Math.round(275 * Math.pow(progress, 2.55));
      await wait(delay);
    }

    if (token !== state.targetRollToken) return false;
    display.innerHTML = `${escapeHtml(target.emoji)} ${escapeHtml(target.name)}`;
    display.classList.remove("rolling");
    display.classList.remove("settled");
    void display.offsetWidth;
    display.classList.add("settled");
    card.classList.remove("isRolling");
    return true;
  }

  async function chooseRandomTarget(forceNew = true) {
    if (state.mode === "free") return;
    const category = $("#targetCategory").value || "__all__";
    const difficulty = currentDifficultyFilter();
    const pool = challengePool(category, difficulty);
    const previousTarget = forceNew ? state.run?.targetIndex : null;

    const token = ++state.targetRollToken;
    state.targetRolling = true;
    stopClock();
    resetSessionDiscoveries();
    state.run = null;
    resetHintButtons();
    $("#hintText").textContent = "L'objectif est en cours de tirage…";
    resetClockDisplay();
    renderRunStats();
    renderCollection();
    renderSlots();
    $("#result").innerHTML = `<b>✨</b><div><span class="eyebrow">RÉSULTAT</span><strong>Fusionne deux éléments</strong></div>`;
    setMessage("", "muted");
    setTargetSetupDisabled(true);

    if (!pool.length) {
      if (token !== state.targetRollToken) return;
      state.targetRolling = false;
      $(".objectiveCard")?.classList.remove("isRolling");
      $("#targetDisplay")?.classList.remove("rolling", "settled");
      $("#targetDisplay").textContent = "Aucun objectif disponible";
      $("#targetMeta").textContent = "Aucun élément ne correspond à cette catégorie et cette difficulté.";
      setTargetSetupDisabled(false);
      return;
    }

    let candidates = pool;
    if (pool.length > 1 && Number.isInteger(previousTarget)) candidates = pool.filter((item) => item.index !== previousTarget);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const modeAtStart = state.mode;
    const completed = await animateTargetRoll(target, pool, token);
    if (!completed || token !== state.targetRollToken || modeAtStart !== state.mode) return;

    state.targetRolling = false;
    prepareRun(target.index, { resetDiscoveries: false });
  }

  function prepareRun(targetIndex, options = {}) {
    stopClock();
    if (options.resetDiscoveries !== false) resetSessionDiscoveries();
    const target = element(targetIndex);
    const difficulty = difficultyInfo(targetIndex);
    state.run = {
      sessionId: ++state.runSequence,
      mode: state.mode,
      status: RUN_STATUS.READY,
      targetId: target.id,
      targetIndex,
      targetCategory: target.meta.category || "À classer",
      difficulty: difficulty?.key || "unknown",
      difficultyLabel: difficulty?.label || "Non classée",
      minimumDepth: state.depth[targetIndex],
      finalRecipe: pickFinalRecipe(targetIndex),
      createdAt: Date.now(),
      startedAt: null,
      startedWallAt: null,
      endedAt: null,
      endedWallAt: null,
      elapsedMs: 0,
      durationMs: state.mode === "timer" ? readTimerDurationMs() : null,
      crafts: 0,
      elementClicks: 0,
      hintsUsed: 0,
      hintMessages: [],
      hintEvents: [],
      finalized: false,
      summary: null
    };

    $("#targetDisplay").innerHTML = `${escapeHtml(target.emoji)} ${escapeHtml(target.name)}`;
    $("#targetMeta").textContent = `${target.meta.category || "À classer"} · ${difficulty?.label || "Difficulté inconnue"} · profondeur minimale ${state.depth[targetIndex]}`;
    setTargetSetupDisabled(false);
    $("#hintText").textContent = "Les indices s'activent quand la partie commence.";
    resetHintButtons();
    resetClockDisplay();
    renderRunStats();
    renderCollection();
    renderSlots();
    $("#result").innerHTML = `<b>✨</b><div><span class="eyebrow">RÉSULTAT</span><strong>Fusionne deux éléments</strong></div>`;
    setMessage("", "muted");
  }

  function resetHintButtons() {
    $("#hint1").disabled = true;
    $("#hint2").disabled = true;
    $("#hint3").disabled = true;
    $("#hint1").textContent = "Indice 1";
    $("#hint2").textContent = "Indice 2 🔒";
    $("#hint3").textContent = "Indice 3 🔒";
  }

  function startRun() {
    if (!runIs(RUN_STATUS.READY)) return;
    if (!transitionRun(RUN_STATUS.PLAYING)) return;
    state.run.startedAt = performance.now();
    state.run.startedWallAt = Date.now();
    if (state.run.mode === "timer") state.run.durationMs = readTimerDurationMs();
    setTargetSetupDisabled(true);
    $("#hint1").disabled = false;
    $("#clockMessage").textContent = state.mode === "timer" ? "Le compte à rebours est lancé." : "Le chrono est lancé.";
    startClock();
  }

  function readTimerDurationMs() {
    const value = $("#timerDuration").value;
    if (value === "custom") {
      const seconds = Math.max(15, Math.min(3600, Number($("#customTimer").value) || 120));
      return seconds * 1000;
    }
    return Number(value || 180) * 1000;
  }

  function formatTime(ms, includeHours = false) {
    ms = Math.max(0, Math.floor(ms));
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    const base = `${String(minutes + (includeHours ? 0 : hours * 60)).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
    return includeHours && hours ? `${String(hours).padStart(2, "0")}:${base}` : base;
  }

  function startClock() {
    stopClock();
    state.clockTimer = window.setInterval(updateClock, 31);
    updateClock();
  }

  function stopClock() {
    if (state.clockTimer) window.clearInterval(state.clockTimer);
    state.clockTimer = null;
  }

  function currentRunElapsedMs() {
    if (!state.run?.startedAt) return 0;
    if (state.run.endedAt != null) return Math.max(0, state.run.elapsedMs || 0);
    return Math.max(0, performance.now() - state.run.startedAt);
  }

  function updateClock() {
    if (!state.run) return;
    if (runIs(RUN_STATUS.READY)) {
      resetClockDisplay();
      return;
    }
    const elapsed = performance.now() - state.run.startedAt;
    state.run.elapsedMs = elapsed;
    if (state.run.mode === "chrono") {
      $("#clockDisplay").textContent = formatTime(elapsed);
      return;
    }
    const remaining = state.run.durationMs - elapsed;
    $("#clockDisplay").textContent = formatTime(remaining);
    if (remaining <= 0 && runIs(RUN_STATUS.PLAYING)) loseRun();
  }

  function resetClockDisplay() {
    if (state.mode === "timer") {
      $("#clockDisplay").textContent = formatTime(state.run?.durationMs || readTimerDurationMs());
      $("#clockLabel").textContent = "TIMER";
    } else {
      $("#clockDisplay").textContent = "00:00.000";
      $("#clockLabel").textContent = "CHRONO";
    }
    $("#clockMessage").textContent = "Le temps démarre au premier clic.";
  }

  function collectAncestorCandidates(index, branchRoot, out, visited) {
    if (visited.has(index)) return;
    visited.add(index);
    const rec = state.bestParent[index];
    if (!rec) return;
    for (const parent of [rec.a, rec.b]) {
      if (!state.bases.includes(parent)) {
        out.push({ index: parent, branchRoot });
      }
      collectAncestorCandidates(parent, branchRoot, out, visited);
    }
  }

  function remainingDepthFromAvailable(index, available, memo = new Map(), visiting = new Set()) {
    if (available.has(index) || state.bases.includes(index)) return 0;
    if (memo.has(index)) return memo.get(index);
    if (visiting.has(index)) return Infinity;
    visiting.add(index);
    const rec = state.bestParent[index];
    if (!rec) {
      visiting.delete(index);
      memo.set(index, Infinity);
      return Infinity;
    }
    const a = remainingDepthFromAvailable(rec.a, available, memo, visiting);
    const b = remainingDepthFromAvailable(rec.b, available, memo, visiting);
    visiting.delete(index);
    const value = Number.isFinite(a) && Number.isFinite(b) ? Math.max(a, b) + 1 : Infinity;
    memo.set(index, value);
    return value;
  }

  function hintOneCandidateForTarget(targetIndex, available = new Set(state.bases)) {
    const final = pickFinalRecipe(targetIndex);
    if (!final) return null;

    const candidates = [];
    collectAncestorCandidates(final.a, final.a, candidates, new Set());
    collectAncestorCandidates(final.b, final.b, candidates, new Set());

    const unique = new Map();
    for (const candidate of candidates) {
      if (candidate.index === targetIndex || candidate.index === final.a || candidate.index === final.b) continue;
      if (state.bases.includes(candidate.index)) continue;
      if (!unique.has(candidate.index)) unique.set(candidate.index, candidate);
    }
    if (!unique.size) return null;

    const targetDepth = state.depth[targetIndex] || 3;
    const targetRemaining = remainingDepthFromAvailable(targetIndex, available);
    const idealAbsoluteDepth = Math.max(2, Math.round(targetDepth * 0.55));
    const idealRemaining = Number.isFinite(targetRemaining) ? Math.max(1, Math.round(targetRemaining * 0.5)) : idealAbsoluteDepth;

    return Array.from(unique.values())
      .map((candidate) => {
        const remaining = remainingDepthFromAvailable(candidate.index, available);
        const absoluteDepth = state.depth[candidate.index] || 0;
        const alreadyKnownPenalty = available.has(candidate.index) ? 100 : 0;
        const unreachablePenalty = Number.isFinite(remaining) ? 0 : 1000;
        const remainingScore = Number.isFinite(remaining) ? Math.abs(remaining - idealRemaining) * 5 : 100;
        const depthScore = Math.abs(absoluteDepth - idealAbsoluteDepth);
        const shallowPenalty = absoluteDepth <= 1 ? 8 : 0;
        return {
          ...candidate,
          score: alreadyKnownPenalty + unreachablePenalty + remainingScore + depthScore + shallowPenalty
        };
      })
      .sort((a, b) => a.score - b.score || (state.depth[b.index] || 0) - (state.depth[a.index] || 0))[0]?.index ?? null;
  }

  function hintOneWord() {
    if (!state.run) return null;
    return hintOneCandidateForTarget(state.run.targetIndex, activeDiscoverySet());
  }

  function useHint(level) {
    if (!runIs(RUN_STATUS.PLAYING)) return;
    const final = state.run.finalRecipe;
    if (!final) return;

    if (level === 1 && state.run.hintsUsed === 0) {
      const available = activeDiscoverySet();
      const index = hintOneWord();
      const item = Number.isInteger(index) ? element(index) : null;
      if (!item) return;
      const msg = available.has(index)
        ? `💡 Tu as déjà ${item.emoji} ${item.name}. Garde cet élément en tête : il peut mener à l'un des ingrédients finaux.`
        : `💡 ${item.emoji} ${item.name} peut t'aider à construire l'un des deux ingrédients de la combinaison finale.`;
      state.run.hintsUsed = 1;
      state.run.hintMessages.push(msg);
      state.run.hintEvents.push({ level: 1, message: msg, atMs: Math.round(currentRunElapsedMs()) });
      $("#hint1").disabled = true;
      $("#hint1").textContent = "Indice 1 ✓";
      $("#hint2").disabled = false;
      $("#hint2").textContent = "Indice 2";
      $("#hintText").textContent = msg;
    } else if (level === 2 && state.run.hintsUsed === 1) {
      const available = activeDiscoverySet();
      const possible = [final.a, final.b];
      const undiscovered = possible.filter((index) => !available.has(index));
      const source = undiscovered.length ? undiscovered : possible;
      const reveal = source.slice().sort((a, b) => (state.depth[b] || 0) - (state.depth[a] || 0))[0];
      const item = element(reveal);
      const msg = `💡 Un des deux ingrédients de la combinaison finale est : ${item.emoji} ${item.name}.`;
      state.run.hintsUsed = 2;
      state.run.hintMessages.push(msg);
      state.run.hintEvents.push({ level: 2, message: msg, atMs: Math.round(currentRunElapsedMs()) });
      $("#hint2").disabled = true;
      $("#hint2").textContent = "Indice 2 ✓";
      $("#hint3").disabled = false;
      $("#hint3").textContent = "Indice 3";
      $("#hintText").textContent = msg;
    } else if (level === 3 && state.run.hintsUsed === 2) {
      const a = element(final.a);
      const b = element(final.b);
      const target = element(state.run.targetIndex);
      const msg = `💡 ${a.emoji} ${a.name} + ${b.emoji} ${b.name} → ${target.emoji} ${target.name}`;
      state.run.hintsUsed = 3;
      state.run.hintMessages.push(msg);
      state.run.hintEvents.push({ level: 3, message: msg, atMs: Math.round(currentRunElapsedMs()) });
      $("#hint3").disabled = true;
      $("#hint3").textContent = "Indice 3 ✓";
      $("#hintText").textContent = msg;
    }
    renderRunStats();
  }

  function serializeCraftEvent(evt) {
    const a = element(evt.a);
    const b = element(evt.b);
    const r = element(evt.r);
    return {
      seq: evt.seq,
      aId: a?.id || null,
      bId: b?.id || null,
      resultId: r?.id || null,
      explicit: !!evt.explicit,
      newDiscovery: !!evt.newDiscovery,
      atMs: Number(evt.atMs) || 0
    };
  }

  function reconstructWinningPath() {
    if (!state.run) return [];
    const history = state.sessionHistory;
    const target = state.run.targetIndex;

    let finalEvent = null;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const evt = history[i];
      if (evt.explicit && evt.r === target) {
        finalEvent = evt;
        break;
      }
    }
    if (!finalEvent) return [];

    const usedEvents = new Set();
    const collected = [];

    function findDiscoveryProducer(resultIndex, beforeSeq) {
      let fallbackProducer = null;
      for (const evt of history) {
        if (evt.seq >= beforeSeq) break;
        if (!evt.explicit || evt.r !== resultIndex) continue;
        if (!fallbackProducer) fallbackProducer = evt;
        if (evt.newDiscovery) return evt;
      }
      return fallbackProducer;
    }

    function walk(evt) {
      if (!evt || usedEvents.has(evt.seq)) return;
      for (const ingredient of [evt.a, evt.b]) {
        if (state.bases.includes(ingredient)) continue;
        const producer = findDiscoveryProducer(ingredient, evt.seq);
        if (producer) walk(producer);
      }
      usedEvents.add(evt.seq);
      collected.push(evt);
    }

    walk(finalEvent);
    return collected.sort((a, b) => a.seq - b.seq);
  }

  function buildRunSnapshot(outcome) {
    if (!state.run) return null;
    const target = element(state.run.targetIndex);
    const path = outcome === RUN_STATUS.WON ? reconstructWinningPath() : [];
    const history = state.sessionHistory.slice();
    const explicitCrafts = history.filter((evt) => evt.explicit).length;
    const fallbackCrafts = history.length - explicitCrafts;
    const usefulCrafts = path.length;
    const detours = Math.max(0, state.run.crafts - usefulCrafts);
    const remainingMs = state.run.durationMs
      ? Math.max(0, Math.round(state.run.durationMs - state.run.elapsedMs))
      : null;

    return {
      v: 2,
      runId: `${state.run.mode}-${state.run.createdAt}-${state.run.sessionId}`,
      outcome,
      mode: state.run.mode,
      targetId: target?.id || state.run.targetId,
      targetName: target?.name || "",
      targetEmoji: target?.emoji || "✨",
      category: state.run.targetCategory,
      difficulty: state.run.difficulty,
      difficultyLabel: state.run.difficultyLabel,
      minimumDepth: state.run.minimumDepth,
      createdAt: state.run.createdAt,
      startedAt: state.run.startedWallAt,
      endedAt: state.run.endedWallAt,
      elapsedMs: Math.round(state.run.elapsedMs),
      durationMs: state.run.durationMs ? Math.round(state.run.durationMs) : null,
      remainingMs,
      crafts: state.run.crafts,
      usefulCrafts,
      detours,
      explicitCrafts,
      fallbackCrafts,
      elementClicks: state.run.elementClicks,
      discoveries: Math.max(0, state.sessionDiscovered.size - state.bases.length),
      hints: state.run.hintsUsed,
      hintEvents: state.run.hintEvents.map((entry) => ({ ...entry })),
      path: path.map(serializeCraftEvent),
      history: history.slice(-RUN_HISTORY_LIMIT).map(serializeCraftEvent),
      historyTruncated: history.length > RUN_HISTORY_LIMIT
    };
  }

  function recordFromSnapshot(snapshot) {
    if (!snapshot) return null;
    return {
      v: snapshot.v,
      runId: snapshot.runId,
      mode: snapshot.mode,
      targetId: snapshot.targetId,
      targetName: snapshot.targetName,
      targetEmoji: snapshot.targetEmoji,
      category: snapshot.category,
      difficulty: snapshot.difficulty,
      difficultyLabel: snapshot.difficultyLabel,
      minimumDepth: snapshot.minimumDepth,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      elapsedMs: snapshot.elapsedMs,
      durationMs: snapshot.durationMs,
      remainingMs: snapshot.remainingMs,
      crafts: snapshot.crafts,
      usefulCrafts: snapshot.usefulCrafts,
      detours: snapshot.detours,
      elementClicks: snapshot.elementClicks,
      discoveries: snapshot.discoveries,
      hints: snapshot.hints
    };
  }

  function finalizeRun(outcome) {
    if (!state.run || state.run.finalized || !runIs(RUN_STATUS.PLAYING)) return state.run?.summary || null;
    if (!transitionRun(outcome)) return null;

    state.run.endedAt = performance.now();
    state.run.endedWallAt = Date.now();
    state.run.elapsedMs = Math.max(0, state.run.endedAt - state.run.startedAt);
    state.run.finalized = true;
    stopClock();

    const snapshot = buildRunSnapshot(outcome);
    state.run.summary = snapshot;

    if (snapshot) {
      state.runArchive.unshift(snapshot);
      state.runArchive = state.runArchive.slice(0, RUN_ARCHIVE_LIMIT);
      if (outcome === RUN_STATUS.WON) {
        const record = recordFromSnapshot(snapshot);
        if (record) state.records.unshift(record);
        state.records = state.records.slice(0, RECORDS_LIMIT);
      }
      saveAppState();
    }
    return snapshot;
  }

  function winRun() {
    if (!runIs(RUN_STATUS.PLAYING)) return;
    const snapshot = finalizeRun(RUN_STATUS.WON);
    if (!snapshot) return;

    const target = element(state.run.targetIndex);
    $("#victoryTitle").textContent = `${target.emoji} ${target.name}`;
    $("#victoryStats").innerHTML = [
      [formatTime(state.run.elapsedMs), "temps"],
      [String(state.run.crafts), "crafts"],
      [String(snapshot.usefulCrafts), "utiles"],
      [`${state.run.hintsUsed}/3`, "indices"]
    ].map(([value, label]) => `<div><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join("");
    $("#victoryModal").classList.remove("hidden");
    renderRecords();
  }

  function loseRun() {
    if (!runIs(RUN_STATUS.PLAYING)) return;
    const snapshot = finalizeRun(RUN_STATUS.LOST);
    if (!snapshot) return;

    const target = element(state.run.targetIndex);
    $("#defeatTitle").textContent = `Temps écoulé · ${target.emoji} ${target.name}`;
    $("#defeatText").textContent = `Tu as effectué ${snapshot.crafts} crafts, découvert ${snapshot.discoveries} élément(s) et utilisé ${snapshot.hints} indice(s).`;
    $("#defeatModal").classList.remove("hidden");
  }

  function showRecap() {
    $("#victoryModal").classList.add("hidden");
    if (!state.run) return;
    const target = element(state.run.targetIndex);
    const path = reconstructWinningPath();
    const summary = state.run.summary || buildRunSnapshot(RUN_STATUS.WON);
    $("#recapTitle").textContent = `${target.emoji} ${target.name}`;
    $("#recapMeta").innerHTML = [
      [formatTime(state.run.elapsedMs), "Temps", "accentOrange"],
      [String(state.run.crafts), "Crafts", "accentCyan"],
      [String(summary?.usefulCrafts ?? path.length), "Utiles", "accentPink"],
      [String(state.run.hintsUsed), "Indices", "accentLime"]
    ].map(([value, label, cls]) => `<div class="recapStat ${cls}"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join("");
    $("#recapPath").innerHTML = path.length
      ? path.map((evt, i) => {
          const a = element(evt.a), b = element(evt.b), r = element(evt.r);
          return `
            <div class="pathStep">
              <div class="stepDot">${i + 1}</div>
              <div class="stepBody">
                <div class="stepRecipe">
                  <span class="ingredient">${escapeHtml(a.emoji)} ${escapeHtml(a.name)}</span>
                  <span class="plusSign">+</span>
                  <span class="ingredient">${escapeHtml(b.emoji)} ${escapeHtml(b.name)}</span>
                </div>
                <div class="resultRow">
                  <span class="arrow">→</span>
                  <span class="resultName">${escapeHtml(r.emoji)} ${escapeHtml(r.name)}</span>
                </div>
              </div>
            </div>`;
        }).join("")
      : `<div class="targetMeta">Le chemin n'a pas pu être reconstruit pour cette partie.</div>`;
    $("#recapModal").classList.remove("hidden");
  }

  function resetAfterRecap() {
    $("#recapModal").classList.add("hidden");
    chooseRandomTarget(true);
  }

  function retrySameTarget() {
    $("#defeatModal").classList.add("hidden");
    if (!state.run) return;
    prepareRun(state.run.targetIndex);
  }

  function newTargetAfterDefeat() {
    $("#defeatModal").classList.add("hidden");
    chooseRandomTarget(true);
  }

  function allRecipeRows() {
    return Array.from(state.recipes.values())
      .map((rec) => ({
        a: element(rec.a),
        b: element(rec.b),
        r: element(rec.r)
      }))
      .filter((row) => row.a && row.b && row.r)
      .sort((x, y) =>
        x.r.name.localeCompare(y.r.name, "fr", { sensitivity: "base" }) ||
        x.a.name.localeCompare(y.a.name, "fr", { sensitivity: "base" }) ||
        x.b.name.localeCompare(y.b.name, "fr", { sensitivity: "base" })
      );
  }

  function renderRecipesDirectory() {
    const list = $("#recipesList");
    const count = $("#recipesCount");
    if (!list || !count) return;

    const query = norm($("#recipesSearch")?.value || "");
    const rows = allRecipeRows().filter(({ a, b, r }) => {
      if (!query) return true;
      return norm(a.name).includes(query) ||
        norm(b.name).includes(query) ||
        norm(r.name).includes(query) ||
        norm(`${a.name} ${b.name} ${r.name}`).includes(query);
    });

    count.textContent = `${rows.length} recette${rows.length > 1 ? "s" : ""}`;
    list.innerHTML = rows.length
      ? rows.map(({ a, b, r }) => `
          <div class="recipeRow" role="listitem" title="${escapeHtml(a.name)} + ${escapeHtml(b.name)} = ${escapeHtml(r.name)}">
            <span class="recipePart">${escapeHtml(a.emoji)} ${escapeHtml(a.name)}</span>
            <span class="recipeOperator">+</span>
            <span class="recipePart">${escapeHtml(b.emoji)} ${escapeHtml(b.name)}</span>
            <span class="recipeOperator recipeArrow">→</span>
            <span class="recipeResult">${escapeHtml(r.emoji)} ${escapeHtml(r.name)}</span>
          </div>`).join("")
      : `<div class="recipesEmpty">Aucune recette ne correspond à cette recherche.</div>`;
  }

  function openRecipesModal() {
    const modal = $("#recipesModal");
    if (!modal) return;
    $("#recipesSearch").value = "";
    renderRecipesDirectory();
    modal.classList.remove("hidden");
    document.body.classList.add("modalOpen");
    window.setTimeout(() => $("#recipesSearch")?.focus(), 60);
  }

  function closeRecipesModal() {
    $("#recipesModal")?.classList.add("hidden");
    document.body.classList.remove("modalOpen");
  }

  function renderRunStats() {
    const run = state.run;
    $("#runCrafts").textContent = run?.crafts ?? 0;
    $("#runDiscovered").textContent = state.mode === "free" ? Object.keys(state.free.discovered).length : state.sessionDiscovered.size;
    $("#runHints").textContent = `${run?.hintsUsed ?? 0}/3`;
  }

  function renderRecords() {
    const box = $("#recordsList");
    if (state.mode === "free") {
      box.innerHTML = "";
      return;
    }
    const records = state.records
      .filter((record) => record.mode === state.mode)
      .slice()
      .sort((a, b) => a.elapsedMs - b.elapsedMs)
      .slice(0, 5);
    box.innerHTML = records.length ? records.map((record, index) => {
      const timerExtra = record.mode === "timer" && Number.isFinite(record.remainingMs)
        ? ` · ${formatTime(record.remainingMs)} restantes`
        : "";
      const difficultyExtra = record.difficultyLabel ? ` · ${escapeHtml(record.difficultyLabel)}` : "";
      const usefulExtra = Number.isFinite(record.usefulCrafts) ? ` · ${record.usefulCrafts} utiles` : "";
      const hints = Number.isFinite(record.hints) ? record.hints : (record.hintsUsed || 0);
      return `<div class="recordItem"><b>#${index + 1} ${escapeHtml(record.targetEmoji || "✨")} ${escapeHtml(record.targetName)}</b><span>${formatTime(record.elapsedMs)} · ${record.crafts} crafts${usefulExtra} · ${hints} indice(s)${difficultyExtra}${timerExtra}</span></div>`;
    }).join("") : `<div class="targetMeta">Aucun record pour ce mode.</div>`;
  }

  function renderFreeProgress() {
    const found = Object.keys(state.free.discovered).filter((id) => state.byId.has(id)).length;
    const total = state.elements.length;
    const percent = total ? found / total * 100 : 0;
    $("#globalDiscovered").textContent = `${found} / ${total}`;
    $("#freeProgressCount").textContent = `${found} / ${total}`;
    $("#freePercent").textContent = `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
    $("#freeCrafts").textContent = state.free.craftCount;
    $("#freeProgressBar").style.width = `${Math.min(100, percent)}%`;
  }

  function renderPokedexCategories() {
    const counts = categoryCounts();
    const select = $("#pokedexCategory");
    const categories = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, "fr"));
    select.innerHTML = `<option value="__all__">Toutes les catégories (${state.elements.length})</option>` +
      categories.map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)} (${counts.get(cat)})</option>`).join("");
  }

  function renderPokedex() {
    if (state.mode !== "free") return;
    const category = $("#pokedexCategory").value || "__all__";
    const discoveredIds = new Set(Object.keys(state.free.discovered));
    const items = state.elements.filter((item) => category === "__all__" || item.meta.category === category);
    const foundCount = items.filter((item) => discoveredIds.has(item.id)).length;
    $("#pokedexCount").textContent = `${foundCount} / ${items.length} découverts${category !== "__all__" ? ` · ${category}` : ""}`;
    $("#pokedexList").innerHTML = items.map((item) => {
      const found = discoveredIds.has(item.id);
      return `<div class="dexItem ${found ? "found" : "locked"}" ${found ? `data-index="${item.index}" title="Cliquer pour sélectionner"` : ""}>${found ? `${escapeHtml(item.emoji)} ${escapeHtml(item.name)}` : "🔒 ???"}</div>`;
    }).join("");
  }

  function setMode(mode) {
    if (!state.db || !["free", "chrono", "timer"].includes(mode)) return;
    if (state.mode !== mode && runIs(RUN_STATUS.PLAYING)) finalizeRun(RUN_STATUS.ABANDONED);
    stopClock();
    state.targetRollToken += 1;
    state.targetRolling = false;
    $(".objectiveCard")?.classList.remove("isRolling");
    $("#targetDisplay")?.classList.remove("rolling", "settled");
    state.mode = mode;
    state.selected = [];
    state.settings.mode = mode;
    saveAppState();

    $$(".modeTab").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    const free = mode === "free";
    $("#challengeBar").classList.toggle("hidden", free);
    $("#hintStrip").classList.toggle("hidden", free);
    $("#freeProgressPanel").classList.toggle("hidden", !free);
    $("#pokedexPanel").classList.toggle("hidden", !free);
    $("#runPanel").classList.toggle("hidden", free);
    $("#recordsPanel").classList.toggle("hidden", free);
    $("#timerSetup").classList.toggle("hidden", mode !== "timer");

    if (free) {
      state.run = null;
      state.targetRolling = false;
      $(".objectiveCard")?.classList.remove("isRolling");
      $("#targetDisplay")?.classList.remove("rolling", "settled");
      setMessage("", "muted");
      $("#result").innerHTML = `<b>✨</b><div><span class="eyebrow">RÉSULTAT</span><strong>Fusionne deux éléments</strong></div>`;
      renderFreeProgress();
      renderPokedex();
      renderCollection();
      renderSlots();
    } else {
      chooseRandomTarget(true);
      renderRecords();
    }
  }

  function updateTimerSetup() {
    const custom = $("#timerDuration").value === "custom";
    $("#customTimerWrap").classList.toggle("hidden", !custom);
    syncPillState("#timerPills", $("#timerDuration").value || "180");
    persistSettingsFromUI();
    if (state.mode === "timer" && runIs(RUN_STATUS.READY)) {
      state.run.durationMs = readTimerDurationMs();
      resetClockDisplay();
    }
  }

  function abandonRun() {
    if (state.mode === "free") return;
    if (runIs(RUN_STATUS.PLAYING) && !window.confirm("Abandonner cette partie et repartir sur un nouvel objectif ?")) return;
    if (runIs(RUN_STATUS.PLAYING)) finalizeRun(RUN_STATUS.ABANDONED);
    chooseRandomTarget(true);
  }

  function resetFreeProgress() {
    if (!window.confirm("Réinitialiser toutes les découvertes du mode Libre ? Cette action efface la progression locale.")) return;
    state.free = { discovered: {}, craftCount: 0 };
    let stamp = 1;
    state.bases.forEach((index) => { state.free.discovered[element(index).id] = stamp++; });
    saveFree();
    state.selected = [];
    renderFreeProgress();
    renderPokedex();
    renderSlots();
  }

  function bindEvents() {
    $$(".modeTab").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
    $("#categoryPills")?.addEventListener("click", (event) => {
      const button = event.target.closest(".choicePill");
      if (!button || button.disabled) return;
      $("#targetCategory").value = button.dataset.value;
      syncPillState("#categoryPills", button.dataset.value);
      $("#targetCategory").dispatchEvent(new Event("change", { bubbles: true }));
    });
    $("#difficultyPills")?.addEventListener("click", (event) => {
      const button = event.target.closest(".choicePill");
      if (!button || button.disabled) return;
      $("#targetDifficulty").value = button.dataset.value;
      syncPillState("#difficultyPills", button.dataset.value);
      $("#targetDifficulty").dispatchEvent(new Event("change", { bubbles: true }));
    });
    $("#timerPills")?.addEventListener("click", (event) => {
      const button = event.target.closest(".choicePill");
      if (!button || button.disabled) return;
      $("#timerDuration").value = button.dataset.value;
      updateTimerSetup();
      $("#timerDuration").dispatchEvent(new Event("change", { bubbles: true }));
    });
    $("#collection").addEventListener("click", (event) => {
      const button = event.target.closest(".elementChip");
      if (button) choose(Number(button.dataset.index));
    });
    $("#pokedexList").addEventListener("click", (event) => {
      const item = event.target.closest(".dexItem.found");
      if (item) choose(Number(item.dataset.index));
    });
    $("#search").addEventListener("input", renderCollection);
    $("#sortOrder").addEventListener("change", () => {
      $$(".sortIconButton").forEach((button) => button.classList.toggle("active", button.dataset.sort === $("#sortOrder").value));
      renderCollection();
    });
    $$(".sortIconButton").forEach((button) => button.addEventListener("click", () => {
      $("#sortOrder").value = button.dataset.sort;
      $$(".sortIconButton").forEach((item) => item.classList.toggle("active", item === button));
      renderCollection();
    }));
    $("#clearSelection").addEventListener("click", () => { state.selected = []; renderSlots(); });
    $("#allRecipesButton")?.addEventListener("click", openRecipesModal);
    $("#recipesClose")?.addEventListener("click", closeRecipesModal);
    $("#recipesSearch")?.addEventListener("input", renderRecipesDirectory);
    $("#recipesModal")?.addEventListener("click", (event) => {
      if (event.target === $("#recipesModal")) closeRecipesModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("#recipesModal")?.classList.contains("hidden")) closeRecipesModal();
    });
    $("#randomTarget").addEventListener("click", () => chooseRandomTarget(true));
    $("#targetCategory").addEventListener("change", () => {
      syncPillState("#categoryPills", $("#targetCategory").value || "__all__");
      persistSettingsFromUI();
      if (!state.run || runIs(RUN_STATUS.READY)) chooseRandomTarget(true);
    });
    $("#targetDifficulty").addEventListener("change", () => {
      syncPillState("#difficultyPills", $("#targetDifficulty").value || "__all__");
      persistSettingsFromUI();
      if (!state.run || runIs(RUN_STATUS.READY)) {
        renderTargetCategories();
        renderCategoryPills();
        state.settings.category = $("#targetCategory").value || "__all__";
        saveAppState();
        chooseRandomTarget(true);
      }
    });
    $("#timerDuration").addEventListener("change", updateTimerSetup);
    $("#customTimer").addEventListener("input", updateTimerSetup);
    $("#hint1").addEventListener("click", () => useHint(1));
    $("#hint2").addEventListener("click", () => useHint(2));
    $("#hint3").addEventListener("click", () => useHint(3));
    $("#victoryContinue").addEventListener("click", showRecap);
    $("#recapClose").addEventListener("click", resetAfterRecap);
    $("#retryRun").addEventListener("click", retrySameTarget);
    $("#newTargetAfterDefeat").addEventListener("click", newTargetAfterDefeat);
    $("#abandonRun").addEventListener("click", abandonRun);
    $("#resetFree").addEventListener("click", resetFreeProgress);
    $("#pokedexCategory").addEventListener("change", renderPokedex);
  }

  async function init() {
    $("#dbStatus").textContent = "Chargement de la base…";
    const response = await fetch(CORE_URL);
    if (!response.ok) throw new Error(`craft-db.json HTTP ${response.status}`);
    const db = await response.json();
    state.db = db;
    buildElements(db);
    decodeRecipes(db);
    computeDepths();
    loadAppSave();
    restoreSavedControls();
    renderTargetCategories();
    renderVisualControls();

    const savedCategory = state.settings.category;
    if (Array.from($("#targetCategory").options).some((option) => option.value === savedCategory)) {
      $("#targetCategory").value = savedCategory;
    } else {
      state.settings.category = "__all__";
    }

    renderVisualControls();
    renderPokedexCategories();
    renderFreeProgress();
    bindEvents();

    $("#dbStatus").textContent = `${db.n} éléments · ${state.recipes.size} recettes`;

    const preferred = ["free", "chrono", "timer"].includes(state.settings.mode)
      ? state.settings.mode
      : "free";
    setMode(preferred);
    persistSettingsFromUI();

    window.addEventListener("beforeunload", saveAppState);
  }

  init().catch((error) => {
    console.error(error);
    $("#dbStatus").textContent = "Erreur de chargement";
    setMessage(`${error.message} · Lance index.html via le serveur local WebStorm, pas en file://.`, "error", true);
  });
})();