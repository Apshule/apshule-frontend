const PHOTO_LIMIT = 200 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SHIFT_OPTIONS = [
  ["Morning", "Morning"],
  ["Afternoon", "Afternoon"],
  ["Evening", "Evening"],
];

export function initFarmOperationsUI({
  request,
  escapeHtml,
  notify,
  rerender,
  getCoreState,
  renderCommercialActions = () => "",
  renderCommercialSales = () => "",
  hasCommercialSales = () => false,
  onCommercialSalesTab = () => {},
}) {
  const state = {
    scopeVersion: 0,
    user: null,
    worker: null,
    workerTab: "today",
    eggs: [],
    eggSummary: null,
    todaySummary: null,
    weekSummary: null,
    attendance: [],
    attendanceSummary: null,
    healthLogs: [],
    movements: [],
    detailHealth: [],
    detailEggs: [],
    activeAnimal: null,
    animalDetailTab: "movements",
    eggFilters: { from: weekStartDate(), to: farmToday(), location_id: "" },
    attendanceFilters: { from: farmToday(), to: farmToday(), worker_id: "", status: "" },
    loading: {},
    errors: {},
    modal: null,
    cameraStream: null,
  };

  const esc = (value) => typeof escapeHtml === "function"
    ? escapeHtml(value == null ? "" : String(value))
    : String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  const announce = (message, kind = "success") => {
    if (typeof notify === "function") notify(message, kind);
  };
  const core = () => typeof getCoreState === "function" ? getCoreState() || {} : {};
  const isAdmin = () => String(state.user?.role || "").toLowerCase() === "farm_admin";
  const isManager = () => String(state.user?.role || "").toLowerCase() === "farm_manager";
  const canManageOperations = () => isAdmin() || isManager();
  const locations = () => Array.isArray(core().locations) ? core().locations : [];
  const workers = () => Array.isArray(core().workers) ? core().workers : [];
  const animals = () => Array.isArray(core().animals) ? core().animals : [];

  function localDateKey(timeZone = "Africa/Kampala", date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value || "00";
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  function farmToday() { return localDateKey(); }
  function weekStartDate(date = farmToday()) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    const day = parsed.getUTCDay();
    parsed.setUTCDate(parsed.getUTCDate() - ((day + 6) % 7));
    return parsed.toISOString().slice(0, 10);
  }
  function monthStartDate(date = farmToday()) { return `${date.slice(0, 7)}-01`; }
  function displayTime(value) {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? "—"
      : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
  }
  function dateTimeLocal(value) {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  }
  function datetimeIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  function setError(key, error) {
    state.errors[key] = error?.message || "Something went wrong. Please try again.";
  }
  function resourceState(key, label) {
    if (state.loading[key]) return `<div class="farm-loading-skeleton" role="status"><span></span><span></span><small>${esc(label)}…</small></div>`;
    if (state.errors[key]) return `<div class="farm-inline-error">${esc(state.errors[key])}<button type="button" data-farm-ops-action="retry" data-resource="${esc(key)}">Try again</button></div>`;
    return "";
  }
  function modalFrame(title, content) {
    return `<div class="farm-modal-backdrop" data-farm-ops-action="dismiss-modal"><section class="farm-modal" role="dialog" aria-modal="true" aria-labelledby="farmOpsModalTitle" data-farm-modal><div class="farm-modal-heading"><div><p class="farm-overline">FARM OPERATIONS</p><h2 id="farmOpsModalTitle">${esc(title)}</h2></div><button type="button" class="farm-icon-btn" aria-label="Close dialog" data-farm-ops-action="close-modal">×</button></div>${content}</section></div>`;
  }
  function currentEggFilters() {
    const params = new URLSearchParams();
    Object.entries(state.eggFilters).forEach(([key, value]) => { if (value) params.set(key, value); });
    return params.toString();
  }
  function currentAttendanceFilters() {
    const params = new URLSearchParams();
    ["from", "to", "worker_id"].forEach((key) => {
      if (state.attendanceFilters[key]) params.set(key, state.attendanceFilters[key]);
    });
    return params.toString();
  }

  async function loadEggData() {
    const scope = state.scopeVersion;
    const range = currentEggFilters();
    const today = farmToday();
    const thisWeek = weekStartDate(today);
    state.loading.eggs = true;
    state.errors.eggs = "";
    rerender();
    try {
      const [records, summary, todaySummary, weekSummary] = await Promise.all([
        request(`/api/farm/eggs${range ? `?${range}` : ""}`),
        request(`/api/farm/eggs/summary${range ? `?${range}` : ""}`),
        request(`/api/farm/eggs/summary?from=${today}&to=${today}`),
        request(`/api/farm/eggs/summary?from=${thisWeek}&to=${today}`),
      ]);
      if (scope !== state.scopeVersion) return;
      state.eggs = Array.isArray(records?.eggs) ? records.eggs : [];
      state.eggSummary = summary || null;
      state.todaySummary = todaySummary || null;
      state.weekSummary = weekSummary || null;
    } catch (error) {
      setError("eggs", error);
    } finally {
      if (scope !== state.scopeVersion) return;
      state.loading.eggs = false;
      rerender();
    }
  }

  async function loadAttendanceData() {
    const scope = state.scopeVersion;
    const range = currentAttendanceFilters();
    const query = range ? `?${range}` : "";
    state.loading.attendance = true;
    state.errors.attendance = "";
    rerender();
    try {
      const [payload, summary] = await Promise.all([
        request(`/api/farm/attendance${query}`),
        request(`/api/farm/attendance/summary${query}`),
      ]);
      if (scope !== state.scopeVersion) return;
      state.attendance = Array.isArray(payload?.attendance) ? payload.attendance : [];
      state.attendanceSummary = summary || null;
    } catch (error) {
      setError("attendance", error);
    } finally {
      if (scope !== state.scopeVersion) return;
      state.loading.attendance = false;
      rerender();
    }
  }

  async function loadHealthData(animalId = "") {
    const scope = state.scopeVersion;
    state.loading.health = true;
    state.errors.health = "";
    rerender();
    try {
      const query = animalId ? `?animal_id=${encodeURIComponent(animalId)}` : "";
      const payload = await request(`/api/farm/health${query}`);
      if (scope !== state.scopeVersion) return;
      state.healthLogs = Array.isArray(payload?.health_logs) ? payload.health_logs : [];
      if (animalId) state.detailHealth = state.healthLogs;
    } catch (error) {
      setError("health", error);
    } finally {
      if (scope !== state.scopeVersion) return;
      state.loading.health = false;
      rerender();
    }
  }

  async function loadAnimalMovements(animalId) {
    const scope = state.scopeVersion;
    state.loading.detail = true;
    state.errors.detail = "";
    rerender();
    try {
      const [movements, health] = await Promise.all([
        request(`/api/farm/movements?animal_id=${encodeURIComponent(animalId)}`),
        request(`/api/farm/health?animal_id=${encodeURIComponent(animalId)}`),
      ]);
      if (scope !== state.scopeVersion) return;
      state.movements = Array.isArray(movements?.movements) ? movements.movements : [];
      state.detailHealth = Array.isArray(health?.health_logs) ? health.health_logs : [];
      state.detailEggs = [];
      const animal = state.activeAnimal;
      if (animal && isPoultry(animal) && animal.location_id) {
        const params = new URLSearchParams({ location_id: animal.location_id });
        if (animal.animal_type_id) params.set("animal_type_id", animal.animal_type_id);
        const eggs = await request(`/api/farm/eggs?${params.toString()}`);
        if (scope !== state.scopeVersion) return;
        state.detailEggs = Array.isArray(eggs?.eggs) ? eggs.eggs : [];
      }
    } catch (error) {
      setError("detail", error);
    } finally {
      if (scope !== state.scopeVersion) return;
      state.loading.detail = false;
      rerender();
    }
  }

  async function setUser(user) {
    const nextRole = String(user?.role || "").toLowerCase();
    const changed = String(state.user?.id || "") !== String(user?.id || "") ||
      String(state.user?.role || "") !== nextRole;
    if (changed) {
      state.scopeVersion += 1;
      stopCamera();
      state.worker = null;
      state.workerAttendance = [];
      state.todayAttendance = null;
      state.workerAttendanceSummary = null;
      state.workerTab = "today";
      state.modal = null;
      state.cameraError = "";
      state.eggs = [];
      state.eggSummary = null;
      state.todaySummary = null;
      state.weekSummary = null;
      state.attendance = [];
      state.attendanceSummary = null;
      state.healthLogs = [];
      state.movements = [];
      state.detailHealth = [];
      state.detailEggs = [];
      state.activeAnimal = null;
      state.eggFilters = { from: weekStartDate(), to: farmToday(), location_id: "" };
      state.attendanceFilters = { from: farmToday(), to: farmToday(), worker_id: "", status: "" };
      state.errors = {};
      state.loading = {};
    }
    state.user = user || null;
    const scope = state.scopeVersion;
    if (nextRole === "farm_worker" && (!state.worker || changed)) {
      state.errors.worker = "";
      try {
        const payload = await request("/api/farm/workers/me");
        if (scope !== state.scopeVersion) return;
        state.worker = payload?.worker || null;
        state.attendanceFilters = {
          from: monthStartDate(),
          to: farmToday(),
          worker_id: state.worker?.id || "",
          status: "",
        };
        await loadWorkerAttendance();
      } catch (error) {
        setError("worker", error);
      }
    }
    rerender();
  }

  async function loadWorkerAttendance() {
    if (!state.worker?.id) return;
    const scope = state.scopeVersion;
    const today = farmToday();
    state.loading.workerAttendance = true;
    try {
      const [todayData, summary, history] = await Promise.all([
        request(`/api/farm/attendance?date=${today}`),
        request(`/api/farm/attendance/summary?from=${monthStartDate()}&to=${today}`),
        request(`/api/farm/attendance?from=${monthStartDate()}&to=${today}`),
      ]);
      if (scope !== state.scopeVersion) return;
      state.todayAttendance = Array.isArray(todayData?.attendance) ? todayData.attendance[0] || null : null;
      state.workerAttendanceSummary = summary || null;
      state.workerAttendance = Array.isArray(history?.attendance) ? history.attendance : [];
    } catch (error) {
      setError("workerAttendance", error);
    } finally {
      if (scope !== state.scopeVersion) return;
      state.loading.workerAttendance = false;
      rerender();
    }
  }

  function isPoultry(animal) {
    const type = core().animalTypes?.find((item) => String(item.id) === String(animal?.animal_type_id));
    const description = `${animal?.type_name || ""} ${animal?.category || ""} ${type?.name || ""} ${type?.category || ""}`.toLowerCase();
    return description.includes("poultry") || /chicken|hen|duck|turkey|quail/u.test(description);
  }

  function eggsPanel() {
    const summary = state.eggSummary || {};
    const today = state.todaySummary || {};
    const week = state.weekSummary || {};
    const bestLocation = Array.isArray(week.by_location) ? week.by_location[0]?.location_name : "";
    const canEdit = canManageOperations();
    const visibleEggs = state.eggFilters.location_id
      ? state.eggs.filter((egg) => String(egg.location_id) === String(state.eggFilters.location_id))
      : state.eggs;
    return `<section class="farm-panel">
      <div class="farm-panel-heading farm-panel-heading--actions"><div><p class="farm-overline">DAILY COLLECTION</p><h2>Egg records</h2><p class="farm-panel-copy">Record each location’s collection by date and shift. Re-saving a shift updates its existing record.</p></div><button class="farm-btn" type="button" data-farm-ops-action="new-egg">＋ Record eggs</button></div>
      <section class="farm-operation-metrics"><article><small>Today’s eggs</small><strong>${esc(today.total_collected ?? 0)}</strong></article><article><small>This week</small><strong>${esc(week.total_collected ?? 0)}</strong></article><article><small>Broken in range</small><strong>${esc(`${summary.broken_rate ?? 0}%`)}</strong></article><article><small>Best location this week</small><strong>${esc(bestLocation || "—")}</strong></article></section>
      <form class="farm-operation-filters" data-farm-ops-form="egg-filters">
        <label class="farm-field"><span>From</span><input type="date" name="from" value="${esc(state.eggFilters.from)}"></label>
        <label class="farm-field"><span>To</span><input type="date" name="to" value="${esc(state.eggFilters.to)}"></label>
        <label class="farm-field"><span>Location</span><select name="location_id"><option value="">All locations</option>${locations().map((item) => `<option value="${esc(item.id)}" ${String(state.eggFilters.location_id) === String(item.id) ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label>
        <button class="farm-btn farm-btn--quiet" type="submit">Apply filters</button>
      </form>
      ${resourceState("eggs", "Loading egg records")}
      ${!state.loading.eggs && !state.errors.eggs ? `<div class="farm-table-wrap"><table class="farm-table farm-operation-table"><thead><tr><th>Date</th><th>Shift</th><th>Location</th><th>Collected</th><th>Good</th><th>Broken</th><th>Recorded by</th>${canEdit ? "<th>Action</th>" : ""}</tr></thead><tbody>${visibleEggs.length ? visibleEggs.map((egg) => `<tr><td>${esc(egg.record_date)}</td><td>${esc(egg.shift)}</td><td>${esc(egg.location_name || "—")}</td><td>${esc(egg.eggs_collected)}</td><td>${esc(egg.eggs_good)}</td><td>${esc(egg.eggs_broken)}</td><td>${esc(egg.recorded_by_name || "—")}</td>${canEdit ? `<td><div class="farm-inline-actions"><button class="farm-btn farm-btn--quiet farm-btn--small" type="button" data-farm-ops-action="edit-egg" data-id="${esc(egg.id)}">Edit</button>${isAdmin() ? `<button class="farm-btn farm-btn--quiet farm-btn--small is-danger" type="button" data-farm-ops-action="delete-egg" data-id="${esc(egg.id)}">Delete</button>` : ""}</div></td>` : ""}</tr>`).join("") : `<tr><td colspan="${canEdit ? 8 : 7}"><div class="farm-empty-note">No egg records match this date range. Record a collection to start the daily totals.</div></td></tr>`}</tbody></table></div>` : ""}
      ${state.modal?.kind === "egg" ? modalFrame(state.modal.record?.id ? "Edit egg record" : "Record eggs", eggForm(state.modal.record, state.modal.quick)) : ""}
    </section>`;
  }

  function eggForm(record = {}, quick = false) {
    const assigned = state.worker?.location_id;
    const selectedLocation = record.location_id || (quick ? assigned : "");
    const locationChoices = quick
      ? (locations().find((location) => String(location.id) === String(assigned))
        ? locations().filter((location) => String(location.id) === String(assigned))
        : (assigned ? [{ id: assigned, name: state.worker?.location_name || "Assigned location" }] : []))
      : locations();
    const lockedLocation = quick || String(state.user?.role || "") === "farm_worker";
    return `<form class="farm-form-grid" data-farm-ops-form="egg" data-id="${esc(record.id || "")}" data-quick="${quick ? "true" : "false"}">
      <label class="farm-field"><span>Location</span><select name="location_id" ${lockedLocation ? "disabled" : ""} required><option value="">Select location</option>${locationChoices.map((location) => `<option value="${esc(location.id)}" ${String(selectedLocation) === String(location.id) ? "selected" : ""}>${esc(location.name)}</option>`).join("")}</select>${lockedLocation && selectedLocation ? `<input type="hidden" name="location_id" value="${esc(selectedLocation)}">` : ""}${quick && !selectedLocation ? "<small>Ask a farm manager to assign your work location.</small>" : ""}</label>
      <label class="farm-field"><span>Date</span><input name="record_date" type="date" required value="${esc(record.record_date || farmToday())}"></label>
      <label class="farm-field"><span>Shift</span><select name="shift" required>${SHIFT_OPTIONS.map(([value, label]) => `<option value="${value}" ${String(record.shift || "Morning").toLowerCase() === value.toLowerCase() ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label class="farm-field"><span>Animal type (optional)</span><select name="animal_type_id"><option value="">Not specified</option>${(core().animalTypes || []).filter((type) => type.active !== false).map((type) => `<option value="${esc(type.id)}" ${String(record.animal_type_id || "") === String(type.id) ? "selected" : ""}>${esc(type.name)}</option>`).join("")}</select></label>
      <label class="farm-field"><span>Eggs collected</span><input name="eggs_collected" type="number" min="0" step="1" required value="${esc(record.eggs_collected ?? "")}"></label>
      <label class="farm-field"><span>Eggs broken</span><input name="eggs_broken" type="number" min="0" step="1" required value="${esc(record.eggs_broken ?? 0)}"></label>
      <div class="farm-operation-preview farm-span-2">Good eggs: <strong data-good-eggs-preview>${Math.max(0, Number(record.eggs_collected || 0) - Number(record.eggs_broken || 0))}</strong></div>
      <label class="farm-field farm-span-2"><span>Notes</span><textarea name="notes" rows="3">${esc(record.notes || "")}</textarea></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="close-modal">Cancel</button><button type="submit" class="farm-btn" ${quick && !selectedLocation ? "disabled" : ""}>Save record</button></div>
    </form>`;
  }

  function attendancePanel() {
    const summary = state.attendanceSummary || {};
    const rows = state.attendanceFilters.status
      ? state.attendance.filter((entry) => entry.status === state.attendanceFilters.status)
      : state.attendance;
    const canEdit = canManageOperations();
    return `<section class="farm-panel">
      <div class="farm-panel-heading farm-panel-heading--actions"><div><p class="farm-overline">TEAM TIME</p><h2>Attendance</h2><p class="farm-panel-copy">Review attendance by date, worker, and status. Face photos are discarded after matching.</p></div><button class="farm-btn" type="button" data-farm-ops-action="new-manual-attendance">＋ Manual entry</button></div>
      <section class="farm-operation-metrics"><article><small>Present</small><strong>${esc(summary.total_present ?? 0)}</strong></article><article><small>Absent</small><strong>${esc(summary.total_absent ?? 0)}</strong></article><article><small>Late</small><strong>${esc(summary.total_late ?? 0)}</strong></article><article><small>Total hours</small><strong>${esc(Number(summary.total_hours || 0).toFixed(1))}</strong></article></section>
      <form class="farm-operation-filters" data-farm-ops-form="attendance-filters">
        <label class="farm-field"><span>From</span><input type="date" name="from" value="${esc(state.attendanceFilters.from)}"></label>
        <label class="farm-field"><span>To</span><input type="date" name="to" value="${esc(state.attendanceFilters.to)}"></label>
        <label class="farm-field"><span>Worker</span><select name="worker_id"><option value="">All workers</option>${workers().map((worker) => `<option value="${esc(worker.id)}" ${String(state.attendanceFilters.worker_id) === String(worker.id) ? "selected" : ""}>${esc(`${worker.first_name || ""} ${worker.last_name || ""}`.trim() || worker.name || "Worker")}</option>`).join("")}</select></label>
        <label class="farm-field"><span>Status</span><select name="status"><option value="">All statuses</option><option value="present" ${state.attendanceFilters.status === "present" ? "selected" : ""}>Present</option><option value="late" ${state.attendanceFilters.status === "late" ? "selected" : ""}>Late</option><option value="absent" ${state.attendanceFilters.status === "absent" ? "selected" : ""}>Absent</option></select></label>
        <button class="farm-btn farm-btn--quiet" type="submit">Apply filters</button>
      </form>
      ${resourceState("attendance", "Loading attendance")}
      ${!state.loading.attendance && !state.errors.attendance ? `<div class="farm-table-wrap"><table class="farm-table farm-operation-table"><thead><tr><th>Date</th><th>Worker</th><th>Location</th><th>Check in</th><th>Check out</th><th>Hours</th><th>Status</th>${canEdit ? "<th>Action</th>" : ""}</tr></thead><tbody>${rows.length ? rows.map((entry) => `<tr><td>${esc(entry.attendance_date)}</td><td>${esc(entry.worker_name || "Worker")}</td><td>${esc(entry.location_name || "—")}</td><td>${esc(displayTime(entry.check_in))}</td><td>${esc(displayTime(entry.check_out))}</td><td>${entry.hours_worked == null ? "—" : esc(Number(entry.hours_worked).toFixed(2))}</td><td><span class="farm-operation-status is-${esc(entry.status)}">${esc(entry.status)}</span></td>${canEdit ? `<td><button class="farm-btn farm-btn--quiet farm-btn--small" type="button" data-farm-ops-action="edit-attendance" data-id="${esc(entry.id)}">Edit</button></td>` : ""}</tr>`).join("") : `<tr><td colspan="${canEdit ? 8 : 7}"><div class="farm-empty-note">No attendance has been recorded for this period.</div></td></tr>`}</tbody></table></div>` : ""}
      ${state.modal?.kind === "attendance" ? modalFrame("Manual attendance", attendanceForm(state.modal.record)) : ""}
    </section>`;
  }

  function attendanceForm(record = {}) {
    const selectedWorker = record.worker_id || "";
    return `<form class="farm-form-grid" data-farm-ops-form="attendance" data-id="${esc(record.id || "")}">
      <label class="farm-field farm-span-2"><span>Worker</span><select name="worker_id" required><option value="">Select worker</option>${workers().map((worker) => `<option value="${esc(worker.id)}" ${String(selectedWorker) === String(worker.id) ? "selected" : ""}>${esc(`${worker.first_name || ""} ${worker.last_name || ""}`.trim() || worker.name || "Worker")}</option>`).join("")}</select></label>
      <label class="farm-field"><span>Date</span><input name="attendance_date" type="date" required value="${esc(record.attendance_date || farmToday())}"></label>
      <label class="farm-field"><span>Status</span><select name="status" required><option value="present" ${record.status === "present" || !record.status ? "selected" : ""}>Present</option><option value="late" ${record.status === "late" ? "selected" : ""}>Late</option><option value="absent" ${record.status === "absent" ? "selected" : ""}>Absent</option></select></label>
      <label class="farm-field"><span>Check in</span><input name="check_in" type="datetime-local" value="${esc(dateTimeLocal(record.check_in))}"></label>
      <label class="farm-field"><span>Check out</span><input name="check_out" type="datetime-local" value="${esc(dateTimeLocal(record.check_out))}"></label>
      <label class="farm-field farm-span-2"><span>Notes</span><textarea name="notes" rows="3">${esc(record.notes || "")}</textarea></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="close-modal">Cancel</button><button type="submit" class="farm-btn">Save attendance</button></div>
    </form>`;
  }

  function healthPanel() {
    return `<section class="farm-panel">
      <div class="farm-panel-heading farm-panel-heading--actions"><div><p class="farm-overline">ANIMAL CARE</p><h2>Health log</h2><p class="farm-panel-copy">Track checkups, vaccinations, illness, treatment, and recovery for each animal.</p></div><button class="farm-btn" type="button" data-farm-ops-action="new-health">＋ Add health log</button></div>
      ${resourceState("health", "Loading health records")}
      ${!state.loading.health && !state.errors.health ? `<div class="farm-table-wrap"><table class="farm-table farm-operation-table"><thead><tr><th>Date</th><th>Animal</th><th>Type</th><th>Description</th><th>Treatment</th><th>Vet</th><th>Next due</th><th>Action</th></tr></thead><tbody>${state.healthLogs.length ? state.healthLogs.map((entry) => `<tr><td>${esc(entry.log_date)}</td><td>${esc(entry.tag_number || entry.animal_name || "Animal")}</td><td><span class="farm-operation-status ${entry.log_type === "illness" ? "is-absent" : entry.log_type === "recovery" ? "is-present" : ""}">${esc(entry.log_type)}</span></td><td>${esc(entry.description || "—")}</td><td>${esc(entry.treatment || "—")}</td><td>${esc(entry.vet_name || "—")}</td><td>${esc(entry.next_due_date || "—")}</td><td><div class="farm-inline-actions"><button class="farm-btn farm-btn--quiet farm-btn--small" type="button" data-farm-ops-action="edit-health" data-id="${esc(entry.id)}">Edit</button>${isAdmin() ? `<button class="farm-btn farm-btn--quiet farm-btn--small is-danger" type="button" data-farm-ops-action="delete-health" data-id="${esc(entry.id)}">Delete</button>` : ""}</div></td></tr>`).join("") : `<tr><td colspan="8"><div class="farm-empty-note">No health logs have been recorded for this farm.</div></td></tr>`}</tbody></table></div>` : ""}
      ${state.modal?.kind === "health" ? modalFrame(state.modal.record?.id ? "Edit animal health log" : "Add animal health log", healthForm(state.modal.record)) : ""}
    </section>`;
  }

  function healthForm(record = {}, animal = null) {
    const options = animal
      ? `<option value="${esc(animal.id)}" selected>${esc(animal.tag_number || animal.name || "Animal")}</option>`
      : animals().map((item) => `<option value="${esc(item.id)}" ${String(item.id) === String(record.animal_id) ? "selected" : ""}>${esc(item.tag_number || item.name || item.type_name || "Animal")}</option>`).join("");
    return `<form class="farm-form-grid" data-farm-ops-form="health" data-id="${esc(record.id || "")}">
      <label class="farm-field farm-span-2"><span>Animal</span><select name="animal_id" required ${animal ? "disabled" : ""}><option value="">Select animal</option>${options}</select>${animal ? `<input type="hidden" name="animal_id" value="${esc(animal.id)}">` : ""}</label>
      <label class="farm-field"><span>Log date</span><input name="log_date" type="date" required value="${esc(record.log_date || farmToday())}"></label>
      <label class="farm-field"><span>Log type</span><select name="log_type" required>${["checkup", "vaccination", "illness", "treatment", "recovery"].map((type) => `<option value="${type}" ${record.log_type === type ? "selected" : ""}>${type[0].toUpperCase()}${type.slice(1)}</option>`).join("")}</select></label>
      <label class="farm-field farm-span-2"><span>Description</span><textarea name="description" rows="2">${esc(record.description || "")}</textarea></label>
      <label class="farm-field"><span>Treatment</span><input name="treatment" value="${esc(record.treatment || "")}"></label>
      <label class="farm-field"><span>Veterinarian</span><input name="vet_name" value="${esc(record.vet_name || "")}"></label>
      <label class="farm-field"><span>Cost</span><input name="cost" type="number" min="0" step="any" value="${esc(record.cost ?? "")}"></label>
      <label class="farm-field"><span>Next due date</span><input name="next_due_date" type="date" value="${esc(record.next_due_date || "")}"></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="close-modal">Cancel</button><button type="submit" class="farm-btn">Save health log</button></div>
    </form>`;
  }

  function workerWorkspace() {
    const worker = state.worker || {};
    const tabs = [
      ["today", "Today"],
      ["attendance", "My attendance"],
      ["eggs", "Record eggs"],
    ];
    if (hasCommercialSales()) tabs.push(["sales", "My sales"]);
    return `<main class="farm-worker-shell">
      <header class="farm-worker-header"><div><p class="farm-overline">FARM TEAM</p><h1>Welcome, ${esc(worker.name || "team member")}</h1><p>${esc(worker.location_name ? `Assigned location: ${worker.location_name}` : "Ask your farm manager to assign your work location.")}</p></div><span class="farm-operation-status">${esc(worker.employee_code || "Farm worker")}</span></header>
      ${resourceState("worker", "Loading your worker profile")}
      <nav class="farm-worker-tabs" aria-label="Farm worker tools">${tabs.map(([tab, label]) => `<button type="button" class="${state.workerTab === tab ? "is-active" : ""}" data-farm-ops-action="worker-tab" data-worker-tab="${tab}">${label}</button>`).join("")}</nav>
      <div class="farm-worker-content">${workerPanel()}</div>
    </main>`;
  }

  function workerPanel() {
    if (state.workerTab === "attendance") return workerAttendancePanel();
    if (state.workerTab === "eggs") return workerEggPanel();
    if (state.workerTab === "sales") return renderCommercialSales();
    return workerTodayPanel();
  }

  function workerTodayPanel() {
    const attendance = state.todayAttendance;
    const checkedIn = Boolean(attendance?.check_in);
    const checkedOut = Boolean(attendance?.check_out);
    const needsEnrollment = !state.worker?.face_enrolled;
    return `<section class="farm-panel farm-worker-today">
      <div class="farm-panel-heading"><div><p class="farm-overline">TODAY · ${esc(farmToday())}</p><h2>Your shift</h2><p class="farm-panel-copy">Check in with the camera assigned to this account, or ask a manager to add attendance manually.</p></div></div>
      ${resourceState("workerAttendance", "Loading your attendance")}
      <div class="farm-worker-shift-card"><div><small>Attendance status</small><strong>${checkedOut ? "Shift complete" : checkedIn ? "Checked in" : "Not checked in"}</strong></div><div><small>Check in</small><strong>${esc(displayTime(attendance?.check_in))}</strong></div><div><small>Check out</small><strong>${esc(displayTime(attendance?.check_out))}</strong></div></div>
      ${renderCommercialActions()}
      ${needsEnrollment ? `<div class="farm-inline-note">Face check-in is not enrolled for your account. Ask a farm administrator to enroll you.</div>` : ""}
      <div class="farm-face-card">
        <div class="farm-face-copy"><span class="farm-face-icon" aria-hidden="true">◎</span><div><h3>Face check-in</h3><p>Your camera image is converted to a short hash for matching and is not saved.</p></div></div>
        ${state.cameraError ? `<div class="farm-inline-error">${esc(state.cameraError)}</div>` : ""}
        <video id="farmFaceVideo" class="farm-face-video" autoplay playsinline muted ${state.cameraStream ? "" : "hidden"}></video>
        <div class="farm-face-actions">${state.cameraStream
          ? `<button type="button" class="farm-btn" data-farm-ops-action="capture-check-in" ${needsEnrollment || checkedIn || checkedOut ? "disabled" : ""}>Capture and check in</button><button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="close-camera">Close camera</button>`
          : `<button type="button" class="farm-btn" data-farm-ops-action="open-camera" ${needsEnrollment || checkedIn || checkedOut ? "disabled" : ""}>Open camera</button>`}
          ${checkedIn && !checkedOut ? `<button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="worker-check-out">Check out</button>` : ""}
        </div>
        <small class="farm-face-privacy">Face matching uses an approximate image hash and is not a secure identity check. Manual attendance remains available to farm managers.</small>
      </div>
      ${state.modal?.kind === "egg" ? modalFrame("Record eggs", eggForm(state.modal.record, true)) : ""}
    </section>`;
  }

  function workerAttendancePanel() {
    const summary = state.workerAttendanceSummary || {};
    const entries = Array.isArray(state.workerAttendance) ? state.workerAttendance : [];
    return `<section class="farm-panel">
      <div class="farm-panel-heading"><div><p class="farm-overline">PERSONAL RECORD</p><h2>My attendance</h2><p class="farm-panel-copy">Your attendance records for the current month.</p></div></div>
      <section class="farm-operation-metrics"><article><small>Present days</small><strong>${esc(summary.total_present ?? 0)}</strong></article><article><small>Absent days</small><strong>${esc(summary.total_absent ?? 0)}</strong></article><article><small>Late days</small><strong>${esc(summary.total_late ?? 0)}</strong></article><article><small>Hours</small><strong>${esc(Number(summary.total_hours || 0).toFixed(1))}</strong></article></section>
      ${resourceState("workerAttendance", "Loading attendance")}
      ${!state.loading.workerAttendance && !state.errors.workerAttendance ? `<div class="farm-table-wrap"><table class="farm-table farm-operation-table"><thead><tr><th>Date</th><th>Check in</th><th>Check out</th><th>Hours</th><th>Status</th></tr></thead><tbody>${entries.length ? entries.map((entry) => `<tr><td>${esc(entry.attendance_date)}</td><td>${esc(displayTime(entry.check_in))}</td><td>${esc(displayTime(entry.check_out))}</td><td>${entry.hours_worked == null ? "—" : esc(Number(entry.hours_worked).toFixed(2))}</td><td><span class="farm-operation-status is-${esc(entry.status)}">${esc(entry.status)}</span></td></tr>`).join("") : `<tr><td colspan="5"><div class="farm-empty-note">No attendance records yet.</div></td></tr>`}</tbody></table></div>` : ""}
    </section>`;
  }

  function workerEggPanel() {
    const location = state.worker?.location_name || "Not assigned";
    return `<section class="farm-panel farm-worker-eggs">
      <div class="farm-panel-heading"><div><p class="farm-overline">POULTRY COLLECTION</p><h2>Record eggs</h2><p class="farm-panel-copy">Your collection is recorded at ${esc(location)}. Good eggs are calculated automatically.</p></div></div>
      ${state.errors.eggs ? `<div class="farm-inline-error">${esc(state.errors.eggs)}</div>` : ""}
      ${!state.worker?.location_id ? `<div class="farm-inline-note">Ask your farm manager to assign a work location before recording eggs.</div>` : eggForm({}, true)}
    </section>`;
  }

  function movementForm(animal) {
    const assigned = animal?.location_id || "";
    const quantity = Math.max(1, Number(animal?.quantity || 1));
    return `<form class="farm-form-grid" data-farm-ops-form="movement" data-animal-id="${esc(animal?.id || "")}">
      <input type="hidden" name="animal_id" value="${esc(animal?.id || "")}">
      <label class="farm-field"><span>Direction</span><select name="direction" required><option value="transfer">Transfer</option><option value="in">In</option><option value="out">Out</option></select></label>
      <label class="farm-field"><span>Movement date and time</span><input type="datetime-local" name="moved_at" value="${esc(dateTimeLocal(new Date().toISOString()))}" required></label>
      <label class="farm-field" data-movement-from-group><span>From location</span><select name="from_location_id"><option value="">Outside this farm</option>${locations().map((location) => `<option value="${esc(location.id)}" ${String(location.id) === String(assigned) ? "selected" : ""}>${esc(location.name)}</option>`).join("")}</select></label>
      <label class="farm-field" data-movement-to-group><span>To location</span><select name="to_location_id"><option value="">Outside this farm</option>${locations().map((location) => `<option value="${esc(location.id)}" ${String(location.id) === String(assigned) ? "" : ""}>${esc(location.name)}</option>`).join("")}</select></label>
      <label class="farm-field"><span>Quantity</span><input name="count" type="number" min="1" step="1" value="${quantity}" readonly><small>Movements apply to the full animal record quantity.</small></label>
      <label class="farm-field"><span>Reason</span><input name="reason" maxlength="300"></label>
      <label class="farm-field farm-span-2"><span>Notes</span><textarea name="notes" rows="3"></textarea></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="close-modal">Cancel</button><button type="submit" class="farm-btn">Save movement</button></div>
    </form>`;
  }

  function animalMovementMarkup() {
    const entries = state.movements || [];
    return `${resourceState("detail", "Loading movement history")}
      ${!state.loading.detail && !state.errors.detail ? entries.length
        ? `<div class="farm-operation-timeline">${entries.map((entry) => `<article class="farm-operation-event"><span class="farm-operation-event-mark"></span><div class="farm-operation-event-main"><div><strong>${esc(entry.direction)} · ${esc(entry.movement_type)}</strong><small>${esc(displayTime(entry.moved_at))}</small></div><p>${esc(entry.from_location_name || "Outside farm")} → ${esc(entry.to_location_name || "Outside farm")}</p><small>${esc(entry.reason || "No reason supplied")} · Quantity ${esc(entry.count)}</small>${entry.notes ? `<p>${esc(entry.notes)}</p>` : ""}</div>${isAdmin() ? `<button class="farm-icon-btn" type="button" aria-label="Delete movement" data-farm-ops-action="delete-movement" data-id="${esc(entry.id)}">×</button>` : ""}</article>`).join("")}</div>`
        : `<div class="farm-empty-note">No movements recorded for this animal.</div>` : ""}
      ${canManageOperations() ? `<button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="new-movement">＋ Record movement</button>` : ""}`;
  }

  function animalHealthMarkup() {
    const entries = state.detailHealth || [];
    return `${resourceState("detail", "Loading health history")}
      ${!state.loading.detail && !state.errors.detail ? entries.length
        ? `<div class="farm-operation-timeline">${entries.map((entry) => `<article class="farm-operation-event"><span class="farm-operation-event-mark"></span><div class="farm-operation-event-main"><div><strong>${esc(entry.log_type)}</strong><small>${esc(entry.log_date)}</small></div><p>${esc(entry.description || "No description")}</p>${entry.treatment ? `<small>Treatment: ${esc(entry.treatment)}</small>` : ""}${entry.next_due_date ? `<small>Next due: ${esc(entry.next_due_date)}</small>` : ""}</div><div class="farm-inline-actions">${canManageOperations() ? `<button type="button" class="farm-btn farm-btn--quiet farm-btn--small" data-farm-ops-action="edit-health" data-id="${esc(entry.id)}">Edit</button>` : ""}${isAdmin() ? `<button type="button" class="farm-btn farm-btn--quiet farm-btn--small is-danger" data-farm-ops-action="delete-health" data-id="${esc(entry.id)}">Delete</button>` : ""}</div></article>`).join("")}</div>`
        : `<div class="farm-empty-note">No health logs recorded for this animal.</div>` : ""}
      ${canManageOperations() ? `<button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="new-animal-health">＋ Add health log</button>` : ""}`;
  }

  function animalEggMarkup() {
    const entries = state.detailEggs || [];
    return `<p class="farm-panel-copy">Egg collection records for this animal type at ${esc(state.activeAnimal?.location_name || "its current location")}.</p>
      ${resourceState("detail", "Loading egg records")}
      ${!state.loading.detail && !state.errors.detail ? entries.length
        ? `<div class="farm-table-wrap"><table class="farm-table farm-operation-table"><thead><tr><th>Date</th><th>Shift</th><th>Collected</th><th>Good</th><th>Broken</th></tr></thead><tbody>${entries.map((entry) => `<tr><td>${esc(entry.record_date)}</td><td>${esc(entry.shift)}</td><td>${esc(entry.eggs_collected)}</td><td>${esc(entry.eggs_good)}</td><td>${esc(entry.eggs_broken)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="farm-empty-note">No egg records are available for this location and animal type.</div>` : ""}
      ${canManageOperations() ? `<button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="record-animal-eggs">＋ Record eggs</button>` : ""}`;
  }

  function renderAnimalTools(animal) {
    const poultry = isPoultry(animal);
    const tabs = [["movements", "Movements"], ["health", "Health"]];
    if (poultry) tabs.push(["eggs", "Egg records"]);
    const content = state.animalDetailTab === "health"
      ? animalHealthMarkup()
      : state.animalDetailTab === "eggs" && poultry
        ? animalEggMarkup()
        : animalMovementMarkup();
    return `<section class="farm-animal-operations">
      <nav class="farm-operation-tabs" aria-label="Animal operation history">${tabs.map(([tab, label]) => `<button type="button" class="${state.animalDetailTab === tab ? "is-active" : ""}" data-farm-ops-action="animal-detail-tab" data-animal-tab="${tab}">${label}</button>`).join("")}</nav>
      <div class="farm-animal-operation-content">${content}</div>
      ${state.modal?.kind === "movement" ? modalFrame("Record animal movement", movementForm(animal)) : ""}
      ${state.modal?.kind === "health" ? modalFrame("Add animal health log", healthForm(state.modal.record, animal)) : ""}
      ${state.modal?.kind === "egg" ? modalFrame("Record eggs", eggForm(state.modal.record || { location_id: animal.location_id }, false)) : ""}
    </section>`;
  }

  function render(tab) {
    if (tab === "eggs") return eggsPanel();
    if (tab === "attendance") return attendancePanel();
    if (tab === "health") return healthPanel();
    return `<section class="farm-empty-note">Select an operations area.</section>`;
  }

  function afterRender() {
    const video = document.getElementById("farmFaceVideo");
    if (video && state.cameraStream && video.srcObject !== state.cameraStream) {
      video.srcObject = state.cameraStream;
      video.play?.().catch(() => {});
    }
  }

  function stopCamera() {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }
    state.cameraError = "";
  }

  async function selectAnimal(animal) {
    state.activeAnimal = animal || null;
    state.animalDetailTab = "movements";
    if (animal?.id) await loadAnimalMovements(animal.id);
    else rerender();
  }

  async function openCamera() {
    state.cameraError = "";
    if (!navigator.mediaDevices?.getUserMedia) {
      state.cameraError = "This browser does not allow camera access.";
      rerender();
      return;
    }
    try {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      rerender();
      afterRender();
    } catch (error) {
      state.cameraError = error?.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access or ask a manager to record attendance."
        : "The camera could not be opened on this device.";
      rerender();
    }
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not process the face image.")), "image/jpeg", quality);
    });
  }

  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read the compressed face image."));
      reader.readAsDataURL(blob);
    });
  }

  async function imageFileToJpeg(file) {
    if (!file || !IMAGE_TYPES.has(file.type)) {
      throw new Error("Choose a JPEG, PNG, or WebP face photo.");
    }
    if (file.size > PHOTO_LIMIT) throw new Error("Face photos must be 200 KB or smaller.");
    const bitmap = await createImageBitmap(file);
    try {
      let scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
      while (scale >= 0.2) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Image processing is unavailable in this browser.");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.86, 0.72, 0.58, 0.44]) {
          const blob = await canvasBlob(canvas, quality);
          if (blob.size <= PHOTO_LIMIT) return await blobDataUrl(blob);
        }
        scale *= 0.8;
      }
    } finally {
      bitmap.close?.();
    }
    throw new Error("This photo could not be compressed below 200 KB.");
  }

  async function captureVideoJpeg(video) {
    if (!video?.videoWidth || !video?.videoHeight) {
      throw new Error("The camera is not ready. Wait a moment, then try again.");
    }
    let scale = Math.min(1, 900 / Math.max(video.videoWidth, video.videoHeight));
    while (scale >= 0.2) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Image processing is unavailable in this browser.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.68, 0.54, 0.4]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= PHOTO_LIMIT) return await blobDataUrl(blob);
      }
      scale *= 0.8;
    }
    throw new Error("This camera image could not be compressed below 200 KB.");
  }

  async function enrollFace(workerId) {
    const input = document.querySelector("#farmFaceEnrollmentFile");
    const file = input?.files?.[0];
    if (!file) throw new Error("Choose a face photo to enroll.");
    const photo = await imageFileToJpeg(file);
    await request("/api/farm/attendance/enroll-face", {
      method: "POST",
      body: { worker_id: workerId, face_photo_base64: photo },
    });
    announce("Face hash enrolled. The photo was discarded.");
    state.modal = null;
    await request("/api/farm/workers").then((payload) => {
      const nextWorkers = Array.isArray(payload?.workers) ? payload.workers : [];
      if (Array.isArray(core().workers)) core().workers.splice(0, core().workers.length, ...nextWorkers);
    }).catch(() => {});
    rerender();
  }

  function enrollFaceModal(workerId) {
    const worker = workers().find((item) => String(item.id) === String(workerId));
    const workerName = worker ? `${worker.first_name || ""} ${worker.last_name || ""}`.trim() : "Worker";
    return modalFrame("Enroll worker face", `<form class="farm-form-grid" data-farm-ops-form="enroll-face" data-worker-id="${esc(workerId)}">
      <p class="farm-span-2 farm-panel-copy">Capture or choose a clear face photo for ${esc(workerName)}. The image must be 200 KB or smaller. It is converted into a hash and never saved.</p>
      <label class="farm-field farm-span-2"><span>Face photo (JPEG, PNG, or WebP)</span><input id="farmFaceEnrollmentFile" type="file" name="face_photo" accept="image/jpeg,image/png,image/webp" capture="user" required><small>Use a single, well-lit face. Photos are discarded after conversion.</small></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-ops-action="close-modal">Cancel</button><button type="submit" class="farm-btn">Create face hash</button></div>
    </form>`);
  }

  async function submitMovement(form) {
    const fields = new FormData(form);
    const direction = String(fields.get("direction") || "transfer");
    const from = String(fields.get("from_location_id") || "");
    const to = String(fields.get("to_location_id") || "");
    const body = {
      animal_id: String(fields.get("animal_id") || form.dataset.animalId || ""),
      direction,
      movement_type: direction === "in" ? "arrival" : direction === "out" ? "departure" : "transfer",
      from_location_id: direction === "in" ? null : from || null,
      to_location_id: to || null,
      count: Number(fields.get("count") || 1),
      moved_at: datetimeIso(String(fields.get("moved_at") || "")),
      reason: String(fields.get("reason") || "").trim() || null,
      notes: String(fields.get("notes") || "").trim() || null,
    };
    await request("/api/farm/movements", { method: "POST", body });
    state.modal = null;
    announce("Animal movement recorded.");
    await Promise.all([
      request(`/api/farm/animals/${encodeURIComponent(body.animal_id)}`).then((payload) => {
        if (payload?.animal) state.activeAnimal = payload.animal;
      }).catch(() => {}),
      loadAnimalMovements(body.animal_id),
    ]);
  }

  async function submitForm(form) {
    const type = form.dataset.farmOpsForm;
    if (type === "egg-filters") {
      const fields = new FormData(form);
      state.eggFilters = {
        from: String(fields.get("from") || ""),
        to: String(fields.get("to") || ""),
        location_id: String(fields.get("location_id") || ""),
      };
      await loadEggData();
      return;
    }
    if (type === "attendance-filters") {
      const fields = new FormData(form);
      state.attendanceFilters = {
        ...state.attendanceFilters,
        from: String(fields.get("from") || ""),
        to: String(fields.get("to") || ""),
        worker_id: String(fields.get("worker_id") || ""),
        status: String(fields.get("status") || ""),
      };
      await loadAttendanceData();
      return;
    }
    try {
      const fields = new FormData(form);
      if (type === "egg") {
        const id = form.dataset.id || "";
        const body = {
          location_id: String(fields.get("location_id") || ""),
          animal_type_id: String(fields.get("animal_type_id") || "") || null,
          record_date: String(fields.get("record_date") || ""),
          shift: String(fields.get("shift") || ""),
          eggs_collected: Number(fields.get("eggs_collected") || 0),
          eggs_broken: Number(fields.get("eggs_broken") || 0),
          notes: String(fields.get("notes") || "").trim() || null,
        };
        await request(id ? `/api/farm/eggs/${encodeURIComponent(id)}` : "/api/farm/eggs", {
          method: id ? "PATCH" : "POST",
          body,
        });
        state.modal = null;
        announce(id ? "Egg record updated." : "Egg record saved.");
        await loadEggData();
      } else if (type === "attendance") {
        const id = form.dataset.id || "";
        const body = {
          worker_id: String(fields.get("worker_id") || ""),
          attendance_date: String(fields.get("attendance_date") || ""),
          status: String(fields.get("status") || ""),
          check_in: datetimeIso(String(fields.get("check_in") || "")),
          check_out: datetimeIso(String(fields.get("check_out") || "")),
          notes: String(fields.get("notes") || "").trim() || null,
        };
        await request(
          id ? `/api/farm/attendance/${encodeURIComponent(id)}` : "/api/farm/attendance/manual",
          { method: id ? "PATCH" : "POST", body },
        );
        state.modal = null;
        announce(id ? "Attendance updated." : "Manual attendance saved.");
        await loadAttendanceData();
      } else if (type === "health") {
        const body = {
          animal_id: String(fields.get("animal_id") || ""),
          log_date: String(fields.get("log_date") || ""),
          log_type: String(fields.get("log_type") || ""),
          description: String(fields.get("description") || "").trim() || null,
          treatment: String(fields.get("treatment") || "").trim() || null,
          vet_name: String(fields.get("vet_name") || "").trim() || null,
          cost: String(fields.get("cost") || "") === "" ? null : Number(fields.get("cost")),
          next_due_date: String(fields.get("next_due_date") || "") || null,
        };
        const id = form.dataset.id || "";
        await request(id ? `/api/farm/health/${encodeURIComponent(id)}` : "/api/farm/health", {
          method: id ? "PATCH" : "POST",
          body,
        });
        state.modal = null;
        announce(id ? "Health log updated." : "Health log saved.");
        if (state.activeAnimal?.id) await loadAnimalMovements(state.activeAnimal.id);
        await loadHealthData();
      } else if (type === "movement") {
        await submitMovement(form);
      } else if (type === "enroll-face") {
        await enrollFace(form.dataset.workerId);
      }
    } catch (error) {
      announce(error?.message || "Could not save this farm record.", "error");
    }
  }

  async function performAction(action, button) {
    const id = button.dataset.id || "";
    if (action === "new-egg") {
      state.modal = { kind: "egg", record: {} };
      rerender();
    } else if (action === "edit-egg") {
      state.modal = { kind: "egg", record: state.eggs.find((egg) => String(egg.id) === id) || {} };
      rerender();
    } else if (action === "delete-egg") {
      if (confirm("Delete this egg record? This cannot be undone.")) {
        await request(`/api/farm/eggs/${encodeURIComponent(id)}`, { method: "DELETE" });
        announce("Egg record deleted.");
        await loadEggData();
      }
    } else if (action === "new-manual-attendance") {
      state.modal = { kind: "attendance", record: {} };
      rerender();
    } else if (action === "edit-attendance") {
      state.modal = { kind: "attendance", record: state.attendance.find((item) => String(item.id) === id) || {} };
      rerender();
    } else if (action === "new-health" || action === "new-animal-health") {
      state.modal = { kind: "health", record: {} };
      rerender();
    } else if (action === "edit-health") {
      const record = state.healthLogs.find((item) => String(item.id) === id) ||
        state.detailHealth.find((item) => String(item.id) === id) || {};
      state.modal = { kind: "health", record };
      rerender();
    } else if (action === "delete-health") {
      if (confirm("Delete this health log? The animal health status will be recalculated.")) {
        await request(`/api/farm/health/${encodeURIComponent(id)}`, { method: "DELETE" });
        announce("Health log deleted.");
        if (state.activeAnimal?.id) await loadAnimalMovements(state.activeAnimal.id);
        await loadHealthData();
      }
    } else if (action === "new-movement") {
      state.modal = { kind: "movement" };
      rerender();
    } else if (action === "delete-movement") {
      if (confirm("Delete this movement record? The animal’s current location will not be changed.")) {
        await request(`/api/farm/movements/${encodeURIComponent(id)}`, { method: "DELETE" });
        announce("Movement record deleted.");
        if (state.activeAnimal?.id) await loadAnimalMovements(state.activeAnimal.id);
      }
    } else if (action === "record-animal-eggs") {
      state.modal = {
        kind: "egg",
        record: {
          location_id: state.activeAnimal?.location_id || "",
          animal_type_id: state.activeAnimal?.animal_type_id || "",
        },
      };
      rerender();
    } else if (action === "worker-tab") {
      state.workerTab = button.dataset.workerTab || "today";
      if (state.workerTab === "sales") onCommercialSalesTab();
      rerender();
    } else if (action === "open-camera") {
      await openCamera();
    } else if (action === "close-camera") {
      stopCamera();
      rerender();
    } else if (action === "capture-check-in") {
      const video = document.getElementById("farmFaceVideo");
      try {
        const facePhoto = await captureVideoJpeg(video);
        await request("/api/farm/attendance/check-in", {
          method: "POST",
          body: { face_photo_base64: facePhoto },
        });
        announce("You are checked in. Your face photo was discarded.");
        stopCamera();
        await loadWorkerAttendance();
      } catch (error) {
        announce(error?.message || "Face check-in failed.", "error");
      }
    } else if (action === "worker-check-out") {
      try {
        await request("/api/farm/attendance/check-out", { method: "POST", body: {} });
        announce("You are checked out.");
        await loadWorkerAttendance();
      } catch (error) {
        announce(error?.message || "Check-out failed.", "error");
      }
    } else if (action === "animal-detail-tab") {
      state.animalDetailTab = button.dataset.animalTab || "movements";
      if (state.activeAnimal?.id) await loadAnimalMovements(state.activeAnimal.id);
      else rerender();
    } else if (action === "retry") {
      const resource = button.dataset.resource;
      if (resource === "eggs") await loadEggData();
      else if (resource === "attendance") await loadAttendanceData();
      else if (resource === "health") await loadHealthData();
      else if (resource === "worker" && state.user) await setUser(state.user);
      else if (resource === "workerAttendance") await loadWorkerAttendance();
      else if (resource === "detail" && state.activeAnimal?.id) await loadAnimalMovements(state.activeAnimal.id);
    } else if (action === "enroll-face") {
      state.modal = { kind: "face-enrollment", workerId: id };
      rerender();
    }
  }

  async function handleClick(button, clickEvent) {
    const action = button?.dataset?.farmOpsAction;
    if (!action) return false;
    if (action === "dismiss-modal" && clickEvent?.target !== button) return true;
    if (action === "close-modal" || action === "dismiss-modal") {
      state.modal = null;
      rerender();
      return true;
    }
    try {
      if (action === "animal-detail-tab") {
        state.animalDetailTab = button.dataset.animalTab || "movements";
        if (state.activeAnimal?.id) await loadAnimalMovements(state.activeAnimal.id);
      } else if (action === "new-movement" && !state.activeAnimal) {
        return true;
      } else {
        await performAction(action, button);
      }
    } catch (error) {
      announce(error?.message || "Could not complete this action.", "error");
    }
    return true;
  }

  function handleChange(target) {
    if (target?.name === "direction" && target.form?.dataset?.farmOpsForm === "movement") {
      const from = target.form.querySelector("[data-movement-from-group]");
      const to = target.form.querySelector("[data-movement-to-group]");
      if (from) from.hidden = target.value !== "transfer";
      if (to) to.hidden = false;
    }
    if (target?.name === "status" && target.form?.dataset?.farmOpsForm === "attendance") {
      const absent = target.value === "absent";
      target.form.querySelectorAll('[name="check_in"],[name="check_out"]').forEach((input) => {
        input.disabled = absent;
        if (absent) input.value = "";
      });
    }
  }

  function handleInput(target) {
    if (target?.form?.dataset?.farmOpsForm !== "egg") return;
    const fields = new FormData(target.form);
    const good = Math.max(0, Number(fields.get("eggs_collected") || 0) - Number(fields.get("eggs_broken") || 0));
    const preview = target.form.querySelector("[data-good-eggs-preview]");
    if (preview) preview.textContent = String(good);
  }

  function workerActionMarkup(worker) {
    if (!isAdmin()) return "";
    const enrolled = Boolean(worker?.face_enrolled);
    return `<button type="button" class="farm-btn farm-btn--quiet farm-btn--small" data-farm-ops-action="enroll-face" data-id="${esc(worker?.id)}">${enrolled ? "Update face" : "Enroll face"}</button>`;
  }

  function modalMarkup() {
    if (state.modal?.kind === "face-enrollment") return enrollFaceModal(state.modal.workerId);
    return "";
  }

  return {
    setUser,
    loadTab: async (tab) => {
      if (tab === "eggs") await loadEggData();
      else if (tab === "attendance") await loadAttendanceData();
      else if (tab === "health") await loadHealthData();
    },
    render,
    renderWorkerWorkspace: workerWorkspace,
    renderAnimalTools,
    selectAnimal,
    workerActionMarkup,
    handleClick,
    handleSubmit: submitForm,
    handleChange,
    handleInput,
    afterRender,
    stopCamera,
    modalMarkup,
    getState: () => state,
  };
}
