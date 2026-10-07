const PHOTO_LIMIT = 200 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FARM_TABS = [
  ["dashboard", "Dashboard"],
  ["locations", "Locations"],
  ["animals", "Animals"],
  ["workers", "Workers"],
  ["settings", "Settings"],
];
const PHASE_PLACEHOLDERS = ["Egg Collection", "Produce", "Sales", "Movements", "Egg records", "Health log"];

export function initFarmUI({ api, getCurrentUser, notify, escapeHtml }) {
  const farmHost = document.getElementById("farmDashboard");
  const commandHost = document.getElementById("ccFarmView");
  const state = {
    user: typeof getCurrentUser === "function" ? getCurrentUser() : null,
    userKey: "",
    scopeVersion: 0,
    tab: "dashboard",
    stats: null,
    locations: [],
    workers: [],
    animals: [],
    animalTypes: [],
    settings: null,
    organization: null,
    filters: { location_id: "", type_id: "", search: "", status: "", health_status: "" },
    loading: {},
    errors: {},
    modal: null,
    saving: false,
    detailAnimal: null,
    command: { organizations: [], loading: false, error: "", creating: false },
  };

  const esc = (value) => typeof escapeHtml === "function"
    ? escapeHtml(value == null ? "" : String(value))
    : String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  const announce = (message, type = "success") => {
    if (typeof notify === "function") notify(message, type);
  };
  const idOf = (user) => user?.id ?? user?.user_id ?? user?.email ?? "";
  const roleOf = (user) => String(user?.role || "").toLowerCase();
  const isFarmAdmin = () => roleOf(state.user) === "farm_admin";
  const moneyless = (value) => value == null || value === "" ? "—" : esc(value);
  const initials = (value) => String(value || "Farm").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  const fullName = (worker) => `${worker?.first_name || ""} ${worker?.last_name || ""}`.trim() || "Worker";

  async function request(path, options = undefined) {
    if (typeof api !== "function") throw new Error("The authenticated API helper is unavailable.");
    const result = options ? await api(path, options) : await api(path);
    if (typeof Response !== "undefined" && result instanceof Response) {
      const payload = await result.json().catch(() => ({}));
      if (!result.ok) {
        const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message || payload?.message;
        const error = new Error(message || `Request failed (${result.status}).`);
        error.status = result.status;
        throw error;
      }
      return payload;
    }
    if (result && typeof result === "object" && Number(result.status) >= 400) {
      const error = new Error(result.message || result.error?.message || `Request failed (${result.status}).`);
      error.status = Number(result.status);
      throw error;
    }
    return result || {};
  }

  function errorMessage(error) {
    if (Number(error?.status || error?.statusCode) === 401) return "Your session has expired. Sign in again to continue.";
    if (Number(error?.status || error?.statusCode) === 403) return "You do not have permission to view this farm information.";
    return error?.message || "Something went wrong. Please try again.";
  }

  function icon(name, size = 18) {
    const paths = {
      farm: '<path d="M3 20V9l9-6 9 6v11"/><path d="M9 20v-6h6v6M3 10h18"/>',
      dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="14" width="8" height="7" rx="1.5"/>',
      pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
      animal: '<path d="M5 13c0-3 2.5-5 7-5s7 2 7 5-2 5-7 5-7-2-7-5Z"/><path d="M7 8 5 5M17 8l2-3M8 18l-1 3M16 18l1 3M3 12l2 1M21 12l-2 1"/>',
      people: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.2 1-1.5 2.6-1.5-.6a8 8 0 0 1-1.4.8l-.3 1.6h-3l-.3-1.6a8 8 0 0 1-1.4-.8l-1.5.6-1.5-2.6 1.2-1-.1-.1a7 7 0 0 1 0-1.8l-.1-.1-1.2-1 1.5-2.6 1.5.6a8 8 0 0 1 1.4-.8l.3-1.6h3l.3 1.6a8 8 0 0 1 1.4.8l1.5-.6 1.5 2.6-1.2 1 .1.1a7 7 0 0 1 0 1.8Z"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
      arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
      close: '<path d="m6 6 12 12M18 6 6 18"/>',
      alert: '<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
      retry: '<path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 1-2.3-5.7L20 9"/>',
    };
    return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.farm}</svg>`;
  }

  function setError(key, error) {
    state.errors[key] = error ? errorMessage(error) : "";
  }
  async function loadStats() {
    if (!isFarmAdmin()) return;
    const scopeVersion = state.scopeVersion;
    state.loading.stats = true;
    state.errors.stats = "";
    renderFarm();
    try {
      const stats = await request("/api/farm/stats");
      if (scopeVersion !== state.scopeVersion) return;
      state.stats = stats;
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      setError("stats", error);
    } finally {
      if (scopeVersion !== state.scopeVersion) return;
      state.loading.stats = false;
      renderFarm();
    }
  }
  async function loadLocations() {
    if (!isFarmAdmin()) return;
    const scopeVersion = state.scopeVersion;
    state.loading.locations = true;
    state.errors.locations = "";
    renderFarm();
    try {
      const payload = await request("/api/farm/locations");
      if (scopeVersion !== state.scopeVersion) return;
      state.locations = Array.isArray(payload?.locations) ? payload.locations : [];
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      setError("locations", error);
    } finally {
      if (scopeVersion !== state.scopeVersion) return;
      state.loading.locations = false;
      renderFarm();
    }
  }
  async function loadWorkers() {
    if (!isFarmAdmin()) return;
    const scopeVersion = state.scopeVersion;
    state.loading.workers = true;
    state.errors.workers = "";
    renderFarm();
    try {
      const payload = await request("/api/farm/workers");
      if (scopeVersion !== state.scopeVersion) return;
      state.workers = Array.isArray(payload?.workers) ? payload.workers : [];
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      setError("workers", error);
    } finally {
      if (scopeVersion !== state.scopeVersion) return;
      state.loading.workers = false;
      renderFarm();
    }
  }
  async function loadAnimalTypes() {
    if (!isFarmAdmin()) return;
    const scopeVersion = state.scopeVersion;
    state.loading.animalTypes = true;
    state.errors.animalTypes = "";
    try {
      const payload = await request("/api/farm/animal-types");
      if (scopeVersion !== state.scopeVersion) return;
      state.animalTypes = Array.isArray(payload?.animalTypes) ? payload.animalTypes : [];
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      setError("animalTypes", error);
    } finally {
      if (scopeVersion !== state.scopeVersion) return;
      state.loading.animalTypes = false;
      renderFarm();
    }
  }
  async function loadAnimals() {
    if (!isFarmAdmin()) return;
    const scopeVersion = state.scopeVersion;
    state.loading.animals = true;
    state.errors.animals = "";
    renderFarm();
    try {
      const query = new URLSearchParams();
      Object.entries(state.filters).forEach(([key, value]) => { if (value) query.set(key, value); });
      const queryString = query.toString();
      const payload = await request(`/api/farm/animals${queryString ? `?${queryString}` : ""}`);
      if (scopeVersion !== state.scopeVersion) return;
      state.animals = Array.isArray(payload?.animals) ? payload.animals : [];
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      setError("animals", error);
    } finally {
      if (scopeVersion !== state.scopeVersion) return;
      state.loading.animals = false;
      renderFarm();
    }
  }
  async function loadSettings() {
    if (!isFarmAdmin()) return;
    const scopeVersion = state.scopeVersion;
    state.loading.settings = true;
    state.errors.settings = "";
    renderFarm();
    try {
      const payload = await request("/api/farm/settings");
      if (scopeVersion !== state.scopeVersion) return;
      state.organization = payload?.organization || null;
      state.settings = payload?.settings || null;
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      setError("settings", error);
    } finally {
      if (scopeVersion !== state.scopeVersion) return;
      state.loading.settings = false;
      renderFarm();
    }
  }

  function titleForTab(tab) {
    return FARM_TABS.find(([key]) => key === tab)?.[1] || "Dashboard";
  }
  function shellMarkup() {
    const orgName = state.organization?.name || state.user?.organization_name || "Farm workspace";
    const displayName = state.user?.name || state.user?.full_name || state.user?.email || "Farm administrator";
    const brandColor = validColor(state.organization?.brand_color) ? state.organization.brand_color : "#376b52";
    const logo = safeImage(state.organization?.logo_base64);
    return `<div class="farm-shell" style="--farm-brand-color:${brandColor}">
      <aside class="farm-rail" aria-label="Farm workspace navigation">
        <div class="farm-brand"><div class="farm-brand-mark">${logo ? `<img src="${logo}" alt="">` : icon("farm", 21)}</div><div><strong>${esc(orgName)}</strong><span>FARM OPERATIONS</span></div></div>
        <div class="farm-org-switch"><span class="farm-org-mark">${initials(orgName)}</span><span><strong>${esc(orgName)}</strong><small>Farm organization</small></span></div>
        <nav class="farm-nav" aria-label="Farm admin sections">${FARM_TABS.map(([key, label]) => `<button type="button" data-farm-action="tab" data-tab="${key}" aria-current="${state.tab === key ? "page" : "false"}">${icon(key === "dashboard" ? "dashboard" : key === "locations" ? "pin" : key === "animals" ? "animal" : key === "workers" ? "people" : "settings")}<span>${label}</span></button>`).join("")}</nav>
        <div class="farm-rail-note"><span class="farm-note-dot"></span><span>Organization records<br><strong>Private to your team</strong></span></div>
      </aside>
      <main class="farm-main">
        <header class="farm-topbar"><div><p class="farm-overline">FARM ADMINISTRATION</p><h1>${titleForTab(state.tab)}</h1></div><div class="farm-user-chip"><span class="farm-avatar">${esc(initials(displayName))}</span><span><strong>${esc(displayName)}</strong><small>Farm administrator</small></span></div></header>
        <div class="farm-mobile-nav">${FARM_TABS.map(([key, label]) => `<button type="button" data-farm-action="tab" data-tab="${key}" aria-current="${state.tab === key ? "page" : "false"}">${label}</button>`).join("")}</div>
        <div class="farm-content">${tabMarkup()}</div>
      </main>
      ${modalMarkup()}
    </div>`;
  }
  function tabMarkup() {
    if (state.tab === "locations") return locationsPanel();
    if (state.tab === "workers") return workersPanel();
    if (state.tab === "animals") return animalsPanel();
    if (state.tab === "settings") return settingsPanel();
    return dashboardPanel();
  }
  function dashboardPanel() {
    if (state.loading.stats && !state.stats) return loadingPanel("Gathering your farm overview");
    if (state.errors.stats && !state.stats) return errorPanel("Farm overview unavailable", state.errors.stats, "stats");
    const stats = state.stats || {};
    const byType = Array.isArray(stats.by_type) ? stats.by_type : [];
    const metrics = [
      ["Locations", stats.locations, "pin", "Sites on this farm"],
      ["Workers", stats.workers, "people", "People in your team"],
      ["Animals", stats.animals, "animal", "Records across all sites"],
    ];
    return `<section class="farm-welcome">
      <div><p class="farm-overline">YOUR FARM, AT A GLANCE</p><h2>Good work starts<br>with a clear picture.</h2><p>Keep your locations, people, and animal records in order from one place.</p><button class="farm-btn farm-btn--light" type="button" data-farm-action="tab" data-tab="locations">Manage locations ${icon("arrow", 16)}</button></div>
      <div class="farm-welcome-mark" aria-hidden="true"><div class="farm-sun"></div><div class="farm-field field-one"></div><div class="farm-field field-two"></div><div class="farm-field field-three"></div><div class="farm-welcome-label">FIELD<br>NOTES <span>01</span></div></div>
    </section>
    <div class="farm-section-line"><div><p class="farm-overline">CURRENT RECORDS</p><h2>Farm overview</h2></div><button type="button" class="farm-btn farm-btn--quiet farm-btn--small" data-farm-action="retry-stats">${icon("retry", 15)} Refresh</button></div>
    ${state.errors.stats ? `<div class="farm-inline-error">${esc(state.errors.stats)} <button type="button" data-farm-action="retry-stats">Try again</button></div>` : ""}
    <section class="farm-metrics">${metrics.map(([label, value, iconName, note], index) => `<article class="farm-metric"><div class="farm-metric-top"><span>${label}</span><span class="farm-metric-icon">${icon(iconName, 18)}</span></div><strong>${esc(value ?? 0)}</strong><small>${note}</small><span class="farm-metric-index">0${index + 1}</span></article>`).join("")}</section>
    <section class="farm-overview-grid">
      <article class="farm-panel farm-type-panel"><div class="farm-panel-heading"><div><p class="farm-overline">ANIMAL REGISTER</p><h3>Animals by type</h3></div><button type="button" class="farm-text-link" data-farm-action="tab" data-tab="animals">View animals ${icon("arrow", 14)}</button></div>
        ${byType.length ? `<div class="farm-type-list">${byType.map((entry, index) => `<div class="farm-type-row"><span class="farm-type-number">0${index + 1}</span><span class="farm-type-name"><strong>${esc(entry.name || entry.type_name || entry.type || entry.animal_type || "Animal type")}</strong><small>${esc(entry.category || "Category not specified")}</small></span><strong class="farm-type-count">${esc(entry.count ?? entry.animals ?? entry.quantity ?? entry.total ?? 0)}</strong></div>`).join("")}</div>` : `<div class="farm-empty farm-empty--compact"><span class="farm-empty-mark">${icon("animal", 22)}</span><strong>No animal records yet</strong><p>Animal totals will appear here when records are added.</p></div>`}
      </article>
      <article class="farm-alert-card"><div class="farm-alert-head"><span class="farm-alert-symbol">${icon("alert", 19)}</span><p class="farm-overline">ATTENTION</p></div><strong class="farm-alert-count">${esc(stats.health_alerts ?? 0)}</strong><h3>Health alerts</h3><p>Animals needing attention based on your records.</p><div class="farm-alert-foot"><span class="farm-alert-rule"></span><span>Health alert total</span></div></article>
    </section>
    <section class="farm-panel farm-phase-panel"><div class="farm-panel-heading"><div><p class="farm-overline">ON THE ROADMAP</p><h3>More farm tools are coming</h3><p class="farm-panel-copy">These Phase 5B modules are not available yet.</p></div><span class="farm-phase-stamp">PHASE 5B</span></div><div class="farm-phase-list">${PHASE_PLACEHOLDERS.map((name) => `<div class="farm-phase-item" aria-disabled="true"><span>${esc(name)}</span><small>Coming later</small></div>`).join("")}</div></section>`;
  }

  function locationsPanel() {
    return `<section class="farm-panel"><div class="farm-panel-heading farm-panel-heading--actions"><div><p class="farm-overline">FARM SITES</p><h2>Locations</h2><p class="farm-panel-copy">Organize the places where your team works.</p></div><button type="button" class="farm-btn" data-farm-action="new-location">${icon("plus", 16)} Add location</button></div>
      ${resourceState("locations", "Loading farm locations")}
      ${!state.loading.locations && !state.errors.locations ? `<div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Location</th><th>Code</th><th>District</th><th>Size</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.locations.length ? state.locations.map((location) => `<tr><td><strong>${esc(location.name || "Unnamed location")}</strong><small>${esc(location.address || "")}</small></td><td>${moneyless(location.code)}</td><td>${moneyless(location.district)}</td><td>${location.size_acres == null || location.size_acres === "" ? "—" : `${esc(location.size_acres)} acres`}</td><td>${statusBadge(isActive(location.active))}</td><td><div class="farm-row-actions"><button type="button" class="farm-btn farm-btn--quiet farm-btn--small" data-farm-action="edit-location" data-id="${esc(location.id)}">Edit</button><button type="button" class="farm-btn farm-btn--danger-quiet farm-btn--small" data-farm-action="delete-location" data-id="${esc(location.id)}">Delete</button></div></td></tr>`).join("") : `<tr><td colspan="6"><div class="farm-empty-note">No locations have been added. Add your first farm site to organize workers and animal records.</div></td></tr>`}</tbody></table></div>` : ""}
    </section>`;
  }

  function workersPanel() {
    return `<section class="farm-panel"><div class="farm-panel-heading farm-panel-heading--actions"><div><p class="farm-overline">PEOPLE & ACCESS</p><h2>Workers</h2><p class="farm-panel-copy">Manage the team members assigned to your farm.</p></div><button type="button" class="farm-btn" data-farm-action="new-worker">${icon("plus", 16)} Add worker</button></div>
      ${resourceState("workers", "Loading farm workers")}
      ${!state.loading.workers && !state.errors.workers ? `<div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Worker</th><th>Role</th><th>Location</th><th>Employee code</th><th>Wage</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.workers.length ? state.workers.map((worker) => `<tr><td><strong>${esc(fullName(worker))}</strong><small>${esc(worker.email || worker.phone || "")}</small></td><td><span class="farm-role">${esc((worker.role || "").replace("farm_", ""))}</span></td><td>${esc(locationName(worker.location_id))}</td><td>${moneyless(worker.employee_code)}</td><td>${worker.wage_rate == null || worker.wage_rate === "" ? "—" : `${esc(worker.wage_rate)}${worker.wage_type ? ` / ${esc(worker.wage_type)}` : ""}`}</td><td>${statusBadge(isActive(worker.active))}</td><td><div class="farm-row-actions"><button type="button" class="farm-btn farm-btn--quiet farm-btn--small" data-farm-action="edit-worker" data-id="${esc(worker.id)}">Edit</button><button type="button" class="farm-btn farm-btn--danger-quiet farm-btn--small" data-farm-action="delete-worker" data-id="${esc(worker.id)}">Delete</button></div></td></tr>`).join("") : `<tr><td colspan="7"><div class="farm-empty-note">No workers have been added yet. Create a worker account to build your team.</div></td></tr>`}</tbody></table></div>` : ""}
    </section>`;
  }

  function animalsPanel() {
    const filters = state.filters;
    const typeLoading = state.loading.animalTypes;
    return `<section class="farm-panel"><div class="farm-panel-heading farm-panel-heading--actions"><div><p class="farm-overline">LIVESTOCK REGISTER</p><h2>Animals</h2><p class="farm-panel-copy">Search animal records and keep each record connected to its location.</p></div><button type="button" class="farm-btn" data-farm-action="new-animal">${icon("plus", 16)} Add animal</button></div>
      <form class="farm-filters" data-farm-form="animal-filters">
        <label class="farm-field farm-search-field"><span>Search</span><span class="farm-input-icon">${icon("search", 16)}<input name="search" type="search" value="${esc(filters.search)}" placeholder="Tag number or name"></span></label>
        <label class="farm-field"><span>Location</span><select name="location_id"><option value="">All locations</option>${state.locations.map((item) => `<option value="${esc(item.id)}" ${String(filters.location_id) === String(item.id) ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label>
        <label class="farm-field"><span>Animal type</span><select name="type_id"><option value="">All types</option>${state.animalTypes.map((item) => `<option value="${esc(item.id)}" ${String(filters.type_id) === String(item.id) ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label>
        <label class="farm-field"><span>Status</span><input name="status" value="${esc(filters.status)}" placeholder="Any status"></label>
        <label class="farm-field"><span>Health</span><input name="health_status" value="${esc(filters.health_status)}" placeholder="Any health status"></label>
        <button type="submit" class="farm-btn farm-btn--quiet">Apply filters</button>
      </form>
      ${typeLoading ? `<div class="farm-loading-skeleton" role="status" aria-label="Loading animal types"><span></span><span></span><small>Loading animal types…</small></div>` : ""}
      ${state.errors.animalTypes ? `<div class="farm-inline-error">Animal type list unavailable: ${esc(state.errors.animalTypes)} <button type="button" data-farm-action="load-types">Retry</button></div>` : ""}
      <div class="farm-tools-strip"><span>${esc(state.animals.length)} ${state.animals.length === 1 ? "record" : "records"} loaded</span></div>
      ${resourceState("animals", "Loading animal records")}
      ${!state.loading.animals && !state.errors.animals ? `<div class="farm-table-wrap"><table class="farm-table farm-animal-table"><thead><tr><th>Animal</th><th>Type</th><th>Age</th><th>Location</th><th>Quantity / weight</th><th>Health</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.animals.length ? state.animals.map((animal) => `<tr><td><button type="button" class="farm-animal-link" data-farm-action="view-animal" data-id="${esc(animal.id)}"><strong>${esc(animal.name || animal.tag_number || "Animal record")}</strong><small>${esc(animal.tag_number || "No tag recorded")}</small></button></td><td>${esc(animal.type_name || state.animalTypes.find((item) => String(item.id) === String(animal.animal_type_id))?.name || "—")}</td><td>${animalAge(animal.date_of_birth)}</td><td>${esc(animal.location_name || locationName(animal.location_id))}</td><td>${animal.quantity != null && animal.quantity !== "" ? `${esc(animal.quantity)} count` : animal.weight_kg != null && animal.weight_kg !== "" ? `${esc(animal.weight_kg)} kg` : "—"}</td><td>${statusPill(animal.health_status || "not recorded")}</td><td>${statusPill(animal.status || "not recorded")}</td><td><div class="farm-row-actions"><button type="button" class="farm-btn farm-btn--quiet farm-btn--small" data-farm-action="edit-animal" data-id="${esc(animal.id)}">Edit</button><button type="button" class="farm-btn farm-btn--danger-quiet farm-btn--small" data-farm-action="delete-animal" data-id="${esc(animal.id)}">Delete</button></div></td></tr>`).join("") : `<tr><td colspan="8"><div class="farm-empty-note">No animal records match these filters. Add an animal or adjust the filters to see records.</div></td></tr>`}</tbody></table></div>` : ""}
    </section>`;
  }

  function settingsPanel() {
    if (state.loading.settings && !state.settings) return loadingPanel("Loading farm settings");
    if (state.errors.settings && !state.settings) return errorPanel("Farm settings unavailable", state.errors.settings, "settings");
    const org = state.organization || {};
    const settings = state.settings || {};
    const logo = safeImage(org.logo_base64);
    return `<form class="farm-panel farm-settings-form" data-farm-form="settings">
      <div class="farm-panel-heading"><div><p class="farm-overline">ORGANIZATION PROFILE</p><h2>Farm settings</h2><p class="farm-panel-copy">Keep your organization details and operating preferences up to date.</p></div></div>
      ${state.errors.settings ? `<div class="farm-inline-error">${esc(state.errors.settings)} <button type="button" data-farm-action="retry-settings">Try again</button></div>` : ""}
      <div class="farm-settings-grid">
        <label class="farm-field"><span>Organization name</span><input name="name" required value="${esc(org.name || "")}"></label>
        <label class="farm-field"><span>Registration number</span><input name="registration_number" value="${esc(org.registration_number || "")}"></label>
        <label class="farm-field"><span>Tax identification number</span><input name="tin" value="${esc(org.tin || "")}"></label>
        <label class="farm-field"><span>Farm type</span><input name="farm_type" value="${esc(org.farm_type || "")}"></label>
        <label class="farm-field farm-span-2"><span>Address</span><input name="address" value="${esc(org.address || "")}"></label>
        <label class="farm-field"><span>City</span><input name="city" value="${esc(org.city || "")}"></label>
        <label class="farm-field"><span>District</span><input name="district" value="${esc(org.district || "")}"></label>
        <label class="farm-field"><span>Country</span><input name="country" value="${esc(org.country || "")}"></label>
        <label class="farm-field"><span>Farm size (acres)</span><input name="size_acres" type="number" min="0" step="any" value="${esc(org.size_acres ?? "")}"></label>
        <label class="farm-field"><span>Phone</span><input name="phone" type="tel" value="${esc(org.phone || "")}"></label>
        <label class="farm-field"><span>Email</span><input name="email" type="email" value="${esc(org.email || "")}"></label>
        <label class="farm-field"><span>Website</span><input name="website" type="url" value="${esc(org.website || "")}"></label>
        <label class="farm-field"><span>Currency</span><input name="currency" value="${esc(settings.currency || "")}" placeholder="UGX"></label>
        <label class="farm-field"><span>Timezone</span><input name="timezone" value="${esc(settings.timezone || "")}" placeholder="Africa/Kampala"></label>
        <label class="farm-field"><span>Brand color</span><span class="farm-color-input"><input type="color" name="brand_color" value="${esc(validColor(org.brand_color) ? org.brand_color : "#386b56")}"><span>${esc(org.brand_color || "Choose a brand color")}</span></span></label>
        <label class="farm-field farm-logo-field"><span>Organization logo</span><input type="file" name="logo_file" accept="image/png,image/jpeg,image/webp"><small>PNG, JPEG or WebP · maximum 200 KB</small>${logo ? `<img class="farm-logo-preview" src="${logo}" alt="Current organization logo">` : `<span class="farm-logo-placeholder">No logo uploaded</span>`}</label>
      </div>
      <div class="farm-form-footer"><span>Changes apply to your farm organization.</span><div class="farm-row-actions"><button type="button" class="farm-btn farm-btn--quiet" data-farm-action="seed-animal-types">Seed default animal types</button><button type="submit" class="farm-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save settings"}</button></div></div>
    </form>`;
  }

  function locationName(id) {
    return state.locations.find((location) => String(location.id) === String(id))?.name || "—";
  }
  function animalAge(value) {
    if (!value) return "—";
    const birth = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    const today = new Date();
    if (Number.isNaN(birth.getTime()) || birth > today) return "—";
    let years = today.getFullYear() - birth.getFullYear();
    let months = today.getMonth() - birth.getMonth();
    if (today.getDate() < birth.getDate()) months -= 1;
    if (months < 0) {
      years -= 1;
      months += 12;
    }
    return years > 0 ? `${years} ${years === 1 ? "year" : "years"}` : months > 0 ? `${months} ${months === 1 ? "month" : "months"}` : "Under 1 month";
  }
  function validColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || "")); }
  function safeImage(value) {
    return /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(String(value || "")) ? value : "";
  }
  function capitalize(value) { return String(value || "").replace(/^./, (letter) => letter.toUpperCase()); }
  function statusBadge(active) { return `<span class="farm-status ${active ? "is-active" : "is-inactive"}"><i></i>${active ? "Active" : "Inactive"}</span>`; }
  function isActive(value) { return !(value === false || value === 0 || value === "false"); }
  function statusPill(value) { return `<span class="farm-health">${esc(capitalize(String(value).replaceAll("_", " ")))}</span>`; }
  function resourceState(key, label) {
    if (state.loading[key]) return `<div class="farm-loading-skeleton" role="status" aria-label="${esc(label)}"><span></span><span></span><span></span><small>${esc(label)}…</small></div>`;
    if (state.errors[key]) return `<div class="farm-resource-error"><span>${icon("alert", 18)} ${esc(state.errors[key])}</span><button type="button" class="farm-btn farm-btn--quiet farm-btn--small" data-farm-action="retry-${key}">${icon("retry", 14)} Try again</button></div>`;
    return "";
  }
  function loadingPanel(label) {
    return `<section class="farm-panel farm-state-card"><div class="farm-skeleton-heading"></div><div class="farm-skeleton-row"></div><div class="farm-skeleton-row"></div><div class="farm-skeleton-row"></div><p>${esc(label)}…</p></section>`;
  }
  function errorPanel(title, error, retry) {
    return `<section class="farm-panel farm-state-card farm-state-error"><span class="farm-state-icon">${icon("alert", 23)}</span><h2>${esc(title)}</h2><p>${esc(error)}</p><button class="farm-btn farm-btn--quiet" type="button" data-farm-action="retry-${retry}">${icon("retry", 15)} Try again</button></section>`;
  }

  function modalMarkup() {
    if (!state.modal) return "";
    const { kind, record = {} } = state.modal;
    if (kind === "location") return modalFrame(`${record.id ? "Edit" : "Add"} location`, locationForm(record));
    if (kind === "worker") return modalFrame(`${record.id ? "Edit" : "Add"} worker`, workerForm(record));
    if (kind === "animal") return modalFrame(`${record.id ? "Edit" : "Add"} animal`, animalForm(record));
    if (kind === "animal-detail") return modalFrame("Animal record", animalDetailMarkup(record));
    if (kind === "organization") return modalFrame("Create farm organization", organizationForm());
    return "";
  }
  function modalFrame(title, form) {
    return `<div class="farm-modal-backdrop" data-farm-action="dismiss-modal"><section class="farm-modal" role="dialog" aria-modal="true" aria-labelledby="farmModalTitle" data-farm-modal><div class="farm-modal-heading"><div><p class="farm-overline">FARM RECORD</p><h2 id="farmModalTitle">${esc(title)}</h2></div><button type="button" class="farm-icon-btn" aria-label="Close dialog" data-farm-action="close-modal">${icon("close", 18)}</button></div>${form}</section></div>`;
  }
  function field(name, label, value = "", type = "text", options = {}) {
    const required = options.required ? "required" : "";
    const min = options.min != null ? `min="${esc(options.min)}"` : "";
    const step = options.step != null ? `step="${esc(options.step)}"` : "";
    const placeholder = options.placeholder ? `placeholder="${esc(options.placeholder)}"` : "";
    if (type === "select") {
      const choices = options.choices || [];
      return `<label class="farm-field"><span>${esc(label)}</span><select name="${esc(name)}" ${required}><option value="">${esc(options.emptyLabel || "Select")}</option>${choices.map(([key, text]) => `<option value="${esc(key)}" ${String(value) === String(key) ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
    }
    if (type === "textarea") return `<label class="farm-field farm-span-2"><span>${esc(label)}</span><textarea name="${esc(name)}" rows="3" ${placeholder}>${esc(value || "")}</textarea></label>`;
    return `<label class="farm-field"><span>${esc(label)}</span><input type="${type}" name="${esc(name)}" value="${type === "file" ? "" : esc(value ?? "")}" ${required} ${min} ${step} ${placeholder}></label>`;
  }
  function locationForm(record) {
    return `<form class="farm-form-grid" data-farm-form="location" data-id="${esc(record.id || "")}">${field("name", "Location name", record.name, "text", { required: true })}${field("code", "Location code", record.code)}${field("address", "Address", record.address, "text", { })}${field("district", "District", record.district)}${field("size_acres", "Size (acres)", record.size_acres, "number", { min: 0, step: "any" })}<label class="farm-field"><span>Location status</span><select name="active"><option value="true" ${isActive(record.active) ? "selected" : ""}>Active</option><option value="false" ${!isActive(record.active) ? "selected" : ""}>Inactive</option></select></label><div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-action="close-modal">Cancel</button><button type="submit" class="farm-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : record.id ? "Save location" : "Create location"}</button></div></form>`;
  }
  function workerForm(record) {
    return `<form class="farm-form-grid" data-farm-form="worker" data-id="${esc(record.id || "")}">
      ${field("first_name", "First name", record.first_name, "text", { required: true })}${field("last_name", "Last name", record.last_name, "text", { required: true })}
      ${field("email", "Email", record.email, "email", { required: true })}${field("phone", "Phone", record.phone, "tel")}
      ${field("role", "Role", record.role || "farm_worker", "select", { required: true, choices: [["farm_worker", "Farm worker"], ["farm_manager", "Farm manager"]] })}
      ${field("location_id", "Location", record.location_id || "", "select", { choices: state.locations.map((item) => [item.id, item.name]), emptyLabel: "No location assigned" })}
      ${field("employee_code", "Employee code", record.employee_code)}
      ${field("wage_type", "Wage type", record.wage_type || "", "text", { placeholder: "Enter wage type" })}
      ${field("wage_rate", "Wage rate", record.wage_rate, "number", { min: 0, step: "any" })}
      ${field("active", "Account status", String(isActive(record.active)), "select", { choices: [["true", "Active"], ["false", "Inactive"]] })}
        ${record.id ? "" : `<label class="farm-field farm-span-2"><span>Initial password</span><input name="password" type="password" minlength="8" required autocomplete="new-password"><small>At least 8 characters. Saved passwords are never displayed.</small></label>`}
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-action="close-modal">Cancel</button><button type="submit" class="farm-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : record.id ? "Save worker" : "Create worker"}</button></div>
    </form>`;
  }
  function animalForm(record) {
    const selectedType = state.animalTypes.find((item) => String(item.id) === String(record.animal_type_id));
    const batch = selectedType?.tracking_mode === "batch";
    return `<form class="farm-form-grid" data-farm-form="animal" data-id="${esc(record.id || "")}">
      <label class="farm-field"><span>Animal type</span><select name="animal_type_id" required><option value="">Select animal type</option>${state.animalTypes.map((item) => `<option value="${esc(item.id)}" data-tracking="${esc(item.tracking_mode)}" ${String(record.animal_type_id) === String(item.id) ? "selected" : ""}>${esc(item.name)}${item.tracking_mode === "batch" ? " · Batch" : ""}</option>`).join("")}</select></label>
      ${field("location_id", "Location", record.location_id || "", "select", { required: true, choices: state.locations.map((item) => [item.id, item.name]), emptyLabel: "Select location" })}
      <label class="farm-field" data-animal-tag-field><span>Tag number <small class="farm-field-hint" data-animal-tag-hint>${batch ? "(optional batch reference)" : "(leave blank for an assigned sequential tag)"}</small></span><input name="tag_number" value="${esc(record.tag_number || "")}"></label>
      ${field("name", "Name", record.name)}
      ${field("gender", "Gender", record.gender || "", "text", { placeholder: "Enter gender" })}
      ${field("date_of_birth", "Date of birth", record.date_of_birth ? String(record.date_of_birth).slice(0, 10) : "", "date")}
      ${field("weight_kg", "Weight (kg)", record.weight_kg, "number", { min: 0, step: "any" })}
      <label class="farm-field" data-animal-quantity-field ${batch ? "" : "hidden"}><span>Count / quantity</span><input name="quantity" type="number" min="1" step="1" value="${esc(record.quantity ?? "")}" ${batch ? "required" : "disabled"}></label>
      ${field("health_status", "Health status", record.health_status, "text", { placeholder: "Enter health status" })}
      ${field("status", "Record status", record.status, "text", { placeholder: "Enter record status" })}
      ${field("notes", "Notes", record.notes, "textarea")}
      <label class="farm-field farm-span-2"><span>Animal photo</span><input name="photo_file" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG, JPEG or WebP · maximum 200 KB</small>${safeImage(record.photo_base64) ? `<img class="farm-logo-preview" src="${record.photo_base64}" alt="Current animal photo">` : ""}</label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-action="close-modal">Cancel</button><button type="submit" class="farm-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : record.id ? "Save animal" : "Create animal"}</button></div>
    </form>`;
  }
  function animalDetailMarkup(animal) {
    const photo = safeImage(animal.photo_base64);
    const birthDate = animal.date_of_birth ? String(animal.date_of_birth).slice(0, 10) : "";
    const ageYears = birthDate
      ? Math.max(0, Math.floor((Date.now() - new Date(`${birthDate}T00:00:00`).getTime()) / 31_557_600_000))
      : null;
    return `<section class="farm-animal-detail">
      <div class="farm-animal-detail-head">${photo ? `<img src="${photo}" alt="${esc(animal.name || animal.tag_number || "Animal")}">` : `<span class="farm-animal-detail-placeholder">${icon("animal", 28)}</span>`}<div><p class="farm-overline">${esc(animal.type_name || "Animal type")}</p><h3>${esc(animal.tag_number || animal.name || "Animal record")}</h3><p>${esc(animal.status || "active")} · ${esc(animal.tracking_mode === "batch" ? `${animal.quantity ?? 1} count` : animal.gender || "Individual")}</p></div></div>
      <dl class="farm-animal-facts"><div><dt>Name</dt><dd>${esc(animal.name || "Not recorded")}</dd></div><div><dt>Location</dt><dd>${esc(animal.location_name || locationName(animal.location_id))}</dd></div><div><dt>Gender</dt><dd>${esc(animal.gender || "Not recorded")}</dd></div><div><dt>Date of birth</dt><dd>${esc(birthDate || "Not recorded")}${ageYears === null ? "" : ` · ${ageYears} years`}</dd></div><div><dt>Weight</dt><dd>${animal.weight_kg == null ? "Not recorded" : `${esc(animal.weight_kg)} kg`}</dd></div><div><dt>Health status</dt><dd>${esc(animal.health_status || "Not recorded")}</dd></div><div class="farm-animal-fact-wide"><dt>Notes</dt><dd>${esc(animal.notes || "No notes")}</dd></div></dl>
      <div class="farm-phase-detail"><strong>Phase 5B tools</strong><button type="button" disabled>Movements</button><button type="button" disabled>Egg records</button><button type="button" disabled>Health log</button></div>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-action="close-modal">Close</button><button type="button" class="farm-btn" data-farm-action="edit-detail-animal" data-id="${esc(animal.id)}">Edit animal</button></div>
    </section>`;
  }
  function organizationForm() {
    return `<form class="farm-form-grid" data-farm-form="organization">
      ${field("name", "Organization name", "", "text", { required: true })}
      ${field("farm_type", "Farm type", "", "text", { required: true })}
      ${field("admin_name", "Administrator name", "", "text", { required: true })}
      ${field("admin_email", "Administrator email", "", "email", { required: true })}
      ${field("admin_password", "Administrator password", "", "password", { required: true, min: 8 })}
      ${field("phone", "Phone", "", "tel")}${field("tin", "Tax identification number")}
      ${field("address", "Address", "", "text", {})}${field("city", "City")}
      ${field("district", "District") }
      <div class="farm-command-note farm-span-2">A farm organization and its first administrator account will be created together.</div>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-action="close-modal">Cancel</button><button type="submit" class="farm-btn" ${state.command.creating ? "disabled" : ""}>${state.command.creating ? "Creating…" : "Create organization"}</button></div>
    </form>`;
  }

  function renderFarm() {
    if (!farmHost) return;
    if (!state.user || !["farm_admin", "farm_manager", "farm_worker"].includes(roleOf(state.user))) {
      farmHost.innerHTML = "";
      return;
    }
    if (!isFarmAdmin()) {
      const label = roleOf(state.user) === "farm_manager" ? "Farm manager" : "Farm worker";
      farmHost.innerHTML = `<section class="farm-staff-welcome"><p class="farm-overline">FARM OPERATIONS</p><h1>Your farm account is active</h1><p>${esc(label)} tools are not part of the Phase 5A administrator workspace. Ask your farm administrator if you need access to another section.</p></section>`;
      return;
    }
    farmHost.innerHTML = shellMarkup();
  }

  function commandMarkup() {
    if (!state.user || roleOf(state.user) !== "superadmin") {
      return `<section class="farm-command-panel"><div class="farm-panel farm-state-card"><h2>Farm organizations</h2><p>This view is available to platform administrators.</p></div></section>`;
    }
    const totals = state.command.organizations.reduce((result, org) => {
      result.farms += 1;
      result.animals += Number(org.counts?.animals ?? org.animals_count ?? 0);
      result.workers += Number(org.counts?.workers ?? org.workers_count ?? 0);
      return result;
    }, { farms: 0, animals: 0, workers: 0 });
    return `<section class="farm-command-panel">
      <div class="farm-command-heading"><div><p class="farm-overline">COMMAND CENTER / ORGANIZATIONS</p><h2>Farm organizations</h2><p>Review registered farms and set up new organizations.</p></div><button type="button" class="farm-btn" data-farm-action="new-organization">${icon("plus", 16)} Create organization</button></div>
      ${!state.command.loading && !state.command.error ? `<section class="farm-command-stats"><article><small>Total farms</small><strong>${esc(totals.farms)}</strong></article><article><small>Registered animals</small><strong>${esc(totals.animals)}</strong></article><article><small>Active workers</small><strong>${esc(totals.workers)}</strong></article></section>` : ""}
      ${state.command.loading ? `<section class="farm-panel farm-state-card"><div class="farm-skeleton-heading"></div><div class="farm-skeleton-row"></div><div class="farm-skeleton-row"></div><p>Loading farm organizations…</p></section>` : ""}
      ${state.command.error ? `<section class="farm-panel farm-resource-error"><span>${icon("alert", 18)} ${esc(state.command.error)}</span><button type="button" class="farm-btn farm-btn--quiet farm-btn--small" data-farm-action="retry-command">${icon("retry", 14)} Try again</button></section>` : ""}
      ${!state.command.loading && !state.command.error ? `<section class="farm-panel"><div class="farm-panel-heading"><div><p class="farm-overline">ORGANIZATION DIRECTORY</p><h3>${esc(state.command.organizations.length)} ${state.command.organizations.length === 1 ? "farm" : "farms"}</h3></div></div>
        <div class="farm-table-wrap"><table class="farm-table farm-org-table"><thead><tr><th>Organization</th><th>Farm type</th><th>District</th><th>Contact</th><th>Locations</th><th>Workers</th><th>Animals</th></tr></thead><tbody>${state.command.organizations.length ? state.command.organizations.map((org) => `<tr><td><strong>${esc(org.name || "Unnamed organization")}</strong><small>${esc(org.registration_number || org.tin || "Registration not provided")}</small></td><td>${moneyless(org.farm_type)}</td><td>${moneyless(org.district)}</td><td>${esc(org.phone || org.email || "—")}</td><td>${esc(org.counts?.locations ?? org.locations_count ?? 0)}</td><td>${esc(org.counts?.workers ?? org.workers_count ?? 0)}</td><td>${esc(org.counts?.animals ?? org.animals_count ?? 0)}</td></tr>`).join("") : `<tr><td colspan="7"><div class="farm-empty-note">No farm organizations have been created. Create an organization to set up its first administrator.</div></td></tr>`}</tbody></table></div>
      </section>` : ""}
      ${state.modal?.kind === "organization" ? modalMarkup() : ""}
    </section>`;
  }

  async function loadCommandCenter() {
    if (roleOf(state.user) !== "superadmin") {
      if (commandHost) commandHost.innerHTML = commandMarkup();
      return;
    }
    const scopeVersion = state.scopeVersion;
    state.command.loading = true;
    state.command.error = "";
    renderCommand();
    try {
      const payload = await request("/api/farm/organizations");
      if (scopeVersion !== state.scopeVersion) return;
      state.command.organizations = Array.isArray(payload?.organizations) ? payload.organizations : [];
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      state.command.error = errorMessage(error);
    } finally {
      if (scopeVersion !== state.scopeVersion) return;
      state.command.loading = false;
      renderCommand();
    }
  }
  function renderCommand() {
    if (commandHost) commandHost.innerHTML = commandMarkup();
  }

  function resetScopedState() {
    state.scopeVersion += 1;
    state.tab = "dashboard";
    state.stats = null;
    state.locations = [];
    state.workers = [];
    state.animals = [];
    state.animalTypes = [];
    state.settings = null;
    state.organization = null;
    state.filters = { location_id: "", type_id: "", search: "", status: "", health_status: "" };
    state.loading = {};
    state.errors = {};
    state.modal = null;
    state.saving = false;
    state.detailAnimal = null;
    state.command = { organizations: [], loading: false, error: "", creating: false };
  }

  function refreshTabData() {
    if (!isFarmAdmin()) return;
    if (state.tab === "dashboard") loadStats();
    if (state.tab === "locations") loadLocations();
    if (state.tab === "workers") { loadLocations(); loadWorkers(); }
    if (state.tab === "animals") { loadLocations(); loadAnimalTypes().then(loadAnimals); }
    if (state.tab === "settings") loadSettings();
  }

  function formFields(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    form.querySelectorAll('input[type="checkbox"]').forEach((input) => { data[input.name] = input.checked; });
    return data;
  }
  function normalizeRecord(form, keys) {
    const raw = formFields(form);
    const body = {};
    keys.forEach((key) => {
      if (!(key in raw)) return;
      const value = String(raw[key] ?? "").trim();
      if (["size_acres", "wage_rate", "weight_kg", "quantity"].includes(key)) body[key] = value === "" ? null : Number(value);
      else if (key === "active") body[key] = value === "true";
      else body[key] = value;
    });
    return body;
  }
  async function fileToBase64(file) {
    if (!file) return "";
    if (!IMAGE_TYPES.has(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.");
    if (file.size > PHOTO_LIMIT) throw new Error("Images must be 200 KB or smaller.");
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("The selected image could not be read."));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
  }

  async function submitFarmForm(form) {
    const type = form.dataset.farmForm;
    if (type === "animal-filters") {
      const raw = formFields(form);
      state.filters = Object.fromEntries(Object.keys(state.filters).map((key) => [key, String(raw[key] || "").trim()]));
      await loadAnimals();
      return;
    }
    if (state.saving) return;
    const scopeVersion = state.scopeVersion;
    state.saving = true;
    if (type === "organization") state.command.creating = true;
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = type === "organization" ? "Creating…" : "Saving…";
    }
    try {
      if (type === "location") {
        const body = normalizeRecord(form, ["name", "code", "address", "district", "size_acres", "active"]);
        const id = form.dataset.id;
        await request(id ? `/api/farm/locations/${encodeURIComponent(id)}` : "/api/farm/locations", { method: id ? "PATCH" : "POST", body });
        if (scopeVersion !== state.scopeVersion) return;
        state.modal = null;
        announce(id ? "Location updated." : "Location created.");
        await Promise.all([loadLocations(), loadStats()]);
      } else if (type === "worker") {
        const body = normalizeRecord(form, ["first_name", "last_name", "email", "phone", "role", "location_id", "employee_code", "wage_type", "wage_rate", "active", "password"]);
        if (body.location_id === "") body.location_id = null;
        if (!form.dataset.id && String(body.password || "").length < 8) throw new Error("Initial password must be at least 8 characters.");
        const id = form.dataset.id;
        await request(id ? `/api/farm/workers/${encodeURIComponent(id)}` : "/api/farm/workers", { method: id ? "PATCH" : "POST", body });
        if (scopeVersion !== state.scopeVersion) return;
        state.modal = null;
        announce(id ? "Worker updated." : "Worker account created.");
        await Promise.all([loadWorkers(), loadStats()]);
      } else if (type === "animal") {
        const body = normalizeRecord(form, ["animal_type_id", "location_id", "tag_number", "name", "gender", "date_of_birth", "weight_kg", "quantity", "health_status", "status", "notes"]);
        if (body.tag_number === "") delete body.tag_number;
        const animalType = state.animalTypes.find((item) => String(item.id) === String(body.animal_type_id));
        if (animalType?.tracking_mode === "batch") {
          if (!body.quantity || body.quantity < 1) body.quantity = 1;
        } else {
          delete body.quantity;
        }
        const image = form.querySelector('[name="photo_file"]')?.files?.[0];
        if (image) body.photo_base64 = await fileToBase64(image);
        if (scopeVersion !== state.scopeVersion) return;
        const id = form.dataset.id;
        await request(id ? `/api/farm/animals/${encodeURIComponent(id)}` : "/api/farm/animals", { method: id ? "PATCH" : "POST", body });
        if (scopeVersion !== state.scopeVersion) return;
        state.modal = null;
        announce(id ? "Animal record updated." : "Animal record created.");
        await Promise.all([loadAnimals(), loadStats()]);
      } else if (type === "settings") {
        const body = normalizeRecord(form, ["name", "registration_number", "tin", "farm_type", "address", "city", "district", "country", "size_acres", "phone", "email", "website", "brand_color", "currency", "timezone"]);
        const image = form.querySelector('[name="logo_file"]')?.files?.[0];
        if (image) body.logo_base64 = await fileToBase64(image);
        if (scopeVersion !== state.scopeVersion) return;
        await request("/api/farm/settings", { method: "PATCH", body });
        if (scopeVersion !== state.scopeVersion) return;
        announce("Farm settings saved.");
        await loadSettings();
      } else if (type === "organization") {
        const body = normalizeRecord(form, ["name", "farm_type", "admin_name", "admin_email", "admin_password", "phone", "tin", "address", "city", "district"]);
        if (String(body.admin_password || "").length < 8) throw new Error("Administrator password must be at least 8 characters.");
        const payload = await request("/api/farm/organizations", { method: "POST", body });
        if (scopeVersion !== state.scopeVersion) return;
        state.modal = null;
        announce(payload?.email_sent ? "Farm organization created. Administrator email sent." : "Farm organization created.");
        await loadCommandCenter();
      }
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      announce(errorMessage(error), "error");
    } finally {
      if (scopeVersion !== state.scopeVersion) return;
      state.saving = false;
      state.command.creating = false;
      if (submitButton?.isConnected) {
        submitButton.disabled = false;
        submitButton.textContent = type === "organization"
          ? "Create organization"
          : form.dataset.id
            ? `Save ${type}`
            : `Create ${type}`;
      }
    }
  }

  async function deleteRecord(kind, id) {
    const label = kind === "location" ? "location" : kind === "worker" ? "worker" : "animal record";
    if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return;
    const scopeVersion = state.scopeVersion;
    const path = kind === "location" ? `/api/farm/locations/${encodeURIComponent(id)}` : kind === "worker" ? `/api/farm/workers/${encodeURIComponent(id)}` : `/api/farm/animals/${encodeURIComponent(id)}`;
    try {
      await request(path, { method: "DELETE" });
      if (scopeVersion !== state.scopeVersion) return;
      announce(`${capitalize(label)} deleted.`);
      if (kind === "location") await Promise.all([loadLocations(), loadStats()]);
      if (kind === "worker") await Promise.all([loadWorkers(), loadStats()]);
      if (kind === "animal") await Promise.all([loadAnimals(), loadStats()]);
    } catch (error) {
      if (scopeVersion !== state.scopeVersion) return;
      announce(errorMessage(error), "error");
    }
  }

  async function openAnimalForm(id = "") {
    const scopeVersion = state.scopeVersion;
    if (!state.animalTypes.length) await loadAnimalTypes();
    if (scopeVersion !== state.scopeVersion) return;
    if (id) {
      try {
        const payload = await request(`/api/farm/animals/${encodeURIComponent(id)}`);
        if (scopeVersion !== state.scopeVersion) return;
        state.modal = { kind: "animal", record: payload?.animal || {} };
      } catch (error) {
        if (scopeVersion !== state.scopeVersion) return;
        announce(errorMessage(error), "error");
        return;
      }
    } else {
      state.modal = { kind: "animal", record: {} };
    }
    renderFarm();
  }
  function openEdit(kind, id) {
    const source = kind === "location" ? state.locations : state.workers;
    const record = source.find((item) => String(item.id) === String(id));
    if (record) {
      state.modal = { kind, record };
      renderFarm();
    }
  }
  function updateAnimalTracking(form) {
    const select = form.querySelector('[name="animal_type_id"]');
    const tracking = select?.selectedOptions?.[0]?.dataset.tracking || "";
    const batch = tracking === "batch";
    const tag = form.querySelector('[data-animal-tag-field]');
    const quantity = form.querySelector('[data-animal-quantity-field]');
    if (tag) {
      tag.querySelector("input").disabled = false;
      tag.hidden = false;
      const hint = tag.querySelector("[data-animal-tag-hint]");
      if (hint) hint.textContent = batch ? "(optional batch reference)" : "(leave blank for an assigned sequential tag)";
    }
    if (quantity) {
      quantity.hidden = !batch;
      const input = quantity.querySelector("input");
      input.disabled = !batch;
      input.required = batch;
    }
  }

  async function handleFarmClick(event) {
    const button = event.target.closest("[data-farm-action]");
    if (!button || !farmHost?.contains(button)) return;
    const action = button.dataset.farmAction;
    const id = button.dataset.id;
    const scopeVersion = state.scopeVersion;
    if (action === "tab") {
      const next = button.dataset.tab;
      if (!FARM_TABS.some(([key]) => key === next)) return;
      state.tab = next;
      state.modal = null;
      renderFarm();
      refreshTabData();
    } else if (action === "retry-stats") loadStats();
    else if (action === "retry-locations") loadLocations();
    else if (action === "retry-workers") { await loadLocations(); await loadWorkers(); }
    else if (action === "retry-animals") loadAnimals();
    else if (action === "retry-settings") loadSettings();
    else if (action === "new-location") { state.modal = { kind: "location", record: {} }; renderFarm(); }
    else if (action === "new-worker") { if (!state.locations.length) await loadLocations(); if (scopeVersion !== state.scopeVersion) return; state.modal = { kind: "worker", record: {} }; renderFarm(); }
    else if (action === "new-animal") openAnimalForm();
    else if (action === "edit-location") openEdit("location", id);
    else if (action === "edit-worker") openEdit("worker", id);
    else if (action === "edit-animal") openAnimalForm(id);
    else if (action === "view-animal") {
      try {
        const payload = await request(`/api/farm/animals/${encodeURIComponent(id)}`);
        if (scopeVersion !== state.scopeVersion) return;
        state.modal = { kind: "animal-detail", record: payload?.animal || {} };
        renderFarm();
      } catch (error) {
        if (scopeVersion !== state.scopeVersion) return;
        announce(errorMessage(error), "error");
      }
    }
    else if (action === "edit-detail-animal") openAnimalForm(id);
    else if (action === "delete-location") deleteRecord("location", id);
    else if (action === "delete-worker") deleteRecord("worker", id);
    else if (action === "delete-animal") deleteRecord("animal", id);
    else if (action === "load-types") loadAnimalTypes();
    else if (action === "seed-animal-types") {
      const requestScope = state.scopeVersion;
      try {
        state.loading.animalTypes = true;
        renderFarm();
        const payload = await request("/api/farm/animal-types/seed-defaults", { method: "POST", body: {} });
        if (requestScope !== state.scopeVersion) return;
        state.animalTypes = Array.isArray(payload?.animalTypes) ? payload.animalTypes : [];
        announce(`${Number(payload?.created_count || 0)} default animal types added.`);
        await loadAnimals();
      } catch (error) {
        if (requestScope !== state.scopeVersion) return;
        state.errors.animalTypes = errorMessage(error);
        announce(errorMessage(error), "error");
      } finally {
        if (requestScope !== state.scopeVersion) return;
        state.loading.animalTypes = false;
        renderFarm();
      }
    } else if (action === "close-modal") { state.modal = null; renderFarm(); }
    else if (action === "dismiss-modal" && event.target === button) { state.modal = null; renderFarm(); }
  }
  async function handleCommandClick(event) {
    const button = event.target.closest("[data-farm-action]");
    if (!button || !commandHost?.contains(button)) return;
    const action = button.dataset.farmAction;
    if (action === "new-organization") { state.modal = { kind: "organization", record: {} }; renderCommand(); }
    else if (action === "close-modal") { state.modal = null; renderCommand(); }
    else if (action === "dismiss-modal" && event.target === button) { state.modal = null; renderCommand(); }
    else if (action === "retry-command") loadCommandCenter();
  }
  function handleFarmSubmit(event) {
    const form = event.target.closest("[data-farm-form]");
    if (!form || !farmHost?.contains(form)) return;
    event.preventDefault();
    submitFarmForm(form);
  }
  function handleCommandSubmit(event) {
    const form = event.target.closest("[data-farm-form='organization']");
    if (!form || !commandHost?.contains(form)) return;
    event.preventDefault();
    submitFarmForm(form);
  }
  function handleFarmChange(event) {
    const target = event.target;
    if (target.matches('[data-farm-form="animal"] [name="animal_type_id"]')) updateAnimalTracking(target.form);
    if (target.matches('[data-farm-form="settings"] [name="brand_color"]')) {
      const label = target.closest(".farm-color-input")?.querySelector("span");
      if (label) label.textContent = target.value;
    }
  }

  farmHost?.addEventListener("click", handleFarmClick);
  farmHost?.addEventListener("submit", handleFarmSubmit);
  farmHost?.addEventListener("change", handleFarmChange);
  commandHost?.addEventListener("click", handleCommandClick);
  commandHost?.addEventListener("submit", handleCommandSubmit);

  function setUser(user) {
    const nextKey = user ? `${idOf(user)}:${roleOf(user)}:${user.organization_id ?? user.organization?.id ?? ""}` : "";
    if (nextKey !== state.userKey) resetScopedState();
    state.user = user || null;
    state.userKey = nextKey;
    renderFarm();
    renderCommand();
    if (isFarmAdmin()) {
      refreshTabData();
      void loadSettings();
    }
    if (roleOf(state.user) === "superadmin") loadCommandCenter();
  }

  renderFarm();
  renderCommand();
  if (isFarmAdmin()) {
    refreshTabData();
    void loadSettings();
  }
  return { setUser, loadCommandCenter };
}

export default initFarmUI;
