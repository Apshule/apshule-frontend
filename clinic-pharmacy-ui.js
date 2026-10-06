export function initClinicPharmacyUI({
  api,
  getCurrentUser,
  escapeHtml,
  notify,
  renderShell,
  getCurrentTab,
  navigateToPrescriptions,
  onVisitPrescriptionChange,
}) {
  const portalHost = document.getElementById("clinicPortalPage");
  const state = {
    activeTab: "",
    loading: false,
    saving: false,
    error: "",
    modalError: "",
    modal: null,
    medicines: [],
    medicineStats: {},
    medicineSearch: "",
    medicineCategory: "",
    lowStockOnly: false,
    selectedMedicine: null,
    movements: [],
    prescriptions: [],
    pendingPrescriptions: [],
    recentDispenses: [],
    prescriptionStats: {},
    prescriptionFilters: { status: "", patient_id: "", doctor_id: "", date: "" },
    patientFilterLabel: "",
    selectedPrescription: null,
    doctors: [],
    visits: [],
    doctorStats: null,
    doctorStatsError: "",
    visitPrescriptions: new Map(),
    patientPrescriptions: new Map(),
    patientSearchResults: [],
    medicineSearchResults: [],
    patientSearchTimer: null,
    medicineSearchTimer: null,
    patientSearchSequence: 0,
    medicineSearchSequence: 0,
  };

  const esc = (value) => typeof escapeHtml === "function"
    ? escapeHtml(value == null ? "" : String(value))
    : String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  const user = () => typeof getCurrentUser === "function" ? getCurrentUser() : null;
  const role = () => String(user()?.role || "").toLowerCase();
  const isAdmin = () => role() === "clinic_admin";
  const isDoctor = () => role() === "doctor";
  const isPharmacist = () => role() === "pharmacist";
  const canManageInventory = () => isAdmin() || isPharmacist();
  const canReadPrescriptions = () => isAdmin() || isDoctor() || isPharmacist();
  const mayCreatePrescription = () => isAdmin() || isDoctor();
  const text = (record, key, fallback = "—") =>
    esc(record?.[key] == null || record[key] === "" ? fallback : record[key]);
  const nameOfPatient = (patient) =>
    `${patient?.first_name || ""} ${patient?.last_name || ""}`.trim() || "Patient";
  const price = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? `UGX ${parsed.toLocaleString("en-UG")}` : "—";
  };
  const dateLabel = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat("en-UG", { dateStyle: "medium", timeZone: "Africa/Kampala" }).format(date);
  };
  const clinicToday = () => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const queryString = (values) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values || {})) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    return params.toString();
  };
  const notifyUser = (message, type = "success") => {
    if (typeof notify === "function") notify(message, type);
  };
  const request = async (path, options) => {
    if (typeof api !== "function") throw new Error("The authenticated API helper is unavailable.");
    return options ? api(path, options) : api(path);
  };
  const clinicError = (error) => {
    if (error?.status === 401) return "Your session has expired. Sign in again to continue.";
    if (error?.status === 403) return "You do not have permission to access this clinic information.";
    return error?.message || "Something went wrong. Please try again.";
  };
  const rerender = () => {
    if (typeof renderShell === "function") renderShell();
  };
  const setModal = (modal) => {
    state.modal = modal;
    state.modalError = "";
    rerender();
  };
  const formValues = (form) => Object.fromEntries(new FormData(form).entries());

  function field(label, name, value = "", type = "text", options = "") {
    return `<label class="clinic-field"><span>${esc(label)}</span><input class="clinic-control" type="${esc(type)}" name="${esc(name)}" value="${esc(value ?? "")}" ${options}></label>`;
  }

  function area(label, name, value = "", options = "") {
    return `<label class="clinic-field clinic-span-2"><span>${esc(label)}</span><textarea class="clinic-control" name="${esc(name)}" ${options}>${esc(value ?? "")}</textarea></label>`;
  }

  function select(label, name, value, options, extra = "") {
    return `<label class="clinic-field"><span>${esc(label)}</span><select class="clinic-control" name="${esc(name)}" ${extra}>${options.map((option) =>
      `<option value="${esc(option.value)}" ${String(value ?? "") === String(option.value) ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select></label>`;
  }

  function stateNote(title, description, failed = false) {
    return `<div class="clinic-state ${failed ? "clinic-error" : ""}"><div class="clinic-state-mark" aria-hidden="true">${failed ? "!" : "CL"}</div><strong>${esc(title)}</strong><p>${esc(description)}</p></div>`;
  }

  function metrics(items) {
    return `<section class="clinic-metrics clinic-pharmacy-metrics">${items.map(([label, value]) =>
      `<article class="clinic-metric"><span>${esc(label)}</span><strong>${esc(value ?? 0)}</strong></article>`).join("")}</section>`;
  }

  function statusBadge(status) {
    const label = String(status || "pending").replaceAll("_", " ");
    return `<span class="clinic-status clinic-status--${esc(String(status || "").toLowerCase())}">${esc(label)}</span>`;
  }

  function medicineQuery() {
    return queryString({
      search: state.medicineSearch,
      category: state.medicineCategory,
      low_stock: state.lowStockOnly ? "true" : "",
      limit: 200,
    });
  }

  async function fetchMedicines() {
    const query = medicineQuery();
    const payload = await request(`/api/clinic/medicines${query ? `?${query}` : ""}`);
    state.medicines = Array.isArray(payload.medicines) ? payload.medicines : [];
  }

  async function loadTab(tab) {
    if (!["pharmacy", "prescriptions"].includes(tab)) return;
    if (state.activeTab !== tab) {
      state.selectedMedicine = null;
      state.movements = [];
      state.selectedPrescription = null;
    }
    state.activeTab = tab;
    state.loading = true;
    state.error = "";
    rerender();
    try {
      if (tab === "pharmacy") {
        await fetchMedicines();
        if (canManageInventory()) {
          const [statsPayload, pendingPayload, recentPayload] = await Promise.all([
            request("/api/clinic/pharmacy/stats"),
            request("/api/clinic/prescriptions?status=pending&limit=8"),
            request(`/api/clinic/prescriptions?${queryString({
              status: "dispensed",
              date: clinicToday(),
              limit: 8,
            })}`),
          ]);
          state.medicineStats = statsPayload.stats || {};
          state.pendingPrescriptions = Array.isArray(pendingPayload.prescriptions)
            ? pendingPayload.prescriptions : [];
          state.recentDispenses = Array.isArray(recentPayload.prescriptions)
            ? recentPayload.prescriptions : [];
        } else {
          state.medicineStats = {};
          state.pendingPrescriptions = [];
          state.recentDispenses = [];
        }
      } else {
        const params = {
          ...state.prescriptionFilters,
          limit: 200,
        };
        const [listPayload, statsPayload, medicinePayload] = await Promise.all([
          request(`/api/clinic/prescriptions?${queryString(params)}`),
          request("/api/clinic/prescriptions/stats"),
          request("/api/clinic/medicines?limit=250"),
        ]);
        state.prescriptions = Array.isArray(listPayload.prescriptions)
          ? listPayload.prescriptions : [];
        state.prescriptionStats = statsPayload.stats || {};
        state.medicines = Array.isArray(medicinePayload.medicines)
          ? medicinePayload.medicines : [];
        if (isAdmin() || isPharmacist()) {
          const doctorsPayload = await request("/api/clinic/doctors").catch(() => ({ doctors: [] }));
          state.doctors = Array.isArray(doctorsPayload.doctors) ? doctorsPayload.doctors : [];
        } else {
          state.doctors = [];
        }
        if (mayCreatePrescription()) {
          const visitQuery = isDoctor() ? { doctor_id: user()?.id, limit: 50 } : { limit: 50 };
          const visitsPayload = await request(`/api/clinic/visits?${queryString(visitQuery)}`);
          state.visits = Array.isArray(visitsPayload.visits) ? visitsPayload.visits : [];
        } else {
          state.visits = [];
        }
      }
    } catch (error) {
      state.error = clinicError(error);
    } finally {
      state.loading = false;
      rerender();
    }
  }

  async function loadDoctorStats() {
    if (!isDoctor()) return;
    state.doctorStatsError = "";
    try {
      const payload = await request("/api/clinic/prescriptions/stats");
      state.doctorStats = payload.stats || {};
    } catch (error) {
      state.doctorStatsError = clinicError(error);
    }
  }

  function renderDoctorDashboardCard() {
    if (!isDoctor()) return "";
    return `<section class="clinic-panel clinic-prescription-summary"><div class="clinic-section-head"><div><p class="clinic-eyebrow">Prescriptions</p><h2>Pending prescriptions I wrote</h2><p>${state.doctorStatsError ? esc(state.doctorStatsError) : `${esc(state.doctorStats?.pending ?? 0)} waiting to be dispensed.`}</p></div><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-tab="prescriptions">Open prescriptions</button></div></section>`;
  }

  function renderTab(tab) {
    if (state.loading) {
      return `<section class="clinic-panel"><div class="clinic-skeleton" aria-label="Loading"><span></span><span></span><span></span><span></span></div></section>`;
    }
    if (state.error) {
      return `<section class="clinic-panel">${stateNote("This view could not be loaded", state.error, true)}<div class="clinic-actions"><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="retry">Try again</button></div></section>`;
    }
    if (tab === "pharmacy") {
      if (state.selectedPrescription) return renderPrescriptionDetail();
      return state.selectedMedicine ? renderMedicineDetail() : renderPharmacy();
    }
    return state.selectedPrescription ? renderPrescriptionDetail() : renderPrescriptions();
  }

  function renderPharmacy() {
    const stats = state.medicineStats || {};
    const filteredMedicines = state.medicines;
    const rows = filteredMedicines.length ? filteredMedicines.map((medicine) => {
      const low = Number(medicine.current_stock) <= Number(medicine.reorder_level);
      return `<tr>
        <td class="clinic-primary-cell"><strong>${text(medicine, "name")}</strong><span>${text(medicine, "code")}${medicine.generic_name ? ` · ${text(medicine, "generic_name")}` : ""}</span></td>
        <td>${text(medicine, "category")}</td><td>${text(medicine, "form")}${medicine.strength ? ` · ${text(medicine, "strength")}` : ""}</td>
        <td><strong>${esc(medicine.current_stock ?? 0)} ${text(medicine, "unit", "")}</strong>${low ? `<span class="clinic-pharmacy-warning">${Number(medicine.current_stock) === 0 ? "Out of stock" : "Low stock"}</span>` : ""}</td>
        <td>${esc(medicine.reorder_level ?? 0)}</td><td>${price(medicine.cost_price)}</td>
        <td><button type="button" class="clinic-btn clinic-btn--quiet clinic-btn--small" data-pharmacy-action="medicine-open" data-id="${esc(medicine.id)}">View</button></td>
      </tr>`;
    }).join("") : `<tr><td colspan="7">${stateNote("No medicines found", "Try a different search or add the first medicine to the clinic catalog.")}</td></tr>`;
    return `${canManageInventory() ? metrics([
      ["Total medicines", stats.total_medicines],
      ["Low stock", stats.low_stock_count],
      ["Out of stock", stats.out_of_stock_count],
      ["Stock value", price(stats.total_stock_value)],
    ]) : ""}
    ${(isPharmacist() || isAdmin()) ? `<section class="clinic-panel clinic-pharmacy-activity"><div class="clinic-section-head"><div><h2>Pharmacy workflow</h2><p>${esc(stats.pending_prescriptions ?? 0)} prescriptions pending · ${esc(stats.dispensed_today ?? 0)} dispensed today</p></div><button type="button" class="clinic-btn" data-pharmacy-action="dispense-next" ${state.pendingPrescriptions.length ? "" : "disabled"}>Dispense next</button></div>
      <div class="clinic-pharmacy-columns">
        <div><h3>Pending prescriptions</h3>${state.pendingPrescriptions.length ? `<ul class="clinic-compact-list">${state.pendingPrescriptions.slice(0, 5).map((rx) => `<li><button type="button" data-pharmacy-action="prescription-open" data-id="${esc(rx.id)}"><strong>${text(rx, "patient_name")}</strong><span>${text(rx, "prescription_number")} · ${esc(rx.item_count ?? 0)} items</span></button></li>`).join("")}</ul>` : `<p class="clinic-empty-note">No pending prescriptions.</p>`}</div>
        <div><h3>Recent dispenses today</h3>${state.recentDispenses.length ? `<ul class="clinic-compact-list">${state.recentDispenses.slice(0, 5).map((rx) => `<li><button type="button" data-pharmacy-action="prescription-open" data-id="${esc(rx.id)}"><strong>${text(rx, "patient_name")}</strong><span>${text(rx, "prescription_number")} · ${dateLabel(rx.dispensed_at || rx.created_at)}</span></button></li>`).join("")}</ul>` : `<p class="clinic-empty-note">No prescriptions dispensed today.</p>`}</div>
      </div>
    </section>` : ""}
    <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Medicine inventory</h2><p>${canManageInventory() ? "Manage the active medicine catalog and review stock levels." : "View the medicine catalog and current stock levels."}</p></div>${canManageInventory() ? `<button type="button" class="clinic-btn" data-pharmacy-action="medicine-add">Add medicine</button>` : ""}</div>
      <form class="clinic-pharmacy-filters" data-pharmacy-form="medicine-filters">
        <label class="clinic-field"><span>Search</span><input class="clinic-control" name="search" value="${esc(state.medicineSearch)}" placeholder="Name, generic name, or code"></label>
        <label class="clinic-field"><span>Category</span><input class="clinic-control" name="category" value="${esc(state.medicineCategory)}" placeholder="Any category"></label>
        <label class="clinic-check"><input type="checkbox" name="low_stock" ${state.lowStockOnly ? "checked" : ""}><span>Low stock only</span></label>
        <div class="clinic-actions"><button type="submit" class="clinic-btn clinic-btn--quiet">Apply filters</button><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="clear-medicine-filters">Clear</button></div>
      </form>
      <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Medicine</th><th>Category</th><th>Form / strength</th><th>Stock</th><th>Reorder at</th><th>Cost</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  function renderMedicineDetail() {
    const medicine = state.selectedMedicine || {};
    const rows = state.movements.length ? state.movements.map((movement) => `<tr>
      <td>${dateLabel(movement.created_at)}</td><td>${text(movement, "movement_type")}</td>
      <td>${Number(movement.quantity) > 0 ? "+" : ""}${esc(movement.quantity)}</td>
      <td>${esc(movement.balance_after)}</td><td>${text(movement, "reference")}</td>
      <td>${text(movement, "created_by_name")}</td>
    </tr>`).join("") : `<tr><td colspan="6">${stateNote("No stock movements yet", "Restocks and stock adjustments will appear here.")}</td></tr>`;
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><button type="button" class="clinic-back" data-pharmacy-action="medicine-back">Back to pharmacy</button><h2>${text(medicine, "name")}</h2><p>${text(medicine, "code")} · ${text(medicine, "generic_name", "No generic name")}</p></div><div class="clinic-row-actions">
        ${canManageInventory() ? `<button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="medicine-edit">Edit</button>
        <button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="stock-adjust">Adjust stock</button>` : ""}
        ${isAdmin() && medicine.active ? `<button type="button" class="clinic-btn clinic-btn--danger" data-pharmacy-action="medicine-delete">Deactivate</button>` : ""}
      </div></div>
      ${metrics([
        ["Available stock", `${medicine.current_stock ?? 0} ${medicine.unit || ""}`],
        ["Reorder level", medicine.reorder_level],
        ["Cost per unit", price(medicine.cost_price)],
        ["Selling price", price(medicine.selling_price)],
      ])}
      <div class="clinic-pharmacy-detail-grid">
        <article class="clinic-subpanel"><h3>Medicine details</h3><dl class="clinic-pharmacy-dl">
          <div><dt>Category</dt><dd>${text(medicine, "category")}</dd></div>
          <div><dt>Form / strength</dt><dd>${text(medicine, "form")}${medicine.strength ? ` · ${text(medicine, "strength")}` : ""}</dd></div>
          <div><dt>Manufacturer</dt><dd>${text(medicine, "manufacturer")}</dd></div>
          <div><dt>Unit</dt><dd>${text(medicine, "unit")}</dd></div>
          <div><dt>Status</dt><dd>${medicine.active ? "Active" : "Inactive"}</dd></div>
        </dl></article>
        ${canManageInventory() ? `<article class="clinic-subpanel"><h3>Stock movement history</h3><div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Date</th><th>Type</th><th>Change</th><th>Balance</th><th>Reference</th><th>Staff</th></tr></thead><tbody>${rows}</tbody></table></div></article>` : ""}
      </div>
    </section>`;
  }

  function renderPrescriptions() {
    const stats = state.prescriptionStats || {};
    const rows = state.prescriptions.length ? state.prescriptions.map((rx) => `<tr>
      <td class="clinic-primary-cell"><strong>${text(rx, "prescription_number")}</strong><span>${dateLabel(rx.created_at)}</span></td>
      <td>${text(rx, "patient_name")}<span class="clinic-secondary-text">${text(rx, "patient_number")}</span></td>
      <td>${text(rx, "doctor_name")}</td><td>${esc(rx.item_count ?? 0)} items</td>
      <td>${statusBadge(rx.status)}</td><td><button type="button" class="clinic-btn clinic-btn--quiet clinic-btn--small" data-pharmacy-action="prescription-open" data-id="${esc(rx.id)}">Details</button></td>
    </tr>`).join("") : `<tr><td colspan="6">${stateNote("No prescriptions found", "Create a prescription from a visit or choose a patient directly.")}</td></tr>`;
    const doctorOptions = [{ value: "", label: "All doctors" }, ...state.doctors.map((doctor) => ({
      value: doctor.id,
      label: doctor.name || doctor.email || "Doctor",
    }))];
    return `${metrics([
      ["Pending", stats.pending],
      ["Dispensed today", stats.dispensed_today],
      ["Dispensed this week", stats.dispensed_this_week],
    ])}
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Prescriptions</h2><p>Review status and dispensing history for this clinic.</p></div>${mayCreatePrescription() ? `<button type="button" class="clinic-btn" data-pharmacy-action="prescription-add">New prescription</button>` : ""}</div>
        <form class="clinic-pharmacy-filters" data-pharmacy-form="prescription-filters">
          <label class="clinic-field"><span>Patient</span><input class="clinic-control" name="patient_search" data-pharmacy-input="patient-search" list="clinicPrescriptionPatientOptions" value="${esc(state.patientFilterLabel)}" placeholder="Search by patient name or number"><input type="hidden" name="patient_id" value="${esc(state.prescriptionFilters.patient_id)}"><datalist id="clinicPrescriptionPatientOptions"></datalist></label>
          ${select("Doctor", "doctor_id", state.prescriptionFilters.doctor_id, doctorOptions)}
          ${select("Status", "status", state.prescriptionFilters.status, [
            { value: "", label: "All statuses" },
            { value: "pending", label: "Pending" },
            { value: "dispensed", label: "Dispensed" },
            { value: "cancelled", label: "Cancelled" },
          ])}
          ${field("Date", "date", state.prescriptionFilters.date, "date")}
          <div class="clinic-actions"><button type="submit" class="clinic-btn clinic-btn--quiet">Apply filters</button><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="clear-prescription-filters">Clear</button></div>
        </form>
        <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Prescription</th><th>Patient</th><th>Doctor</th><th>Items</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      </section>`;
  }

  function stockShortages(items) {
    const byId = new Map(state.medicines.map((medicine) => [String(medicine.id), medicine]));
    const totals = new Map();
    for (const item of items || []) {
      if (!item.medicine_id) continue;
      totals.set(item.medicine_id, (totals.get(item.medicine_id) || 0) + Number(item.quantity || 0));
    }
    return [...totals].flatMap(([id, required]) => {
      const medicine = byId.get(String(id));
      if (!medicine || Number(medicine.current_stock) < required) {
        return [{
          name: medicine?.name || "Unavailable medicine",
          required,
          available: Number(medicine?.current_stock || 0),
        }];
      }
      return [];
    });
  }

  function renderPrescriptionDetail() {
    const detail = state.selectedPrescription || {};
    const rx = detail.prescription || {};
    const items = Array.isArray(detail.items) ? detail.items : [];
    const movements = state.medicines;
    const canEdit = isDoctor() && rx.status === "pending" && String(rx.doctor_id) === String(user()?.id);
    const canDispense = (isAdmin() || isPharmacist()) && rx.status === "pending";
    const lines = items.length ? items.map((item) => {
      const medicine = movements.find((row) => String(row.id) === String(item.medicine_id));
      return `<article class="clinic-rx-item"><div><strong>${text(item, "medicine_name")}</strong><span>${item.medicine_id ? `Stock: ${esc(medicine?.current_stock ?? 0)} ${text(medicine, "unit", "")}` : "External medicine · no stock deduction"}</span></div>
        <dl><div><dt>Dosage</dt><dd>${text(item, "dosage")}</dd></div><div><dt>Frequency</dt><dd>${text(item, "frequency")}</dd></div><div><dt>Duration</dt><dd>${text(item, "duration")}</dd></div><div><dt>Route</dt><dd>${text(item, "route")}</dd></div><div><dt>Quantity</dt><dd>${esc(item.quantity ?? 0)}</dd></div><div><dt>Instructions</dt><dd>${text(item, "instructions")}</dd></div></dl></article>`;
    }).join("") : `<p class="clinic-empty-note">No prescription items were found.</p>`;
    const timeline = Array.isArray(detail.timeline) && detail.timeline.length
      ? `<ol class="clinic-timeline">${detail.timeline.map((event) => `<li><strong>${esc(String(event.action || "").replaceAll("clinic.prescription_", "").replaceAll("_", " "))}</strong><span>${dateLabel(event.created_at)} · ${text(event, "actor_name")}</span></li>`).join("")}</ol>`
      : `<p class="clinic-empty-note">No status events recorded.</p>`;
    const shortages = stockShortages(items);
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><button type="button" class="clinic-back" data-pharmacy-action="prescription-back">Back to prescriptions</button><h2>${text(rx, "prescription_number")}</h2><p>${text(rx, "patient_name")} · ${text(rx, "patient_number")} · ${text(rx, "doctor_name")}</p></div><div class="clinic-row-actions">
        ${canEdit ? `<button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="prescription-edit">Edit</button><button type="button" class="clinic-btn clinic-btn--danger" data-pharmacy-action="prescription-cancel">Cancel</button>` : ""}
        ${canDispense ? `<button type="button" class="clinic-btn" data-pharmacy-action="prescription-dispense">Dispense all</button>` : ""}
        ${statusBadge(rx.status)}
      </div></div>
      <div class="clinic-pharmacy-detail-grid"><article class="clinic-subpanel"><h3>Prescription items</h3><div class="clinic-rx-items">${lines}</div>${rx.notes ? `<p class="clinic-pharmacy-notes"><strong>Notes:</strong> ${text(rx, "notes")}</p>` : ""}</article>
      <article class="clinic-subpanel"><h3>Status timeline</h3>${timeline}<div class="clinic-prescription-meta"><span>Patient</span><strong>${text(rx, "patient_name")}</strong><span>Created</span><strong>${dateLabel(rx.created_at)}</strong>${rx.dispensed_at ? `<span>Dispensed</span><strong>${dateLabel(rx.dispensed_at)} · ${text(rx, "dispensed_by_name")}</strong>` : ""}</div></article></div>
      ${canDispense && shortages.length ? `<p class="clinic-inline-warning">Stock is currently insufficient for: ${shortages.map((item) => `${esc(item.name)} (${item.available}/${item.required})`).join(", ")}. Dispensing will be blocked until stock is available.</p>` : ""}
    </section>`;
  }

  async function loadMedicineDetail(id, shouldRender = true) {
    state.selectedMedicine = state.medicines.find((medicine) => String(medicine.id) === String(id)) || null;
    if (!state.selectedMedicine) throw new Error("That medicine is no longer in the catalog.");
    state.movements = [];
    if (canManageInventory()) {
      const payload = await request(`/api/clinic/medicines/${encodeURIComponent(id)}/movements?limit=50`);
      state.selectedMedicine = payload.medicine || state.selectedMedicine;
      state.movements = Array.isArray(payload.movements) ? payload.movements : [];
    }
    if (shouldRender) rerender();
  }

  async function loadPrescriptionDetail(id, shouldRender = true) {
    const payload = await request(`/api/clinic/prescriptions/${encodeURIComponent(id)}`);
    state.selectedPrescription = {
      prescription: payload.prescription || null,
      items: Array.isArray(payload.items) ? payload.items : [],
      timeline: Array.isArray(payload.timeline) ? payload.timeline : [],
    };
    if (shouldRender) rerender();
  }

  async function loadVisitPrescriptions(visitId) {
    if (!canReadPrescriptions() || !visitId) return [];
    const payload = await request(`/api/clinic/prescriptions?${queryString({ visit_id: visitId, limit: 100 })}`);
    const records = Array.isArray(payload.prescriptions) ? payload.prescriptions : [];
    state.visitPrescriptions.set(String(visitId), records);
    return records;
  }

  function renderVisitPrescriptionSection(visit) {
    if (!canReadPrescriptions() || !visit?.id) return "";
    const records = state.visitPrescriptions.get(String(visit.id)) || [];
    const ownVisit = isDoctor() && String(visit.doctor_id) === String(user()?.id);
    return `<section class="clinic-subpanel clinic-visit-prescriptions"><div class="clinic-section-head"><div><h3>Prescriptions for this visit</h3><p>${records.length} prescription${records.length === 1 ? "" : "s"}</p></div>${ownVisit ? `<button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="write-prescription">Write prescription</button>` : ""}</div>
      ${records.length ? `<ul class="clinic-compact-list">${records.map((rx) => `<li><button type="button" data-pharmacy-action="prescription-open" data-id="${esc(rx.id)}"><strong>${text(rx, "prescription_number")} · ${text(rx, "patient_name")}</strong><span>${statusBadge(rx.status)} · ${esc(rx.item_count ?? 0)} items</span></button></li>`).join("")}</ul>` : `<p class="clinic-empty-note">No prescriptions are linked to this visit.</p>`}
    </section>`;
  }

  async function loadPatientPrescriptions(patientId) {
    if (!canReadPrescriptions() || !patientId) return [];
    const payload = await request(`/api/clinic/prescriptions?${queryString({ patient_id: patientId, limit: 100 })}`);
    const records = Array.isArray(payload.prescriptions) ? payload.prescriptions : [];
    state.patientPrescriptions.set(String(patientId), records);
    return records;
  }

  function renderPatientPrescriptionSection(patientId) {
    if (!canReadPrescriptions()) return "";
    const records = state.patientPrescriptions.get(String(patientId)) || [];
    return `<article class="clinic-subpanel"><div class="clinic-section-head"><div><h3>Prescriptions</h3><p>${records.length} record${records.length === 1 ? "" : "s"}</p></div></div>${records.length ? `<ul class="clinic-compact-list">${records.map((rx) => `<li><button type="button" data-pharmacy-action="prescription-open" data-id="${esc(rx.id)}"><strong>${text(rx, "prescription_number")} · ${dateLabel(rx.created_at)}</strong><span>${statusBadge(rx.status)} · ${esc(rx.item_count ?? 0)} items</span></button></li>`).join("")}</ul>` : `<p class="clinic-empty-note">No prescriptions are recorded for this patient.</p>`}</article>`;
  }

  function openPrescriptionForVisit(visit) {
    if (!isDoctor() || !visit?.id || String(visit.doctor_id) !== String(user()?.id)) return;
    setModal({
      type: "prescription",
      visitId: String(visit.id),
      patientId: String(visit.patient_id || ""),
      patientName: visit.patient_name || "Selected patient",
      record: null,
      items: [{}],
      formState: {},
    });
  }

  function renderMedicineModal() {
    const modal = state.modal;
    const record = modal.record || {};
    const values = modal.formState || {};
    const isEdit = Boolean(modal.record);
    const formValue = (key) => values[key] ?? record[key] ?? "";
    const formOptions = ["tablet", "capsule", "syrup", "injection", "cream", "other"];
    const formChoices = [{ value: "", label: "Select form" }, ...formOptions.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))];
    const content = `<form data-pharmacy-form="medicine" class="clinic-form-grid">
      ${field("Medicine code", "code", formValue("code"), "text", "required maxlength=\"60\"")}
      ${field("Medicine name", "name", formValue("name"), "text", "required maxlength=\"160\"")}
      ${field("Generic name", "generic_name", formValue("generic_name"), "text", "maxlength=\"160\"")}
      ${field("Category", "category", formValue("category"), "text", "maxlength=\"160\"")}
      ${select("Form", "form", formValue("form"), formChoices)}
      ${field("Strength", "strength", formValue("strength"), "text", "maxlength=\"160\"")}
      ${field("Manufacturer", "manufacturer", formValue("manufacturer"), "text", "maxlength=\"160\"")}
      ${field("Unit", "unit", formValue("unit") || "tablet", "text", "required maxlength=\"60\"")}
      ${field("Reorder level", "reorder_level", formValue("reorder_level") || 20, "number", "min=\"0\" step=\"1\" required")}
      ${!isEdit ? field("Initial stock", "current_stock", formValue("current_stock") || 0, "number", "min=\"0\" step=\"1\" required") : ""}
      ${field("Cost price (UGX)", "cost_price", formValue("cost_price"), "number", "min=\"0\" step=\"0.01\"")}
      ${field("Selling price (UGX)", "selling_price", formValue("selling_price"), "number", "min=\"0\" step=\"0.01\"")}
      ${state.modalError ? `<p class="clinic-form-error clinic-span-2">${esc(state.modalError)}</p>` : ""}
      <div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="close-modal">Cancel</button><button type="submit" class="clinic-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : isEdit ? "Save medicine" : "Add medicine"}</button></div>
    </form>`;
    return modalFrame(isEdit ? "Edit medicine" : "Add medicine", content);
  }

  function renderPrescriptionItems(items) {
    const list = Array.isArray(items) && items.length ? items : [{}];
    return list.map((item, index) => {
      const input = (label, key, value, type = "text", options = "") =>
        `<label class="clinic-field"><span>${esc(label)}</span><input class="clinic-control" type="${esc(type)}" name="item_${key}_${index}" data-rx-field="${esc(key)}" value="${esc(value ?? "")}" ${options}></label>`;
      return `<fieldset class="clinic-rx-item clinic-rx-form-item" data-rx-item="${index}">
      <div class="clinic-rx-item-head"><strong>Medicine ${index + 1}</strong>${list.length > 1 ? `<button type="button" class="clinic-btn clinic-btn--quiet clinic-btn--small" data-pharmacy-action="remove-rx-item" data-index="${index}">Remove</button>` : ""}</div>
      <label class="clinic-field"><span>Medicine (choose from stock or type an external medicine)</span><input class="clinic-control" name="item_name_${index}" data-rx-field="medicine_name" data-pharmacy-input="medicine-search" list="clinicMedicineOptions" value="${esc(item.medicine_name || "")}" autocomplete="off" required><input type="hidden" name="item_medicine_id_${index}" data-rx-field="medicine_id" value="${esc(item.medicine_id || "")}"></label>
      ${input("Dosage", "dosage", item.dosage, "text", "required maxlength=\"120\"")}
      ${input("Frequency", "frequency", item.frequency, "text", "required maxlength=\"120\"")}
      ${input("Duration", "duration", item.duration, "text", "required maxlength=\"120\"")}
      ${input("Route", "route", item.route, "text", "maxlength=\"80\"")}
      ${input("Quantity", "quantity", item.quantity, "number", "min=\"1\" step=\"1\" required")}
      ${input("Instructions", "instructions", item.instructions, "text", "maxlength=\"1000\"")}
    </fieldset>`;
    }).join("");
  }

  function modalFrame(title, content, description = "") {
    return `<div class="clinic-modal-backdrop" data-pharmacy-backdrop><section class="clinic-modal" role="dialog" aria-modal="true" aria-labelledby="clinicPharmacyModalTitle"><div class="clinic-modal-head"><div><h2 id="clinicPharmacyModalTitle">${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}</div><button type="button" class="clinic-close" aria-label="Close" data-pharmacy-action="close-modal">×</button></div><div class="clinic-modal-body">${content}</div></section></div>`;
  }

  function renderPrescriptionModal() {
    const modal = state.modal;
    const values = modal.formState || {};
    const editing = Boolean(modal.record);
    const record = modal.record || {};
    const visitId = values.visit_id ?? modal.visitId ?? record.visit_id ?? "";
    const patientId = values.patient_id ?? modal.patientId ?? record.patient_id ?? "";
    const visits = [{ value: "", label: "No visit selected" }, ...state.visits.map((visit) => ({
      value: visit.id,
      label: `${visit.visit_number || "Visit"} · ${visit.patient_name || "Patient"} · ${dateLabel(visit.visit_started_at)}`,
    }))];
    const selectedVisit = state.visits.find((visit) => String(visit.id) === String(visitId));
    const patientField = editing
      ? `<div class="clinic-field clinic-span-2"><span>Patient</span><strong>${text(record, "patient_name")} · ${text(record, "patient_number")}</strong></div>`
      : modal.visitId
        ? `<div class="clinic-field clinic-span-2"><span>Patient</span><strong>${esc(modal.patientName || selectedVisit?.patient_name || "Selected patient")}</strong><input type="hidden" name="patient_id" value="${esc(patientId)}"></div>`
        : `<label class="clinic-field clinic-span-2"><span>Patient search</span><input class="clinic-control" name="patient_search" data-pharmacy-input="patient-search" list="clinicPrescriptionPatientOptions" value="${esc(values.patient_search || "")}" placeholder="Search name or patient number" autocomplete="off"><input type="hidden" name="patient_id" value="${esc(patientId)}"><datalist id="clinicPrescriptionPatientOptions"></datalist></label>`;
    const visitField = editing || modal.visitId
      ? `<div class="clinic-field clinic-span-2"><span>Visit</span><strong>${text(record, "visit_number", selectedVisit?.visit_number || (visitId ? "Selected visit" : "No visit linked"))}</strong><input type="hidden" name="visit_id" value="${esc(visitId)}"></div>`
      : `<div class="clinic-span-2">${select("Link to visit (optional)", "visit_id", visitId, visits)}</div>`;
    const notes = values.notes ?? record.notes ?? "";
    const content = `<form data-pharmacy-form="prescription">
      <div class="clinic-form-grid">${patientField}${visitField}${area("Prescription notes", "notes", notes, "maxlength=\"4000\"")}</div>
      <datalist id="clinicMedicineOptions">${state.medicineSearchResults.map((medicine) => `<option value="${esc(`${medicine.name}${medicine.strength ? ` · ${medicine.strength}` : ""} · ${medicine.code}`)}"></option>`).join("")}</datalist>
      <div class="clinic-rx-form-list">${renderPrescriptionItems(modal.items || [])}</div>
      <div class="clinic-pharmacy-add-row"><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="add-rx-item">Add another medicine</button></div>
      ${state.modalError ? `<p class="clinic-form-error">${esc(state.modalError)}</p>` : ""}
      <div class="clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="close-modal">Cancel</button><button type="submit" class="clinic-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : editing ? "Save changes" : "Create prescription"}</button></div>
    </form>`;
    return modalFrame(editing ? "Edit prescription" : "New prescription", content, "A pharmacist will dispense all stocked medicines together.");
  }

  function renderModal() {
    if (!state.modal) return "";
    if (state.modal.type === "medicine") return renderMedicineModal();
    if (state.modal.type === "prescription") return renderPrescriptionModal();
    if (state.modal.type === "stock-adjust") {
      const content = `<form class="clinic-form-grid" data-pharmacy-form="stock-adjust">
        ${select("Movement type", "movement_type", "restock", [
          { value: "restock", label: "Restock" },
          { value: "adjustment", label: "Adjustment" },
          { value: "expiry", label: "Expiry" },
          { value: "damage", label: "Damage" },
          { value: "return", label: "Return" },
        ])}
        ${field("Quantity change (+/-)", "quantity_change", "", "number", "required step=\"1\"")}
        ${area("Notes", "notes", "", "maxlength=\"1000\"")}
        ${state.modalError ? `<p class="clinic-form-error clinic-span-2">${esc(state.modalError)}</p>` : ""}
        <div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="close-modal">Cancel</button><button type="submit" class="clinic-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save stock movement"}</button></div>
      </form>`;
      return modalFrame("Adjust stock", content, `${text(state.selectedMedicine, "name")} · current balance ${esc(state.selectedMedicine?.current_stock ?? 0)} ${text(state.selectedMedicine, "unit", "")}`);
    }
    if (state.modal.type === "delete-medicine") {
      const content = `<p>Deactivate ${text(state.selectedMedicine, "name")}? It will no longer appear in active inventory or new prescriptions. Existing stock and movement history are retained.</p>${state.modalError ? `<p class="clinic-form-error">${esc(state.modalError)}</p>` : ""}<div class="clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="close-modal">Cancel</button><button type="button" class="clinic-btn clinic-btn--danger" data-pharmacy-action="delete-medicine-confirm" ${state.saving ? "disabled" : ""}>${state.saving ? "Deactivating…" : "Deactivate medicine"}</button></div>`;
      return modalFrame("Deactivate medicine?", content);
    }
    if (state.modal.type === "cancel-prescription") {
      const content = `<form class="clinic-form-grid" data-pharmacy-form="cancel-prescription">${area("Reason for cancellation", "reason", "", "required maxlength=\"1000\"")}${state.modalError ? `<p class="clinic-form-error clinic-span-2">${esc(state.modalError)}</p>` : ""}<div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="close-modal">Keep prescription</button><button type="submit" class="clinic-btn clinic-btn--danger" ${state.saving ? "disabled" : ""}>${state.saving ? "Cancelling…" : "Cancel prescription"}</button></div></form>`;
      return modalFrame("Cancel prescription?", content, "Cancellation is allowed only while the prescription is pending.");
    }
    if (state.modal.type === "dispense") {
      const rx = state.selectedPrescription?.prescription || {};
      const items = state.selectedPrescription?.items || [];
      const shortageList = stockShortages(items);
      const content = `<p>Dispense all items on <strong>${text(rx, "prescription_number")}</strong> for <strong>${text(rx, "patient_name")}</strong>. Stock deductions will be made together.</p><div class="clinic-rx-items">${items.map((item) => {
        const medicine = state.medicines.find((row) => String(row.id) === String(item.medicine_id));
        return `<div class="clinic-rx-item"><div><strong>${text(item, "medicine_name")}</strong><span>${item.medicine_id ? `Need ${esc(item.quantity)} · Available ${esc(medicine?.current_stock ?? 0)}` : "External medicine · no stock deduction"}</span></div></div>`;
      }).join("")}</div>${shortageList.length ? `<p class="clinic-inline-warning">Insufficient stock for ${shortageList.map((item) => `${esc(item.name)} (${item.available}/${item.required})`).join(", ")}.</p>` : ""}${state.modalError ? `<p class="clinic-form-error">${esc(state.modalError)}</p>` : ""}<div class="clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-pharmacy-action="close-modal">Back</button><button type="button" class="clinic-btn" data-pharmacy-action="dispense-confirm" ${state.saving || shortageList.length ? "disabled" : ""}>${state.saving ? "Dispensing…" : "Confirm dispense all"}</button></div>`;
      return modalFrame("Confirm dispensing", content, "This action updates the prescription and stock ledger.");
    }
    return "";
  }

  async function searchPatients(input) {
    const term = input.value.trim();
    const listId = input.getAttribute("list");
    const list = listId ? document.getElementById(listId) : null;
    if (!term || !list) return;
    const sequence = ++state.patientSearchSequence;
    try {
      const query = queryString({ search: term, status: "active", limit: 15 });
      const payload = await request(`/api/clinic/patients?${query}`);
      if (sequence !== state.patientSearchSequence) return;
      state.patientSearchResults = Array.isArray(payload.patients) ? payload.patients : [];
      list.innerHTML = state.patientSearchResults.map((patient) => `<option value="${esc(`${nameOfPatient(patient)} · ${patient.patient_number || ""}`)}"></option>`).join("");
    } catch {
      list.innerHTML = "";
    }
  }

  async function searchMedicines(input) {
    const term = input.value.trim();
    const list = document.getElementById("clinicMedicineOptions");
    if (!term || !list) return;
    const sequence = ++state.medicineSearchSequence;
    try {
      const payload = await request(`/api/clinic/medicines?${queryString({ search: term, limit: 30 })}`);
      if (sequence !== state.medicineSearchSequence) return;
      state.medicineSearchResults = Array.isArray(payload.medicines) ? payload.medicines : [];
      list.innerHTML = state.medicineSearchResults.map((medicine) => `<option value="${esc(`${medicine.name}${medicine.strength ? ` · ${medicine.strength}` : ""} · ${medicine.code}`)}"></option>`).join("");
    } catch {
      list.innerHTML = "";
    }
  }

  function syncPatientSelection(input) {
    const form = input.closest("form");
    const hidden = form?.querySelector('[name="patient_id"]');
    if (!hidden) return;
    const selected = state.patientSearchResults.find((patient) =>
      `${nameOfPatient(patient)} · ${patient.patient_number || ""}` === input.value.trim());
    hidden.value = selected?.id || "";
    if (!selected && form.dataset.pharmacyForm === "prescription") {
      const visitId = form.querySelector('[name="visit_id"]')?.value;
      const visit = state.visits.find((row) => String(row.id) === String(visitId));
      if (visit) hidden.value = visit.patient_id || "";
    }
  }

  function syncMedicineSelection(input) {
    const row = input.closest("[data-rx-item]");
    const hidden = row?.querySelector('[data-rx-field="medicine_id"]');
    if (!hidden) return;
    const selected = state.medicineSearchResults.find((medicine) =>
      `${medicine.name}${medicine.strength ? ` · ${medicine.strength}` : ""} · ${medicine.code}` === input.value.trim());
    if (selected) {
      hidden.value = selected.id;
      input.value = selected.name;
    } else if (hidden.value) {
      const existing = state.medicines.find((medicine) => String(medicine.id) === String(hidden.value));
      if (existing && input.value.trim() !== existing.name) hidden.value = "";
    }
  }

  function capturePrescriptionItems(form) {
    return [...form.querySelectorAll("[data-rx-item]")].map((row) => {
      const get = (key) => row.querySelector(`[data-rx-field="${key}"]`)?.value?.trim() || "";
      return {
        medicine_id: get("medicine_id") || null,
        medicine_name: get("medicine_name"),
        dosage: get("dosage"),
        frequency: get("frequency"),
        duration: get("duration"),
        route: get("route"),
        quantity: get("quantity"),
        instructions: get("instructions"),
      };
    });
  }

  function rememberPrescriptionForm(form) {
    if (!state.modal || state.modal.type !== "prescription") return;
    state.modal.items = capturePrescriptionItems(form);
    state.modal.formState = formValues(form);
  }

  async function submitMedicine(form) {
    const values = formValues(form);
    const body = {
      code: String(values.code || "").trim(),
      name: String(values.name || "").trim(),
      generic_name: String(values.generic_name || "").trim(),
      category: String(values.category || "").trim(),
      form: String(values.form || "").trim(),
      strength: String(values.strength || "").trim(),
      manufacturer: String(values.manufacturer || "").trim(),
      unit: String(values.unit || "").trim(),
      reorder_level: Number(values.reorder_level || 0),
      cost_price: values.cost_price === "" ? null : Number(values.cost_price),
      selling_price: values.selling_price === "" ? null : Number(values.selling_price),
    };
    const editing = Boolean(state.modal?.record);
    if (!editing) body.current_stock = Number(values.current_stock || 0);
    const id = state.modal?.record?.id;
    state.saving = true;
    state.modalError = "";
    rerender();
    try {
      await request(editing ? `/api/clinic/medicines/${encodeURIComponent(id)}` : "/api/clinic/medicines", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      state.modal = null;
      state.saving = false;
      notifyUser(editing ? "Medicine details updated." : "Medicine added to inventory.");
      await loadTab("pharmacy");
      if (editing && id) await loadMedicineDetail(id);
    } catch (error) {
      state.saving = false;
      state.modalError = clinicError(error);
      state.modal.formState = values;
      rerender();
    }
  }

  async function submitStockAdjustment(form) {
    const values = formValues(form);
    const id = state.selectedMedicine?.id;
    state.saving = true;
    state.modalError = "";
    rerender();
    try {
      await request(`/api/clinic/medicines/${encodeURIComponent(id)}/adjust-stock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          movement_type: values.movement_type,
          quantity_change: Number(values.quantity_change),
          notes: String(values.notes || "").trim(),
        }),
      });
      state.modal = null;
      state.saving = false;
      notifyUser("Stock movement recorded.");
      await fetchMedicines();
      await loadMedicineDetail(id);
      rerender();
    } catch (error) {
      state.saving = false;
      state.modalError = clinicError(error);
      rerender();
    }
  }

  async function submitPrescription(form) {
    const values = formValues(form);
    const items = capturePrescriptionItems(form);
    const modal = state.modal;
    const visitId = String(values.visit_id || modal.visitId || "").trim();
    let patientId = String(values.patient_id || modal.patientId || "").trim();
    if (!patientId && visitId) {
      patientId = state.visits.find((visit) => String(visit.id) === visitId)?.patient_id || "";
    }
    const payload = {
      notes: String(values.notes || "").trim(),
      items: items.map((item) => ({
        ...item,
        quantity: Number(item.quantity),
      })),
    };
    if (modal.record) {
      // Pending prescription identity, visit, and patient are immutable.
    } else {
      if (visitId) payload.visit_id = visitId;
      if (patientId) payload.patient_id = patientId;
    }
    const id = modal.record?.id;
    modal.items = items;
    modal.formState = values;
    state.saving = true;
    state.modalError = "";
    rerender();
    try {
      await request(modal.record
        ? `/api/clinic/prescriptions/${encodeURIComponent(id)}`
        : "/api/clinic/prescriptions", {
        method: modal.record ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      state.modal = null;
      state.saving = false;
      notifyUser(modal.record ? "Prescription updated." : "Prescription created.");
      if (state.activeTab === "prescriptions") {
        await loadTab("prescriptions");
        if (id) await loadPrescriptionDetail(id);
      } else {
        await loadTab("pharmacy");
      }
      if (visitId && typeof onVisitPrescriptionChange === "function") {
        await onVisitPrescriptionChange(visitId);
      }
    } catch (error) {
      state.saving = false;
      state.modalError = clinicError(error);
      rerender();
    }
  }

  async function submitCancel(form) {
    const reason = String(new FormData(form).get("reason") || "").trim();
    const id = state.selectedPrescription?.prescription?.id;
    state.saving = true;
    state.modalError = "";
    rerender();
    try {
      await request(`/api/clinic/prescriptions/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      state.modal = null;
      state.saving = false;
      notifyUser("Prescription cancelled.");
      await refreshPrescriptions();
    } catch (error) {
      state.saving = false;
      state.modalError = clinicError(error);
      rerender();
    }
  }

  async function refreshPrescriptions() {
    if (state.activeTab === "prescriptions") {
      await loadTab("prescriptions");
      const id = state.selectedPrescription?.prescription?.id;
      if (id) await loadPrescriptionDetail(id);
    } else {
      await loadTab("pharmacy");
      const id = state.selectedPrescription?.prescription?.id;
      if (id) await loadPrescriptionDetail(id);
    }
  }

  async function dispensePrescription() {
    const id = state.selectedPrescription?.prescription?.id;
    if (!id || (!isAdmin() && !isPharmacist())) return;
    state.saving = true;
    state.modalError = "";
    rerender();
    try {
      await request(`/api/clinic/prescriptions/${encodeURIComponent(id)}/dispense`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      state.modal = null;
      state.saving = false;
      notifyUser("Prescription dispensed and stock updated.");
      await refreshPrescriptions();
    } catch (error) {
      state.saving = false;
      state.modalError = clinicError(error);
      rerender();
    }
  }

  async function deactivateMedicine() {
    const id = state.selectedMedicine?.id;
    if (!id || !isAdmin()) return;
    state.saving = true;
    state.modalError = "";
    rerender();
    try {
      await request(`/api/clinic/medicines/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.modal = null;
      state.selectedMedicine = null;
      state.saving = false;
      notifyUser("Medicine deactivated. Stock history was retained.");
      await loadTab("pharmacy");
    } catch (error) {
      state.saving = false;
      state.modalError = clinicError(error);
      rerender();
    }
  }

  async function handleSubmit(event) {
    const form = event.target.closest("form[data-pharmacy-form]");
    if (!form) return;
    event.preventDefault();
    const type = form.dataset.pharmacyForm;
    if (type === "medicine") await submitMedicine(form);
    if (type === "stock-adjust") await submitStockAdjustment(form);
    if (type === "prescription") await submitPrescription(form);
    if (type === "cancel-prescription") await submitCancel(form);
    if (type === "medicine-filters") {
      const values = formValues(form);
      state.medicineSearch = String(values.search || "").trim();
      state.medicineCategory = String(values.category || "").trim();
      state.lowStockOnly = values.low_stock === "on";
      state.loading = true;
      rerender();
      try {
        await fetchMedicines();
        state.error = "";
      } catch (error) {
        state.error = clinicError(error);
      } finally {
        state.loading = false;
        rerender();
      }
    }
    if (type === "prescription-filters") {
      const values = formValues(form);
      state.prescriptionFilters = {
        status: String(values.status || ""),
        patient_id: String(values.patient_id || ""),
        doctor_id: String(values.doctor_id || ""),
        date: String(values.date || ""),
      };
      state.patientFilterLabel = String(values.patient_search || "");
      await loadTab("prescriptions");
    }
  }

  async function handleClick(event) {
    const button = event.target.closest("[data-pharmacy-action]");
    if (event.target.matches("[data-pharmacy-backdrop]")) {
      state.modal = null;
      state.modalError = "";
      rerender();
      return;
    }
    if (!button) return;
    event.preventDefault();
    const action = button.dataset.pharmacyAction;
    const id = button.dataset.id;
    if (action === "close-modal") {
      state.modal = null;
      state.modalError = "";
      rerender();
    } else if (action === "retry") {
      await loadTab(state.activeTab || "pharmacy");
    } else if (action === "medicine-add" && canManageInventory()) {
      setModal({ type: "medicine", record: null, formState: {} });
    } else if (action === "medicine-open" && id) {
      try {
        await loadMedicineDetail(id);
      } catch (error) {
        state.error = clinicError(error);
        rerender();
      }
    } else if (action === "medicine-back") {
      state.selectedMedicine = null;
      state.movements = [];
      rerender();
    } else if (action === "medicine-edit" && canManageInventory() && state.selectedMedicine?.active) {
      setModal({ type: "medicine", record: state.selectedMedicine, formState: {} });
    } else if (action === "stock-adjust" && canManageInventory() && state.selectedMedicine?.active) {
      setModal({ type: "stock-adjust" });
    } else if (action === "medicine-delete" && isAdmin()) {
      setModal({ type: "delete-medicine" });
    } else if (action === "delete-medicine-confirm") {
      await deactivateMedicine();
    } else if (action === "clear-medicine-filters") {
      state.medicineSearch = "";
      state.medicineCategory = "";
      state.lowStockOnly = false;
      await loadTab("pharmacy");
    } else if (action === "prescription-add" && mayCreatePrescription()) {
      setModal({ type: "prescription", visitId: "", patientId: "", record: null, items: [{}], formState: {} });
    } else if (action === "prescription-open" && id) {
      try {
        const currentTab = typeof getCurrentTab === "function" ? getCurrentTab() : "";
        if (!["pharmacy", "prescriptions"].includes(currentTab)) {
          if (typeof navigateToPrescriptions === "function") navigateToPrescriptions();
          await loadTab("prescriptions");
        }
        await loadPrescriptionDetail(id);
      } catch (error) {
        state.error = clinicError(error);
        rerender();
      }
    } else if (action === "prescription-back") {
      state.selectedPrescription = null;
      rerender();
    } else if (action === "prescription-edit" && isDoctor() && state.selectedPrescription?.prescription?.status === "pending") {
      const rx = state.selectedPrescription.prescription;
      setModal({
        type: "prescription",
        record: rx,
        items: state.selectedPrescription.items.map((item) => ({ ...item })),
        formState: {},
      });
    } else if (action === "prescription-cancel" && isDoctor()) {
      setModal({ type: "cancel-prescription" });
    } else if (action === "prescription-dispense" && (isAdmin() || isPharmacist())) {
      const rx = state.selectedPrescription?.prescription;
      try {
        if (rx) {
          const payload = await request("/api/clinic/medicines?limit=250");
          state.medicines = Array.isArray(payload.medicines) ? payload.medicines : [];
        }
        setModal({ type: "dispense" });
      } catch (error) {
        state.modalError = clinicError(error);
        setModal({ type: "dispense" });
      }
    } else if (action === "dispense-confirm") {
      await dispensePrescription();
    } else if (action === "dispense-next" && (isAdmin() || isPharmacist())) {
      const next = state.pendingPrescriptions[0];
      if (!next) {
        notifyUser("There are no pending prescriptions.", "info");
        return;
      }
      try {
        await loadPrescriptionDetail(next.id, false);
        const payload = await request("/api/clinic/medicines?limit=250");
        state.medicines = Array.isArray(payload.medicines) ? payload.medicines : [];
        setModal({ type: "dispense" });
      } catch (error) {
        state.error = clinicError(error);
        rerender();
      }
    } else if (action === "clear-prescription-filters") {
      state.prescriptionFilters = { status: "", patient_id: "", doctor_id: "", date: "" };
      await loadTab("prescriptions");
    } else if (action === "add-rx-item" && state.modal?.type === "prescription") {
      const form = portalHost?.querySelector('form[data-pharmacy-form="prescription"]');
      if (form) rememberPrescriptionForm(form);
      state.modal.items = [...(state.modal.items || []), {}];
      rerender();
      portalHost?.querySelector(`[data-rx-item="${state.modal.items.length - 1}"] input`)?.focus();
    } else if (action === "remove-rx-item" && state.modal?.type === "prescription") {
      const form = portalHost?.querySelector('form[data-pharmacy-form="prescription"]');
      if (form) rememberPrescriptionForm(form);
      const index = Number(button.dataset.index);
      state.modal.items = (state.modal.items || []).filter((_, itemIndex) => itemIndex !== index);
      if (!state.modal.items.length) state.modal.items = [{}];
      rerender();
    }
  }

  function handleInput(event) {
    const input = event.target;
    if (input.matches('[data-pharmacy-input="patient-search"]')) {
      syncPatientSelection(input);
      const form = input.closest("form");
      const hidden = form?.querySelector('[name="patient_id"]');
      if (hidden?.value) return;
      clearTimeout(state.patientSearchTimer);
      state.patientSearchTimer = setTimeout(() => void searchPatients(input), 220);
    }
    if (input.matches('[data-pharmacy-input="medicine-search"]')) {
      syncMedicineSelection(input);
      clearTimeout(state.medicineSearchTimer);
      state.medicineSearchTimer = setTimeout(() => void searchMedicines(input), 220);
    }
  }

  function handleChange(event) {
    const input = event.target;
    if (input.matches('[data-pharmacy-input="patient-search"]')) syncPatientSelection(input);
    if (input.matches('[data-pharmacy-input="medicine-search"]')) syncMedicineSelection(input);
    if (input.matches('form[data-pharmacy-form="prescription"] [name="visit_id"]')) {
      const form = input.closest("form");
      const visit = state.visits.find((row) => String(row.id) === String(input.value));
      const patientId = form?.querySelector('[name="patient_id"]');
      if (visit && patientId) patientId.value = visit.patient_id || "";
    }
  }

  async function resetForUser() {
    state.activeTab = "";
    state.loading = false;
    state.saving = false;
    state.error = "";
    state.modalError = "";
    state.modal = null;
    state.medicines = [];
    state.medicineStats = {};
    state.medicineSearch = "";
    state.medicineCategory = "";
    state.lowStockOnly = false;
    state.selectedMedicine = null;
    state.movements = [];
    state.prescriptions = [];
    state.pendingPrescriptions = [];
    state.recentDispenses = [];
    state.prescriptionStats = {};
    state.prescriptionFilters = { status: "", patient_id: "", doctor_id: "", date: "" };
    state.patientFilterLabel = "";
    state.selectedPrescription = null;
    state.doctors = [];
    state.visits = [];
    state.doctorStats = null;
    state.doctorStatsError = "";
    state.visitPrescriptions.clear();
    state.patientPrescriptions.clear();
  }

  portalHost?.addEventListener("click", handleClick);
  portalHost?.addEventListener("submit", (event) => void handleSubmit(event));
  portalHost?.addEventListener("input", handleInput);
  portalHost?.addEventListener("change", handleChange);

  return {
    loadTab,
    loadDoctorStats,
    renderTab,
    renderModal,
    renderDoctorDashboardCard,
    loadVisitPrescriptions,
    renderVisitPrescriptionSection,
    loadPatientPrescriptions,
    renderPatientPrescriptionSection,
    openPrescriptionForVisit,
    resetForUser,
  };
}
