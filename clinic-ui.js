const PHOTO_LIMIT = 200 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TABS = [
  ["overview", "Dashboard"],
  ["appointments", "Appointments"],
  ["visits", "Visits"],
  ["branches", "Branches"],
  ["patients", "Patients"],
  ["staff", "Staff"],
  ["settings", "Settings"],
];
const ROLE_TABS = {
  clinic_admin: new Set(["overview", "appointments", "visits", "patients", "branches", "staff", "settings"]),
  doctor: new Set(["overview", "appointments", "visits", "patients"]),
  nurse: new Set(["overview", "appointments", "visits", "patients"]),
  receptionist: new Set(["overview", "appointments", "patients", "branches"]),
  pharmacist: new Set(["patient-lookup"]),
};
const PATIENT_FIELDS = [
  ["branch_id", "Branch", "select", ""],
  ["first_name", "First name", "text", "required"],
  ["last_name", "Last name", "text", "required"],
  ["gender", "Gender", "select", ""],
  ["date_of_birth", "Date of birth", "date", ""],
  ["national_id", "National ID", "text", ""],
  ["phone", "Phone", "tel", ""],
  ["email", "Email", "email", ""],
  ["address", "Address", "text", "clinic-span-2"],
  ["village", "Village", "text", ""],
  ["district", "District", "text", ""],
  ["blood_group", "Blood group", "select", ""],
  ["allergies", "Allergies", "textarea", "clinic-span-2"],
  ["chronic_conditions", "Chronic conditions", "textarea", "clinic-span-2"],
  ["emergency_contact_name", "Emergency contact name", "text", ""],
  ["emergency_contact_phone", "Emergency contact phone", "tel", ""],
];
const BRANCH_FIELDS = [
  ["name", "Branch name", "text", "required"],
  ["code", "Branch code", "text", ""],
  ["address", "Street address", "text", "clinic-span-2"],
  ["city", "City", "text", ""],
  ["district", "District", "text", ""],
  ["phone", "Phone", "tel", ""],
];
const STAFF_FIELDS = [
  ["name", "Full name", "text", "required"],
  ["email", "Email", "email", "required"],
  ["phone", "Phone", "tel", ""],
  ["role", "Role", "select", "required"],
  ["branch_id", "Branch", "select", "required"],
  ["employee_code", "Employee code", "text", ""],
  ["license_number", "License number", "text", ""],
  ["specialization", "Specialization", "text", ""],
  ["hired_on", "Date hired", "date", ""],
];
const ORG_FIELDS = [
  ["name", "Clinic organization name", "text", "required"],
  ["registration_number", "Registration number", "text", ""],
  ["license_number", "License number", "text", ""],
  ["address", "Address", "text", "clinic-span-2"],
  ["city", "City", "text", ""],
  ["district", "District", "text", ""],
  ["country", "Country", "text", ""],
  ["phone", "Main phone", "tel", ""],
  ["email", "Organization email", "email", ""],
  ["website", "Website", "url", ""],
  ["brand_color", "Brand color", "color", ""],
];
const SETTINGS_FIELDS = [
  ["currency", "Currency", "text", ""],
  ["consultation_fee", "Consultation fee", "number", ""],
  ["opening_time", "Opening time", "time", ""],
  ["closing_time", "Closing time", "time", ""],
  ["working_days", "Working days (comma separated)", "text", "clinic-span-2"],
];

export function initClinicUI({ api, getCurrentUser, escapeHtml, notify }) {
  const portalHost = document.getElementById("clinicPortalPage");
  const commandHost = document.getElementById("ccClinicView");
  const state = {
    user: typeof getCurrentUser === "function" ? getCurrentUser() : null,
    organization: null,
    tab: "overview",
    patients: [],
    branches: [],
    staff: [],
    stats: null,
    today: null,
    appointments: [],
    visits: [],
    doctors: [],
    bookingPatients: [],
    appointmentFilters: { date: "", doctor_id: "" },
    visitFilters: { date: "", doctor_id: "", status: "" },
    selectedVisit: null,
    selectedVisitId: null,
    visitNotes: [],
    patientDetailTab: "info",
    patientAppointments: [],
    patientVisits: [],
    settings: null,
    selectedPatient: null,
    selectedPatientId: null,
    search: "",
    branchFilter: "",
    patientStatus: "active",
    loading: false,
    error: "",
    modal: null,
    saving: false,
    command: { organizations: [], stats: null, loading: false, error: "", creating: false, saving: false },
  };

  const esc = (value) => typeof escapeHtml === "function"
    ? escapeHtml(value == null ? "" : String(value))
    : String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  const role = () => String(state.user?.role || "").toLowerCase();
  const can = (tab) => ROLE_TABS[role()]?.has(tab) === true;
  const isAdmin = () => role() === "clinic_admin";
  const isNurse = () => role() === "nurse";
  const isReceptionist = () => role() === "receptionist";
  const patientName = (patient) => `${patient?.first_name || ""} ${patient?.last_name || ""}`.trim() || "Patient";
  const safeImage = (value) => /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(String(value || "")) ? value : "";
  const empty = "—";
  const text = (record, key, fallback = empty) => esc(record?.[key] == null || record[key] === "" ? fallback : record[key]);
  const initials = (name) => String(name || "AP").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  const announce = (message, type = "success") => { if (typeof notify === "function") notify(message, type); };
  const formValue = (form, name) => String(new FormData(form).get(name) ?? "").trim();
  const errorText = (error) => {
    const status = error?.status || error?.statusCode || error?.response?.status;
    if (status === 401) return "Your session has expired. Sign in again to continue.";
    if (status === 403) return "You do not have permission to access this clinic information.";
    return error?.message || "Something went wrong. Please try again.";
  };

  async function request(path, options = undefined) {
    if (typeof api !== "function") throw new Error("The authenticated API helper is unavailable.");
    const result = options ? await api(path, options) : await api(path);
    if (typeof Response !== "undefined" && result instanceof Response) {
      const payload = await result.json().catch(() => ({}));
      if (!result.ok) {
        const error = new Error(payload?.error?.message || payload?.message || `Request failed (${result.status}).`);
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

  function portalRoot() { return portalHost?.querySelector(".clinic-portal") || null; }
  function brandName() {
    return state.organization?.name || state.user?.organization_name || state.user?.organization?.name || state.user?.clinic_name || "APSHULE Clinic";
  }
  function userName() { return state.user?.name || state.user?.full_name || state.user?.email || "Clinic team"; }
  function dateLabel(value) {
    if (!value) return empty;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? esc(value) : esc(new Intl.DateTimeFormat("en-UG", { timeZone: "Africa/Kampala", day: "numeric", month: "short", year: "numeric" }).format(date));
  }
  function clinicToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function timeLabel(value) {
    if (!value) return empty;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? esc(value) : esc(new Intl.DateTimeFormat("en-UG", { timeZone: "Africa/Kampala", hour: "numeric", minute: "2-digit" }).format(date));
  }
  function clinicDateKey(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value).slice(0,10)
      : new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
  function staffId() { return state.user?.id || state.user?.user_id || ""; }
  function doctorId(doctor) { return doctor?.user_id || doctor?.id || ""; }
  function isDoctor() { return role() === "doctor"; }
  function canBookAppointment() { return isAdmin() || isReceptionist() || isNurse(); }
  function brandLogo() {
    const value = state.organization?.logo_base64 || state.organization?.logo || state.organization?.logo_url || state.user?.organization?.logo_base64 || state.user?.organization?.logo_url || "";
    return safeImage(value) || (/^(https?:\/\/|\/)/i.test(String(value)) ? String(value) : "");
  }
  function queryString(values) {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => { if (value !== "" && value != null) params.set(key, value); });
    return params.toString();
  }
  function statusClass(status) {
    return ["cancelled", "voided", "no_show"].includes(String(status || "").toLowerCase()) ? "clinic-status--inactive"
      : ["checked_in", "in_progress", "referred"].includes(String(status || "").toLowerCase()) ? "clinic-status--attention" : "";
  }
  function statusLabel(value) { return String(value || "unknown").replaceAll("_", " "); }
  function ageLabel(value) {
    if (!value) return empty;
    const birth = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(birth.getTime())) return empty;
    const today = new Date();
    let years = today.getFullYear() - birth.getFullYear();
    if (
      today.getMonth() < birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())
    ) years -= 1;
    return years < 0 ? empty : `${years} yr`;
  }

  function frameMarkup() {
    if (!portalHost) return;
    const allowed = TABS.filter(([key]) => can(key));
    if (!allowed.some(([key]) => key === state.tab)) state.tab = allowed[0]?.[0] || "patients";
    const pharmacistLookup = role() === "pharmacist";
    portalHost.innerHTML = `<section class="clinic-portal">
      <div class="clinic-shell">
        <header class="clinic-topbar">
          <div class="clinic-brand">${brandLogo() ? `<img class="clinic-brand-logo" src="${esc(brandLogo())}" alt="${esc(brandName())} logo">` : `<div class="clinic-brand-mark" aria-hidden="true">A.</div>`}<div><strong>${esc(brandName())}</strong><span>APSHULE · CLINIC WORKSPACE</span></div></div>
          <div class="clinic-user"><div class="clinic-avatar" aria-hidden="true">${esc(initials(userName()))}</div><div><strong>${esc(userName())}</strong><span>${esc(role().replaceAll("_", " ") || "clinic staff")}</span></div></div>
        </header>
        ${pharmacistLookup ? `<div class="clinic-intro"><div><p class="clinic-eyebrow">Clinic workspace</p><h1>Patient detail access</h1><p>Open an assigned patient profile using its record ID. Patient lists are not available to this role.</p></div></div>` : ""}
        ${allowed.length ? `<nav class="clinic-nav" aria-label="Clinic workspace">${allowed.map(([key, label]) => `<button type="button" data-clinic-tab="${key}" aria-current="${state.tab === key ? "page" : "false"}">${esc(label)}</button>`).join("")}</nav>` : ""}
        <main class="clinic-view">${pharmacistLookup ? lookupView() : portalView()}</main>
        <div class="clinic-modal-slot">${modalMarkup()}</div>
      </div>
    </section>`;
    const portal = portalRoot();
    const brandColor = String(state.organization?.brand_color || state.user?.organization?.brand_color || "").trim();
    if (portal && /^#[0-9a-f]{6}$/i.test(brandColor)) portal.style.setProperty("--clinic-primary", brandColor);
  }

  function intro(title, description, eyebrow = "Clinic workspace") {
    return `<div class="clinic-intro"><div><p class="clinic-eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p>${esc(description)}</p></div></div>`;
  }

  function portalView() {
    if (!state.user) return `${intro("Clinic workspace", "Sign in with a clinic account to view and manage records.")}<section class="clinic-panel">${stateMarkup("Clinic access required", "Your account does not have access to the clinic workspace.")}</section>`;
    if (!ROLE_TABS[role()]) return `${intro("Clinic workspace", "This account is not assigned to a supported clinic role.")}<section class="clinic-panel">${stateMarkup("Clinic access unavailable", "Ask a clinic administrator to confirm your role and organization access.")}</section>`;
    let title = "Clinic dashboard";
    let desc = "The day's schedule and care, at a glance.";
    if (state.tab === "appointments") { title = "Appointments"; desc = "Coordinate arrivals and keep today's schedule moving."; }
    if (state.tab === "visits") { title = "Clinical visits"; desc = "Review visit notes and continue active care."; }
    if (state.tab === "patients") { title = "Patient records"; desc = "Find a patient record and review the details your role allows."; }
    if (state.tab === "branches") { title = "Branches"; desc = "View clinic locations and their contact details."; }
    if (state.tab === "staff") { title = "Clinic team"; desc = "Manage staff access, roles, and branch assignments."; }
    if (state.tab === "settings") { title = "Clinic settings"; desc = "Update organization identity and the clinic's operating defaults."; }
    return `${intro(title, desc)}${viewContent()}`;
  }

  function viewContent() {
    if (state.loading) return `<section class="clinic-panel"><div class="clinic-skeleton" aria-label="Loading"><span></span><span></span><span></span><span></span></div></section>`;
    if (state.error) return `<section class="clinic-panel">${stateMarkup("We could not load this view", errorText({ message: state.error }), true, state.selectedVisitId && state.tab === "visits" ? "visit-detail" : state.selectedPatientId ? (state.selectedPatient ? "patients" : "patient-detail") : state.tab)}${state.selectedPatientId ? `<div class="clinic-actions"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="patient-back">Back to patient records</button></div>` : ""}</section>`;
    if (state.tab === "overview") return dashboard();
    if (state.tab === "appointments") return appointmentsView();
    if (state.tab === "visits") return state.selectedVisit ? visitDetail() : visitsView();
    if (state.tab === "patients") return state.selectedPatientId ? patientDetail() : patientList();
    if (state.tab === "branches") return branchList();
    if (state.tab === "staff") return staffList();
    if (state.tab === "settings") return settingsView();
    return "";
  }

  function stateMarkup(title, description, failed = false, retry = "") {
    return `<div class="clinic-state ${failed ? "clinic-error" : ""}"><div class="clinic-state-mark" aria-hidden="true">${failed ? "!" : "CL"}</div><strong>${esc(title)}</strong><p>${esc(description)}</p>${failed ? `<button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-retry="${esc(retry)}">Try again</button>` : ""}</div>`;
  }

  function dashboard() {
    if (isDoctor()) return doctorDashboard();
    const stats = state.stats || {};
    const today = state.today || {};
    const todayRows = Array.isArray(today.appointments_today) ? today.appointments_today : [];
    const metrics = [
      ["Patients", stats.patients ?? 0],
      ["Active patients", stats.active_patients ?? 0],
      ["Branches", stats.branches ?? 0],
      ["Team members", stats.staff ?? 0],
    ];
    return `<section class="clinic-today-strip"><div class="clinic-section-head"><div><p class="clinic-eyebrow">Kampala · ${dateLabel(today.date || clinicToday())}</p><h2>Today's clinic flow</h2></div><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-tab="appointments">Open appointments</button></div><div class="clinic-metrics clinic-counts">${[["Appointments", todayRows.length],["Scheduled",today.scheduled_count??0],["Checked in",today.checked_in_count??0],["Completed",today.completed_count??0]].map(([label,count])=>`<article class="clinic-metric"><span>${esc(label)}</span><strong>${esc(count)}</strong></article>`).join("")}</div>
      ${todayRows.length ? `<div class="clinic-appointment-list">${todayRows.slice(0,5).map((a)=>`<article class="clinic-appointment-row"><div class="clinic-time">${timeLabel(a.scheduled_for)}</div><div class="clinic-appointment-person"><strong>${text(a,"patient_name")}</strong><span>${text(a,"doctor_name")} · ${text(a,"reason","No reason recorded")}</span></div><span class="clinic-status ${statusClass(a.status)}">${esc(statusLabel(a.status))}</span></article>`).join("")}</div>` : `<div class="clinic-empty-note">No appointments scheduled for today.</div>`}</section>
      ${isAdmin() ? `<section class="clinic-metrics">${metrics.map(([label, count]) => `<article class="clinic-metric"><span>${esc(label)}</span><strong>${esc(count)}</strong></article>`).join("")}</section>` : ""}
      <div class="clinic-dashboard-grid">
        <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Clinic operations</h2><p>Patient information stays within your organization and role permissions.</p></div><span class="clinic-status">Workspace ready</span></div>
          <div class="clinic-info-grid">
            <div class="clinic-info-item"><span>Organization</span><strong>${esc(brandName())}</strong></div>
            <div class="clinic-info-item"><span>Your access</span><strong>${esc(role().replaceAll("_", " "))}</strong></div>
            ${isAdmin() ? `<div class="clinic-info-item"><span>Staff by role</span><strong>${Object.entries(stats.by_role || {}).map(([r, count]) => `${esc(r.replaceAll("_", " "))}: ${esc(count)}`).join(" · ") || "No team members yet"}</strong></div>` : ""}
          </div>
        </section>
        <aside class="clinic-quick"><div><p class="clinic-eyebrow">Patient desk</p><h2>Keep the right record close at hand.</h2><p>Search patient information and open profiles available to your role.</p></div><button class="clinic-btn" type="button" data-clinic-tab="patients">Open patient records</button></aside>
      </div>`;
  }

  function doctorDashboard() {
    const today = state.today || {};
    const appointments = state.appointments;
    const ownVisits = (Array.isArray(today.in_progress_visits) ? today.in_progress_visits : state.visits)
      .filter((visit) => String(visit.doctor_id) === String(staffId()));
    const seen = new Set(state.visits.filter((visit) => {
      const value = visit.visit_started_at || "";
      return String(visit.doctor_id) === String(staffId()) && clinicDateKey(value) === clinicToday() &&
        ["completed", "referred"].includes(visit.status);
    }).map((visit) => String(visit.patient_id)));
    return `<section class="clinic-metrics">
      ${[["Today's appointments", appointments.length], ["My active visits", ownVisits.length], ["Patients seen today", seen.size]].map(([label, count]) => `<article class="clinic-metric"><span>${esc(label)}</span><strong>${esc(count)}</strong></article>`).join("")}
    </section><section class="clinic-panel"><div class="clinic-section-head"><div><h2>Today's appointments</h2><p>${dateLabel(clinicToday())} · Kampala time</p></div><button class="clinic-btn clinic-btn--quiet" type="button" data-clinic-tab="appointments">Open schedule</button></div>
      ${appointments.length ? `<div class="clinic-appointment-list">${appointments.slice().sort((a,b) => new Date(a.scheduled_for)-new Date(b.scheduled_for)).map((a) => `<article class="clinic-appointment-row"><div class="clinic-time">${timeLabel(a.scheduled_for)}</div><div class="clinic-appointment-person"><strong>${text(a, "patient_name")}</strong><span>${text(a, "patient_number")} · ${text(a, "reason", "No reason recorded")}</span></div><span class="clinic-status ${statusClass(a.status)}">${esc(statusLabel(a.status))}</span></article>`).join("")}</div>` : `<div class="clinic-empty-note">No appointments are on your schedule today.</div>`}
    </section><section class="clinic-panel clinic-dashboard-lower"><div class="clinic-section-head"><div><h2>My in-progress visits</h2><p>Continue clinical work already underway.</p></div><button class="clinic-btn clinic-btn--quiet" type="button" data-clinic-tab="visits">Open visits</button></div>
      ${ownVisits.length ? ownVisits.map((v) => `<button type="button" class="clinic-visit-card" data-clinic-action="open-visit" data-id="${esc(v.id)}"><strong>${text(v, "patient_name")}</strong><span>${text(v, "visit_number")} · ${text(v, "chief_complaint", "Complaint not recorded")}</span><span class="clinic-status clinic-status--attention">In progress</span></button>`).join("") : `<div class="clinic-empty-note">No in-progress visits assigned to you.</div>`}
    </section>`;
  }

  function appointmentsView() {
    const filters = state.appointmentFilters;
    const doctorChoices = state.doctors.filter((doctor) => !isDoctor() || String(doctorId(doctor)) === String(staffId()));
    const sorted = state.appointments.slice().sort((a,b) => new Date(a.scheduled_for)-new Date(b.scheduled_for));
    const grouped = sorted.reduce((acc, appointment) => {
      const key = clinicDateKey(appointment.scheduled_for) || "Unscheduled";
      (acc[key] ||= []).push(appointment);
      return acc;
    }, {});
    const counts = [
      [filters.date === clinicToday() ? "Today" : "Appointments", state.appointments.length],
      ["Checked in", state.appointments.filter((a) => a.status === "checked_in").length],
      ["Completed", state.appointments.filter((a) => a.status === "completed").length],
      ["Cancelled", state.appointments.filter((a) => a.status === "cancelled").length],
    ];
    const rows = Object.entries(grouped).map(([date, list]) => `<section class="clinic-day-group"><div class="clinic-day-heading"><h3>${date === clinicToday() ? "Today" : dateLabel(date)}</h3><span>${list.length} ${list.length === 1 ? "appointment" : "appointments"}</span></div>
      ${list.map((a) => `<article class="clinic-appointment-row"><div class="clinic-time">${timeLabel(a.scheduled_for)}</div><div class="clinic-appointment-person"><strong>${text(a,"patient_name")}</strong><span>${text(a,"patient_number")} · ${text(a,"reason","No reason recorded")}</span><small>${text(a,"doctor_name")} · ${text(a,"branch_name")}</small></div><span class="clinic-status ${statusClass(a.status)}">${esc(statusLabel(a.status))}</span><div class="clinic-row-actions">
      ${a.status === "scheduled" && (isReceptionist() || isNurse()) ? `<button class="clinic-btn clinic-btn--quiet clinic-btn--small" data-clinic-action="check-in" data-id="${esc(a.id)}">Check in</button>` : ""}
      ${a.status === "checked_in" && can("visits") ? `<button class="clinic-btn clinic-btn--small" data-clinic-action="start-visit" data-id="${esc(a.id)}">Start visit</button>` : ""}
      ${["scheduled","checked_in"].includes(a.status) && (isAdmin() || isReceptionist() || isNurse()) ? `<button class="clinic-btn clinic-btn--quiet clinic-btn--small" data-clinic-action="cancel-appointment" data-id="${esc(a.id)}">Cancel</button>` : ""}
      ${a.status === "scheduled" && isReceptionist() ? `<button class="clinic-btn clinic-btn--quiet clinic-btn--small" data-clinic-action="no-show" data-id="${esc(a.id)}">No-show</button>` : ""}
      </div></article>`).join("")}</section>`).join("");
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Schedule</h2><p>${state.appointments.length} appointments · Kampala local time</p></div>${canBookAppointment() ? `<button type="button" class="clinic-btn" data-clinic-action="new-appointment">New appointment</button>` : ""}</div>
      <div class="clinic-metrics clinic-counts">${counts.map(([label,count]) => `<article class="clinic-metric"><span>${esc(statusLabel(label))}</span><strong>${count}</strong></article>`).join("")}</div>
      <form class="clinic-toolbar clinic-filter-toolbar" data-clinic-form="appointment-filter"><label class="clinic-field"><span>Date</span><input class="clinic-control" type="date" name="date" value="${esc(filters.date || clinicToday())}"></label><label class="clinic-field"><span>Doctor</span><select class="clinic-control" name="doctor_id"><option value="">${isDoctor()?"My schedule":"All doctors"}</option>${doctorChoices.map((d) => `<option value="${esc(doctorId(d))}" ${String(filters.doctor_id)===String(doctorId(d))?"selected":""}>${text(d,"name")}</option>`).join("")}</select></label><button class="clinic-btn clinic-btn--quiet" type="submit">Apply filters</button></form>
      ${rows || `<div class="clinic-empty-note">No appointments match this date and doctor. Adjust the filters or add a new appointment.</div>`}</section>`;
  }

  function visitsView() {
    const filters = state.visitFilters;
    const doctorChoices = state.doctors.filter((doctor) => !isDoctor() || String(doctorId(doctor)) === String(staffId()));
    const rows = state.visits.length ? state.visits.slice().sort((a,b) => new Date(b.visit_started_at)-new Date(a.visit_started_at)).map((v) => `<article class="clinic-visit-row"><div class="clinic-visit-date">${dateLabel(v.visit_started_at)}<strong>${timeLabel(v.visit_started_at)}</strong></div><div class="clinic-appointment-person"><strong>${text(v,"patient_name")}</strong><span>${text(v,"patient_number")} · ${text(v,"chief_complaint","No chief complaint")}</span><small>${text(v,"doctor_name")}</small></div><span class="clinic-status ${statusClass(v.status)}">${esc(statusLabel(v.status))}</span>${v.status === "voided" ? `<span class="clinic-muted">Retained for audit</span>` : `<button type="button" class="clinic-btn clinic-btn--quiet clinic-btn--small" data-clinic-action="open-visit" data-id="${esc(v.id)}">Open visit</button>`}</article>`).join("") : `<div class="clinic-empty-note">No visits match the selected filters.</div>`;
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Visit register</h2><p>${state.visits.length} clinical records</p></div></div>
      <form class="clinic-toolbar clinic-filter-toolbar" data-clinic-form="visit-filter"><label class="clinic-field"><span>Status</span><select class="clinic-control" name="status"><option value="">All statuses</option>${["in_progress","completed","referred",...(isAdmin()?["voided"]:[])].map((s) => `<option value="${s}" ${filters.status===s?"selected":""}>${esc(statusLabel(s))}</option>`).join("")}</select></label><label class="clinic-field"><span>Doctor</span><select class="clinic-control" name="doctor_id"><option value="">${isDoctor()?"My visits":"All doctors"}</option>${doctorChoices.map((d) => `<option value="${esc(doctorId(d))}" ${String(filters.doctor_id)===String(doctorId(d))?"selected":""}>${text(d,"name")}</option>`).join("")}</select></label><label class="clinic-field"><span>Date</span><input class="clinic-control" name="date" type="date" value="${esc(filters.date)}"></label><button class="clinic-btn clinic-btn--quiet" type="submit">Apply filters</button></form>
      <div class="clinic-visit-list">${rows}</div></section>`;
  }

  const VITAL_FIELDS = [["blood_pressure","Blood pressure"],["temperature_c","Temperature (°C)"],["weight_kg","Weight (kg)"],["height_cm","Height (cm)"],["pulse_bpm","Pulse (bpm)"],["respiratory_rate","Respiratory rate"]];
  function visitDetail() {
    const visit = state.selectedVisit;
    const canEdit = isDoctor() && String(visit.doctor_id) === String(staffId()) && visit.status === "in_progress";
    const canAddNote = (isDoctor() || isNurse()) && visit.status === "in_progress" &&
      (!isDoctor() || String(visit.doctor_id) === String(staffId()));
    const vitals = visit.vitals || {};
    return `<section class="clinic-panel"><div class="clinic-detail-head"><div><button type="button" class="clinic-back" data-clinic-action="visit-back">Back to visits</button><div class="clinic-detail-title"><div class="clinic-photo clinic-photo-fallback" aria-hidden="true">${esc(initials(visit.patient_name))}</div><div><h2>${text(visit,"patient_name")}</h2><p>${text(visit,"patient_number")} · ${text(visit,"visit_number")} · ${dateLabel(visit.visit_started_at)}</p></div></div></div><div class="clinic-actions"><span class="clinic-status ${statusClass(visit.status)}">${esc(statusLabel(visit.status))}</span>${isAdmin() ? `<button type="button" class="clinic-btn clinic-btn--danger clinic-btn--small" data-clinic-action="void-visit" data-id="${esc(visit.id)}">Void visit</button>` : ""}</div></div>
      <div class="clinic-allergy"><strong>Allergies</strong><span>${text(visit,"patient_allergies","No allergies recorded")}</span></div>
      <form class="clinic-form-grid clinic-visit-form" data-clinic-form="visit-edit" data-id="${esc(visit.id)}">
        <div class="clinic-form-section">Clinical assessment</div>
        <div class="clinic-field clinic-span-2"><label for="visitComplaint">Chief complaint</label><textarea class="clinic-control" id="visitComplaint" name="chief_complaint" ${canEdit?"":"readonly"}>${esc(visit.chief_complaint||"")}</textarea></div>
        <div class="clinic-field clinic-span-2"><label for="visitSymptoms">Symptoms</label><textarea class="clinic-control" id="visitSymptoms" name="symptoms" ${canEdit?"":"readonly"}>${esc(visit.symptoms||"")}</textarea></div>
        <div class="clinic-form-section">Vitals</div>${VITAL_FIELDS.map(([key,label]) => `<div class="clinic-field"><label for="vital-${key}">${esc(label)}</label><input class="clinic-control" id="vital-${key}" name="vital_${key}" type="${key==="blood_pressure"?"text":"number"}" ${key==="blood_pressure"?"":'step="any"'} value="${esc(vitals[key]??"")}" ${canEdit?"":"readonly"}></div>`).join("")}
        <div class="clinic-form-section">Clinical plan</div>
        ${[["examination_notes","Examination notes"],["diagnosis","Diagnosis"],["diagnosis_code","Diagnosis code"],["treatment_plan","Treatment plan"],["referral","Referral"]].map(([key,label])=>`<div class="clinic-field ${["examination_notes","treatment_plan","referral"].includes(key)?"clinic-span-2":""}"><label for="visit-${key}">${esc(label)}</label>${["examination_notes","treatment_plan","referral"].includes(key)?`<textarea class="clinic-control" id="visit-${key}" name="${key}" ${canEdit?"":"readonly"}>${esc(visit[key]||"")}</textarea>`:`<input class="clinic-control" id="visit-${key}" name="${key}" value="${esc(visit[key]||"")}" ${canEdit?"":"readonly"}>`}</div>`).join("")}
        <div class="clinic-field"><label for="visit-follow-up">Follow-up date</label><input class="clinic-control" id="visit-follow-up" name="follow_up_date" type="date" value="${esc(visit.follow_up_date?String(visit.follow_up_date).slice(0,10):"")}" ${canEdit?"":"readonly"}></div>
        ${canEdit?`<div class="clinic-span-2 clinic-actions"><button type="submit" class="clinic-btn clinic-btn--quiet">Save visit</button><button type="button" class="clinic-btn" data-clinic-action="complete-visit" data-id="${esc(visit.id)}">Complete visit</button><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="refer-visit" data-id="${esc(visit.id)}">Refer</button></div>`:""}
      </form>
      <section class="clinic-subpanel clinic-notes"><div class="clinic-section-head"><div><h3>Visit notes</h3><p>Append-only timeline</p></div></div>${state.visitNotes.length?state.visitNotes.map((n)=>`<article class="clinic-note"><div><strong>${text(n,"author_name","Clinic team")}</strong><span>${esc(statusLabel(n.note_type))} · ${dateLabel(n.created_at)} ${timeLabel(n.created_at)}</span></div><p>${text(n,"note_text","")}</p></article>`).join(""):`<div class="clinic-empty-note">No notes have been added to this visit.</div>`}
        ${canAddNote?`<form class="clinic-form-grid clinic-note-form" data-clinic-form="visit-note"><label class="clinic-field"><span>Note type</span><input class="clinic-control" name="note_type" value="clinical" required></label><label class="clinic-field clinic-span-2"><span>Append a note</span><textarea class="clinic-control" name="note_text" required></textarea></label><div class="clinic-span-2 clinic-actions"><button class="clinic-btn clinic-btn--quiet" type="submit">Add note</button></div></form>`:""}
      </section><div class="clinic-phase-note" aria-disabled="true"><strong>Prescriptions coming in Phase 4B-2</strong><span>Prescription workflows are not available in this phase.</span></div>
    </section>`;
  }

  function patientList() {
    const add = isAdmin() || isReceptionist();
    const rows = state.patients.length ? state.patients.map((patient) => `<tr>
      <td class="clinic-primary-cell"><strong>${esc(patientName(patient))}</strong><span>${text(patient, "patient_number", "Record number unavailable")}</span></td>
      <td>${text(patient, "gender")}</td><td>${ageLabel(patient.date_of_birth)}</td>
      <td>${text(patient, "phone")}</td><td>${text(patient, "blood_group")}</td>
      <td>${text(patient, "branch_name")}</td><td>${dateLabel(patient.last_visit)}</td>
      <td><span class="clinic-status ${patient.status === "inactive" ? "clinic-status--inactive" : ""}">${esc(patient.status || "active")}</span></td>
      <td><div class="clinic-row-actions"><button type="button" class="clinic-btn clinic-btn--quiet clinic-btn--small" data-clinic-action="patient-detail" data-id="${esc(patient.id)}">View record</button>${isAdmin() && patient.status !== "inactive" ? `<button type="button" class="clinic-btn clinic-btn--danger clinic-btn--small" data-clinic-action="delete-patient" data-id="${esc(patient.id)}">Deactivate</button>` : ""}</div></td>
    </tr>`).join("") : `<tr><td colspan="9">${stateMarkup(state.search ? "No matching patient records" : "No patient records yet", state.search ? "Try another name, phone number, or record number." : "Patient records added to this clinic will appear here.")}</td></tr>`;
    return `<section class="clinic-panel">
      <div class="clinic-section-head"><div><h2>Patient directory</h2><p>Patient data is only shown to authorized clinic roles.</p></div>${add ? `<button type="button" class="clinic-btn" data-clinic-action="add-patient">Add patient</button>` : ""}</div>
      <form class="clinic-toolbar" data-clinic-form="patient-search"><label class="clinic-field clinic-search"><span class="clinic-visually-hidden">Search patients</span><input class="clinic-control" type="search" name="search" value="${esc(state.search)}" placeholder="Search name, phone, or patient number" autocomplete="off"></label>
        <label class="clinic-field"><span class="clinic-visually-hidden">Filter by branch</span><select class="clinic-control clinic-select-compact" name="branch_id" aria-label="Filter by branch"><option value="">All branches</option>${state.branches.map((branch) => `<option value="${esc(branch.id)}" ${String(state.branchFilter) === String(branch.id) ? "selected" : ""}>${text(branch, "name")}</option>`).join("")}</select></label>
        <label class="clinic-field"><span class="clinic-visually-hidden">Filter by status</span><select class="clinic-control clinic-select-compact" name="status" aria-label="Filter by patient status"><option value="active" ${state.patientStatus === "active" ? "selected" : ""}>Active patients</option><option value="all" ${state.patientStatus === "all" ? "selected" : ""}>All statuses</option></select></label>
        <button class="clinic-btn clinic-btn--quiet" type="submit">Search</button>
      </form>
      <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Patient</th><th>Gender</th><th>Age</th><th>Phone</th><th>Blood group</th><th>Branch</th><th>Last visit</th><th>Status</th><th>Record</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  function patientDetail() {
    const patient = state.selectedPatient;
    if (!patient) return `<section class="clinic-panel">${stateMarkup("Patient record unavailable", "This record may have been removed or is not available to your account.", true, "patient-detail")}</section>`;
    const photo = safeImage(patient.photo_base64);
    const fields = [
      ["Patient number", patient.patient_number], ["Status", patient.status],
      ["Gender", patient.gender], ["Date of birth", dateLabel(patient.date_of_birth)],
      ["National ID", patient.national_id], ["Phone", patient.phone], ["Email", patient.email],
      ["Branch", patient.branch_name], ["Address", patient.address], ["Village", patient.village],
      ["District", patient.district], ["Blood group", patient.blood_group],
      ["Allergies", patient.allergies], ["Chronic conditions", patient.chronic_conditions],
      ["Emergency contact", patient.emergency_contact_name], ["Emergency contact phone", patient.emergency_contact_phone],
      ["Last visit", dateLabel(patient.last_visit)],
    ];
    const canEdit = isAdmin() || isNurse() || isReceptionist();
    return `<section class="clinic-panel">
      <div class="clinic-detail-head"><div>${role() === "pharmacist" ? `<button type="button" class="clinic-back" data-clinic-action="patient-back">Back to patient lookup</button>` : `<button type="button" class="clinic-back" data-clinic-action="patient-back">Back to patient records</button>`}<div class="clinic-detail-title">
        ${photo ? `<img class="clinic-photo" src="${esc(photo)}" alt="Patient photo">` : `<div class="clinic-photo clinic-photo-fallback" aria-hidden="true">${esc(initials(patientName(patient)))}</div>`}
        <div><h2>${esc(patientName(patient))}</h2><p>${text(patient, "patient_number")} · Record created ${dateLabel(patient.created_at)}</p></div></div></div>
        <div class="clinic-actions">${isDoctor() && patient.status === "active" ? `<button type="button" class="clinic-btn" data-clinic-action="start-walk-in">Start walk-in visit</button>` : ""}${canEdit ? `<button type="button" class="clinic-btn" data-clinic-action="edit-patient" data-id="${esc(patient.id)}">Edit record</button>` : ""}${isAdmin() ? `<button type="button" class="clinic-btn clinic-btn--danger" data-clinic-action="delete-patient" data-id="${esc(patient.id)}">Deactivate</button>` : ""}</div>
      </div>
      ${role() !== "pharmacist" ? `<nav class="clinic-patient-tabs" aria-label="Patient record sections">${[["info","Info"],["appointments","Appointments"],...(can("visits")?[["visits","Visits"]]:[]),["prescriptions","Prescriptions (Phase 4B-2)"],["invoices","Invoices (Phase 4C)"]].map(([key,label])=>["prescriptions","invoices"].includes(key)?`<button type="button" disabled aria-disabled="true" title="Not available in this phase">${esc(label)}</button>`:`<button type="button" data-clinic-action="patient-section" data-section="${key}" aria-current="${state.patientDetailTab===key?"page":"false"}">${esc(label)}</button>`).join("")}</nav>` : ""}
      ${state.patientDetailTab==="info" ? `<article class="clinic-subpanel"><h3>Patient information</h3><div class="clinic-info-grid">${fields.map(([label, val]) => `<div class="clinic-info-item"><span>${esc(label)}</span><strong>${val == null || val === "" ? empty : esc(val)}</strong></div>`).join("")}</div></article>` :
        state.patientDetailTab==="appointments" ? `<article class="clinic-subpanel"><h3>Appointments</h3>${state.patientAppointments.length?`<div class="clinic-appointment-list">${state.patientAppointments.slice().sort((a,b)=>new Date(a.scheduled_for)-new Date(b.scheduled_for)).map((a)=>`<article class="clinic-appointment-row"><div class="clinic-time">${dateLabel(a.scheduled_for)}<strong>${timeLabel(a.scheduled_for)}</strong></div><div class="clinic-appointment-person"><strong>${text(a,"reason","Appointment")}</strong><span>${text(a,"doctor_name")} · ${text(a,"branch_name")}</span></div><span class="clinic-status ${statusClass(a.status)}">${esc(statusLabel(a.status))}</span></article>`).join("")}</div>`:`<div class="clinic-empty-note">No appointments are recorded for this patient.</div>`}</article>` :
        state.patientDetailTab==="visits" ? `<article class="clinic-subpanel"><h3>Visits</h3>${state.patientVisits.length?`<div class="clinic-visit-list">${state.patientVisits.slice().sort((a,b)=>new Date(b.visit_started_at)-new Date(a.visit_started_at)).map((v)=>`<article class="clinic-visit-row"><div class="clinic-visit-date">${dateLabel(v.visit_started_at)}</div><div class="clinic-appointment-person"><strong>${text(v,"chief_complaint","Clinical visit")}</strong><span>${text(v,"doctor_name")} · ${text(v,"visit_number")}</span></div><span class="clinic-status ${statusClass(v.status)}">${esc(statusLabel(v.status))}</span><button class="clinic-btn clinic-btn--quiet clinic-btn--small" type="button" data-clinic-action="open-visit" data-id="${esc(v.id)}">Open visit</button></article>`).join("")}</div>`:`<div class="clinic-empty-note">No visits are recorded for this patient.</div>`}</article>` :
        `<article class="clinic-subpanel clinic-deferred"><h3>${state.patientDetailTab==="prescriptions"?"Prescriptions":"Invoices"}</h3><p>${state.patientDetailTab==="prescriptions"?"Prescriptions are deferred to Phase 4B-2.":"Invoices are deferred to Phase 4C."}</p></article>`}
    </section>`;
  }

  function branchList() {
    const rows = state.branches.length ? state.branches.map((branch) => `<tr>
      <td class="clinic-primary-cell"><strong>${text(branch, "name")}</strong><span>${text(branch, "code", "No branch code")}</span></td>
      <td>${text(branch, "city")}${branch.district ? `, ${text(branch, "district")}` : ""}</td><td>${text(branch, "address")}</td><td>${text(branch, "phone")}</td>
      <td><span class="clinic-status ${branch.active === false ? "clinic-status--inactive" : ""}">${branch.active === false ? "Inactive" : "Active"}</span></td>
      ${isAdmin() ? `<td><div class="clinic-row-actions"><button type="button" class="clinic-btn clinic-btn--quiet clinic-btn--small" data-clinic-action="edit-branch" data-id="${esc(branch.id)}">Edit</button><button type="button" class="clinic-btn clinic-btn--danger clinic-btn--small" data-clinic-action="delete-branch" data-id="${esc(branch.id)}">Deactivate</button></div></td>` : ""}
    </tr>`).join("") : `<tr><td colspan="${isAdmin() ? 6 : 5}">${stateMarkup("No branches yet", "Clinic locations will be available here when they have been added.")}</td></tr>`;
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Branch directory</h2><p>${state.branches.length} clinic locations.</p></div>${isAdmin() ? `<button type="button" class="clinic-btn" data-clinic-action="add-branch">Add branch</button>` : ""}</div>
      <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Branch</th><th>Location</th><th>Address</th><th>Phone</th><th>Status</th>${isAdmin() ? "<th>Actions</th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function staffList() {
    const rows = state.staff.length ? state.staff.map((member) => `<tr>
      <td class="clinic-primary-cell"><strong>${text(member, "name")}</strong><span>${text(member, "employee_code", member.email || "No employee code")}</span></td>
      <td>${text(member, "email")}</td><td>${esc(String(member.role || "").replaceAll("_", " ") || empty)}</td><td>${text(member, "branch_name")}</td><td>${text(member, "specialization")}</td>
      <td><span class="clinic-status ${member.active === false ? "clinic-status--inactive" : ""}">${member.active === false ? "Inactive" : "Active"}</span></td>
      <td><div class="clinic-row-actions"><button type="button" class="clinic-btn clinic-btn--quiet clinic-btn--small" data-clinic-action="edit-staff" data-id="${esc(member.id)}">Edit</button><button type="button" class="clinic-btn clinic-btn--danger clinic-btn--small" data-clinic-action="delete-staff" data-id="${esc(member.id)}">Deactivate</button></div></td>
    </tr>`).join("") : `<tr><td colspan="7">${stateMarkup("No staff members yet", "Add clinic team members and assign each one to a branch.")}</td></tr>`;
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Staff directory</h2><p>${state.staff.length} team members recorded.</p></div><button type="button" class="clinic-btn" data-clinic-action="add-staff">Add staff member</button></div>
      <div class="clinic-table-wrap"><table class="clinic-table"><thead><tr><th>Staff member</th><th>Email</th><th>Role</th><th>Branch</th><th>Specialization</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  function settingsView() {
    const settings = state.settings || {};
    const org = state.organization || state.user?.organization || {};
    return `<div class="clinic-dashboard-grid">
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Organization profile</h2><p>Public identity and contact details for this clinic.</p></div></div>
        <form class="clinic-form-grid" data-clinic-form="organization-settings" data-id="${esc(org.id || state.user?.organization_id || "")}">${fieldMarkup(ORG_FIELDS, org, "organization")}
          <div class="clinic-field clinic-span-2"><label for="clinicOrgLogo">Organization logo</label><input class="clinic-control" id="clinicOrgLogo" type="file" name="logo" accept="image/jpeg,image/png,image/webp"><p class="clinic-help">JPEG, PNG, or WebP image.</p></div>
          <div class="clinic-span-2 clinic-actions"><button class="clinic-btn" type="submit">Save organization</button></div>
        </form></section>
      <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Operating defaults</h2><p>Currency, consultation fee, and clinic hours.</p></div></div>
        <form class="clinic-form-grid" data-clinic-form="settings">${fieldMarkup(SETTINGS_FIELDS, settings, "settings")}
          <div class="clinic-span-2 clinic-actions"><button class="clinic-btn" type="submit">Save settings</button></div>
        </form></section>
    </div>`;
  }

  function lookupView() {
    if (state.loading) return `<section class="clinic-panel"><div class="clinic-skeleton"><span></span><span></span></div></section>`;
    if (state.error) return `<section class="clinic-panel">${stateMarkup("Patient detail unavailable", errorText({ message: state.error }), true, "patient-detail")}<div class="clinic-actions"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="patient-back">Back to patient lookup</button></div></section>`;
    if (state.selectedPatientId && state.selectedPatient) return patientDetail();
    return `<section class="clinic-panel"><div class="clinic-section-head"><div><h2>Open a patient detail</h2><p>This role can access an individual patient profile only; no patient directory is provided.</p></div></div>
      <form class="clinic-toolbar" data-clinic-form="patient-lookup"><label class="clinic-field clinic-search"><span>Patient record ID</span><input class="clinic-control" name="patient_id" required autocomplete="off" placeholder="Enter the record ID"></label><button class="clinic-btn" type="submit">Open detail</button></form></section>`;
  }

  function fieldMarkup(fields, record = {}, kind = "patient") {
    return fields.map(([name, label, type, flags]) => {
      const required = String(flags).includes("required");
      const span = String(flags).includes("clinic-span-2");
      const value = record?.[name] ?? "";
      const fieldId = `clinic-${kind}-${name}`;
      let control = "";
      if (name === "branch_id") {
        const existingBranch = value && !state.branches.some((branch) => String(branch.id) === String(value))
          ? `<option value="${esc(value)}" selected>${esc(record.branch_name || "Current branch")}</option>` : "";
        control = `<select class="clinic-control" id="${fieldId}" name="${name}" ${required ? "required" : ""}><option value="">Choose a branch</option>${existingBranch}${state.branches.filter((branch) => branch.active !== false).map((branch) => `<option value="${esc(branch.id)}" ${String(value) === String(branch.id) ? "selected" : ""}>${text(branch, "name")}</option>`).join("")}</select>`;
      } else if (name === "gender") {
        control = `<select class="clinic-control" id="${fieldId}" name="gender"><option value="">Select</option>${["female", "male", "other", "prefer_not_to_say"].map((option) => `<option value="${option}" ${String(value).toLowerCase() === option ? "selected" : ""}>${esc(option.replaceAll("_", " "))}</option>`).join("")}</select>`;
      } else if (name === "blood_group") {
        control = `<select class="clinic-control" id="${fieldId}" name="blood_group"><option value="">Select</option>${["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((option) => `<option value="${option}" ${value === option ? "selected" : ""}>${option}</option>`).join("")}</select>`;
      } else if (name === "role") {
        control = `<select class="clinic-control" id="${fieldId}" name="role" required><option value="">Select role</option>${["doctor", "nurse", "receptionist", "pharmacist"].map((option) => `<option value="${option}" ${value === option ? "selected" : ""}>${esc(option.replaceAll("_", " "))}</option>`).join("")}</select>`;
      } else if (type === "textarea") {
        control = `<textarea class="clinic-control" id="${fieldId}" name="${name}" ${required ? "required" : ""}>${esc(value)}</textarea>`;
      } else if (type === "select") {
        control = `<select class="clinic-control" id="${fieldId}" name="${name}" ${required ? "required" : ""}><option value="">Select</option></select>`;
      } else {
        const normalized = type === "date" && value ? String(value).slice(0, 10) : value;
        control = `<input class="clinic-control" id="${fieldId}" name="${name}" type="${type}" value="${esc(normalized)}" ${required ? "required" : ""} ${type === "number" ? 'step="any"' : ""}>`;
      }
      return `<div class="clinic-field ${span ? "clinic-span-2" : ""}"><label for="${fieldId}">${esc(label)}${required ? " *" : ""}</label>${control}</div>`;
    }).join("") + (kind === "patient" ? `<div class="clinic-form-section">Patient photo</div><div class="clinic-field clinic-span-2"><label for="clinicPatientPhoto">JPEG, PNG, or WebP</label><input class="clinic-control" id="clinicPatientPhoto" type="file" name="photo" accept="image/jpeg,image/png,image/webp"><p class="clinic-help">Maximum file size 200 KiB. The photo is sent with this record, not stored on this device.</p></div>` : "");
  }

  function modalMarkup() {
    if (!state.modal) return "";
    const modal = state.modal;
    if (modal.type === "confirm") return `<div class="clinic-modal-backdrop" data-clinic-backdrop><section class="clinic-modal" role="dialog" aria-modal="true" aria-labelledby="clinicModalTitle"><div class="clinic-modal-head"><div><h2 id="clinicModalTitle">${esc(modal.title)}</h2><p>${esc(modal.description)}</p></div><button type="button" class="clinic-close" aria-label="Close" data-clinic-action="close-modal">×</button></div>${modal.target?.type==="appointment-cancel" ? `<form class="clinic-modal-body clinic-form-grid" data-clinic-form="cancel-appointment"><label class="clinic-field clinic-span-2"><span>Cancellation reason</span><textarea class="clinic-control" name="reason" required></textarea></label><div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="close-modal">Keep appointment</button><button type="submit" class="clinic-btn clinic-btn--danger">Cancel appointment</button></div></form>` : `<div class="clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="close-modal">Cancel</button><button type="button" class="clinic-btn clinic-btn--danger" data-clinic-action="confirm-delete">${modal.target?.type === "visit" ? "Void visit" : "Deactivate"}</button></div>`}</section></div>`;
    if (modal.type === "appointment") return `<div class="clinic-modal-backdrop" data-clinic-backdrop><section class="clinic-modal" role="dialog" aria-modal="true" aria-labelledby="clinicModalTitle"><div class="clinic-modal-head"><div><h2 id="clinicModalTitle">New appointment</h2><p>Schedule an active patient with a clinic doctor. Times are Kampala local time.</p></div><button type="button" class="clinic-close" aria-label="Close" data-clinic-action="close-modal">×</button></div><form class="clinic-modal-body clinic-form-grid" data-clinic-form="appointment-create">
      <label class="clinic-field clinic-span-2"><span>Search active patient</span><input class="clinic-control" name="patient_search" list="clinicPatientOptions" autocomplete="off" required placeholder="Search by name or patient number"><datalist id="clinicPatientOptions">${state.bookingPatients.map((p)=>`<option value="${esc(`${patientName(p)} · ${p.patient_number||p.id}`)}" data-id="${esc(p.id)}"></option>`).join("")}</datalist><input type="hidden" name="patient_id"></label>
      <label class="clinic-field"><span>Doctor</span><select class="clinic-control" name="doctor_id" required><option value="">Choose a doctor</option>${state.doctors.filter((d)=>d.active!==false).map((d)=>`<option value="${esc(d.id)}">${text(d,"name")}${d.specialization?` · ${text(d,"specialization")}`:""}</option>`).join("")}</select></label>
      <label class="clinic-field"><span>Scheduled date and time</span><input class="clinic-control" type="datetime-local" name="scheduled_for" required></label>
      <label class="clinic-field"><span>Duration (minutes)</span><input class="clinic-control" type="number" name="duration_minutes" min="5" step="5" value="30" required></label>
      <label class="clinic-field clinic-span-2"><span>Reason for visit</span><textarea class="clinic-control" name="reason" required></textarea></label>
      <div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="close-modal">Cancel</button><button type="submit" class="clinic-btn">Create appointment</button></div>
    </form></section></div>`;
    if (modal.type === "start-visit") return `<div class="clinic-modal-backdrop" data-clinic-backdrop><section class="clinic-modal" role="dialog" aria-modal="true" aria-labelledby="clinicModalTitle"><div class="clinic-modal-head"><div><h2 id="clinicModalTitle">Start clinical visit</h2><p>${esc(modal.appointment?.patient_name || "Appointment")} · ${esc(modal.appointment?.patient_number || "")}</p></div><button type="button" class="clinic-close" aria-label="Close" data-clinic-action="close-modal">×</button></div><form class="clinic-modal-body clinic-form-grid" data-clinic-form="visit-create"><input type="hidden" name="appointment_id" value="${esc(modal.appointment?.id||"")}"><input type="hidden" name="patient_id" value="${esc(modal.appointment?.patient_id||"")}"><label class="clinic-field clinic-span-2"><span>Chief complaint</span><textarea class="clinic-control" name="chief_complaint" required>${esc(modal.appointment?.reason||"")}</textarea></label><label class="clinic-field clinic-span-2"><span>Symptoms</span><textarea class="clinic-control" name="symptoms"></textarea></label><div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="close-modal">Cancel</button><button type="submit" class="clinic-btn">Start visit</button></div></form></section></div>`;
    if (modal.type === "refer") return `<div class="clinic-modal-backdrop" data-clinic-backdrop><section class="clinic-modal" role="dialog" aria-modal="true" aria-labelledby="clinicModalTitle"><div class="clinic-modal-head"><div><h2 id="clinicModalTitle">Refer patient</h2><p>Record the referral and optional follow-up date.</p></div><button type="button" class="clinic-close" aria-label="Close" data-clinic-action="close-modal">×</button></div><form class="clinic-modal-body clinic-form-grid" data-clinic-form="visit-refer" data-id="${esc(modal.id)}"><label class="clinic-field clinic-span-2"><span>Referral</span><textarea class="clinic-control" name="referral" required></textarea></label><label class="clinic-field"><span>Follow-up date</span><input class="clinic-control" type="date" name="follow_up_date"></label><div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="close-modal">Cancel</button><button type="submit" class="clinic-btn">Save referral</button></div></form></section></div>`;
    const isEdit = Boolean(modal.record);
    const config = modal.type === "patient" ? { title: isEdit ? "Edit patient record" : "Add patient", desc: "Patient identity and contact information.", fields: PATIENT_FIELDS, kind: "patient" }
      : modal.type === "branch" ? { title: isEdit ? "Edit branch" : "Add branch", desc: "Location, contact, and branch identification.", fields: BRANCH_FIELDS, kind: "branch" }
        : { title: isEdit ? "Edit staff member" : "Add staff member", desc: "Account identity, role, and branch assignment.", fields: STAFF_FIELDS, kind: "staff" };
    return `<div class="clinic-modal-backdrop" data-clinic-backdrop><section class="clinic-modal" role="dialog" aria-modal="true" aria-labelledby="clinicModalTitle"><div class="clinic-modal-head"><div><h2 id="clinicModalTitle">${esc(config.title)}</h2><p>${esc(config.desc)}</p></div><button type="button" class="clinic-close" aria-label="Close" data-clinic-action="close-modal">×</button></div>
      <form class="clinic-modal-body clinic-form-grid" data-clinic-form="${modal.type}" data-id="${esc(modal.record?.id || "")}">
        ${state.modalError ? `<div class="clinic-form-error clinic-span-2" role="alert">${esc(state.modalError)}</div>` : ""}
        ${config.kind === "patient" ? `<div class="clinic-form-section">Record details</div>` : ""}
        ${fieldMarkup(config.fields, modal.record || {}, config.kind)}
        <div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="close-modal">Cancel</button><button type="submit" class="clinic-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : isEdit ? "Save changes" : "Create record"}</button></div>
      </form></section></div>`;
  }

  async function loadPortal(tab = state.tab) {
    state.loading = true;
    state.error = "";
    frameMarkup();
    try {
      if (!state.organization) {
        const organizationsPayload = await request("/api/clinic/organizations");
        state.organization = Array.isArray(organizationsPayload.organizations)
          ? organizationsPayload.organizations[0] || null
          : null;
      }
      if (tab === "overview") {
        const dashboardCalls = isAdmin()
          ? [request("/api/clinic/today"), request("/api/clinic/stats"), request("/api/clinic/stats/appointments"), request("/api/clinic/branches"), request("/api/clinic/doctors")]
          : [request("/api/clinic/today"), request("/api/clinic/stats/appointments"), request("/api/clinic/doctors")];
        const payloads = await Promise.all(dashboardCalls);
        const [todayPayload, ...rest] = payloads;
        state.today = todayPayload || {};
        if (isAdmin()) {
          state.stats = rest[0].stats || {};
          state.appointmentStats = rest[1].stats || {};
          state.branches = Array.isArray(rest[2].branches) ? rest[2].branches : [];
          state.doctors = Array.isArray(rest[3].doctors) ? rest[3].doctors : [];
        } else {
          state.appointmentStats = rest[0].stats || {};
          state.doctors = Array.isArray(rest[1].doctors) ? rest[1].doctors : [];
        }
        if (isDoctor()) {
          const [appointmentPayload, activeVisitPayload, seenVisitPayload] = await Promise.all([
            request(`/api/clinic/appointments?${queryString({ date: clinicToday(), doctor_id: staffId() })}`),
            request(`/api/clinic/visits?${queryString({ doctor_id: staffId(), status: "in_progress" })}`),
            request(`/api/clinic/visits?${queryString({ doctor_id: staffId(), date: clinicToday() })}`),
          ]);
          state.appointments = Array.isArray(appointmentPayload.appointments) ? appointmentPayload.appointments : [];
          const visitsById = new Map([...(activeVisitPayload.visits || []), ...(seenVisitPayload.visits || [])].map((visit) => [String(visit.id), visit]));
          state.visits = [...visitsById.values()];
        }
      } else if (tab === "appointments") {
        const [doctorPayload, bookingPayload] = await Promise.all([
          request("/api/clinic/doctors"),
          canBookAppointment() ? request("/api/clinic/patients?status=active") : Promise.resolve({ patients: [] }),
        ]);
        state.doctors = Array.isArray(doctorPayload.doctors) ? doctorPayload.doctors : [];
        state.bookingPatients = Array.isArray(bookingPayload.patients) ? bookingPayload.patients : [];
        if (!state.appointmentFilters.date) state.appointmentFilters.date = clinicToday();
        if (isDoctor() && !state.appointmentFilters.doctor_id) state.appointmentFilters.doctor_id = staffId();
        const params = { date: state.appointmentFilters.date, doctor_id: state.appointmentFilters.doctor_id };
        const payload = await request(`/api/clinic/appointments?${queryString(params)}`);
        state.appointments = Array.isArray(payload.appointments) ? payload.appointments : [];
      } else if (tab === "visits") {
        if (isDoctor() && !state.visitFilters.doctor_id) state.visitFilters.doctor_id = staffId();
        const [doctorPayload, visitPayload] = await Promise.all([
          request("/api/clinic/doctors"),
          request(`/api/clinic/visits?${queryString({ ...state.visitFilters, doctor_id: isDoctor() ? staffId() : state.visitFilters.doctor_id })}`),
        ]);
        state.doctors = Array.isArray(doctorPayload.doctors) ? doctorPayload.doctors : [];
        state.visits = Array.isArray(visitPayload.visits) ? visitPayload.visits : [];
      } else if (tab === "patients") {
        if (state.selectedPatientId) {
          const payload = await request(`/api/clinic/patients/${encodeURIComponent(state.selectedPatientId)}`);
          state.selectedPatient = payload.patient || null;
          if (state.patientDetailTab === "appointments") {
            const records = await request(`/api/clinic/appointments?${queryString({ patient_id: state.selectedPatientId })}`);
            state.patientAppointments = Array.isArray(records.appointments) ? records.appointments : [];
          }
          if (state.patientDetailTab === "visits") {
            const records = await request(`/api/clinic/visits?${queryString({ patient_id: state.selectedPatientId })}`);
            state.patientVisits = Array.isArray(records.visits) ? records.visits : [];
          }
        } else {
          const params = new URLSearchParams();
          if (state.search) params.set("search", state.search);
          if (state.branchFilter) params.set("branch_id", state.branchFilter);
          if (state.patientStatus) params.set("status", state.patientStatus);
          const qs = params.toString();
          const payload = await request(`/api/clinic/patients${qs ? `?${qs}` : ""}`);
          state.patients = Array.isArray(payload.patients) ? payload.patients : [];
          const branchesPayload = await request("/api/clinic/branches");
          state.branches = Array.isArray(branchesPayload.branches) ? branchesPayload.branches : [];
        }
      } else if (tab === "branches") {
        const payload = await request("/api/clinic/branches");
        state.branches = Array.isArray(payload.branches) ? payload.branches : [];
      } else if (tab === "staff") {
        const [staffPayload, branchesPayload] = await Promise.all([request("/api/clinic/staff"), request("/api/clinic/branches")]);
        state.staff = Array.isArray(staffPayload.staff) ? staffPayload.staff : [];
        state.branches = Array.isArray(branchesPayload.branches) ? branchesPayload.branches : [];
      } else if (tab === "settings") {
        const payload = await request("/api/clinic/settings");
        state.settings = payload.settings || {};
      }
    } catch (error) {
      state.error = errorText(error);
    } finally {
      state.loading = false;
      frameMarkup();
    }
  }

  async function loadPatientDetail(id) {
    state.selectedPatientId = String(id || "");
    state.selectedPatient = null;
    state.loading = true;
    state.error = "";
    frameMarkup();
    try {
      if (!state.selectedPatientId) throw new Error("Enter a patient record ID.");
      const payload = await request(`/api/clinic/patients/${encodeURIComponent(state.selectedPatientId)}`);
      state.selectedPatient = payload.patient || null;
      state.patientDetailTab = "info";
      state.patientAppointments = [];
      state.patientVisits = [];
    } catch (error) {
      state.error = errorText(error);
    } finally {
      state.loading = false;
      frameMarkup();
    }
  }

  async function loadVisitDetail(id) {
    if (!id) return;
    state.selectedVisitId = String(id);
    state.selectedVisit = null;
    state.visitNotes = [];
    state.loading = true;
    state.error = "";
    frameMarkup();
    try {
      const [visitPayload, notesPayload] = await Promise.all([
        request(`/api/clinic/visits/${encodeURIComponent(id)}`),
        request(`/api/clinic/visits/${encodeURIComponent(id)}/notes`),
      ]);
      state.selectedVisit = visitPayload.visit || null;
      state.visitNotes = Array.isArray(notesPayload.notes) ? notesPayload.notes : [];
      if (!state.selectedVisit) throw new Error("This visit could not be found.");
    } catch (error) { state.error = errorText(error); }
    finally { state.loading = false; frameMarkup(); }
  }

  function fieldMap(form, fields) {
    const values = {};
    for (const [name] of fields) {
      const value = formValue(form, name);
      values[name] = value === "" ? "" : value;
    }
    return values;
  }

  async function imageData(file) {
    if (!file) return "";
    if (!IMAGE_TYPES.has(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
    if (file.size > PHOTO_LIMIT) throw new Error("Clinic images must be 200 KiB or smaller.");
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("The selected photo could not be read."));
      reader.readAsDataURL(file);
    });
  }

  async function submitRecordForm(form, type) {
    state.saving = true;
    state.modalError = "";
    frameMarkup();
    try {
      const id = form.dataset.id;
      const isEdit = Boolean(id);
      let fields;
      let path;
      if (type === "patient") {
        fields = fieldMap(form, PATIENT_FIELDS);
        const photo = form.querySelector('input[name="photo"]')?.files?.[0];
        if (photo) fields.photo_base64 = await imageData(photo);
        path = isEdit ? `/api/clinic/patients/${encodeURIComponent(id)}` : "/api/clinic/patients";
      } else if (type === "branch") {
        fields = fieldMap(form, BRANCH_FIELDS);
        path = isEdit ? `/api/clinic/branches/${encodeURIComponent(id)}` : "/api/clinic/branches";
      } else {
        fields = fieldMap(form, STAFF_FIELDS);
        path = isEdit ? `/api/clinic/staff/${encodeURIComponent(id)}` : "/api/clinic/staff";
      }
      const result = await request(path, { method: isEdit ? "PATCH" : "POST", body: fields });
      state.modal = null;
      state.modalError = "";
      state.saving = false;
      if (type === "staff" && !isEdit && result.email_sent === false) {
        announce("Staff account created, but the welcome email could not be sent. Have them use Forgot Password at sign-in.", "error");
      } else {
        announce(type === "patient" ? `Patient record ${isEdit ? "updated" : "created"}.` : type === "branch" ? `Branch ${isEdit ? "updated" : "created"}.` : `Staff member ${isEdit ? "updated" : "created"}.`);
      }
      await loadPortal(state.tab);
    } catch (error) {
      state.modalError = errorText(error);
      state.saving = false;
      frameMarkup();
    }
  }

  async function submitGeneralForm(form, type) {
    state.saving = true;
    frameMarkup();
    try {
      if (type === "settings") {
        const fields = fieldMap(form, SETTINGS_FIELDS);
        fields.working_days = fields.working_days ? fields.working_days.split(",").map((day) => day.trim()).filter(Boolean) : [];
        if (fields.consultation_fee !== "") fields.consultation_fee = Number(fields.consultation_fee);
        const payload = await request("/api/clinic/settings", { method: "PATCH", body: fields });
        state.settings = payload.settings || fields;
        announce("Clinic operating settings saved.");
      } else if (type === "organization-settings") {
        const org = state.organization || state.user?.organization || {};
        const id = form.dataset.id;
        if (!id) throw new Error("The clinic organization ID is not available.");
        const fields = fieldMap(form, ORG_FIELDS);
        const logo = form.querySelector('input[name="logo"]')?.files?.[0];
        if (logo) fields.logo_base64 = await imageData(logo);
        const payload = await request(`/api/clinic/organizations/${encodeURIComponent(id)}`, { method: "PATCH", body: fields });
        state.organization = payload.organization || fields;
        state.user = { ...state.user, organization: state.organization, organization_name: state.organization.name };
        announce("Organization profile saved.");
      }
      state.saving = false;
      await loadPortal(state.tab);
    } catch (error) {
      state.saving = false;
      state.error = errorText(error);
      frameMarkup();
      announce(errorText(error), "error");
    }
  }

  async function submitPatientSearch(form) {
    state.search = formValue(form, "search");
    state.branchFilter = formValue(form, "branch_id");
    state.patientStatus = formValue(form, "status") || "active";
    await loadPortal("patients");
  }

  async function submitLookup(form) {
    await loadPatientDetail(formValue(form, "patient_id"));
  }

  function formDataMap(form, names) {
    const data = new FormData(form);
    return Object.fromEntries(names.map((name) => [name, String(data.get(name) ?? "").trim()]));
  }

  async function createAppointment(form) {
    const data = new FormData(form);
    const patientText = String(data.get("patient_search") || "").trim();
    const patient = state.bookingPatients.find((p) => `${patientName(p)} · ${p.patient_number || p.id}` === patientText);
    if (!patient) { announce("Choose an active patient from the search suggestions.", "error"); return; }
    const scheduled = String(data.get("scheduled_for") || "");
    const body = {
      patient_id: patient.id,
      doctor_id: String(data.get("doctor_id") || ""),
      scheduled_for: scheduled ? `${scheduled}:00+03:00` : "",
      duration_minutes: Number(data.get("duration_minutes")),
      reason: String(data.get("reason") || "").trim(),
    };
    try {
      await request("/api/clinic/appointments", { method: "POST", body });
      state.modal = null;
      state.appointmentFilters.date = scheduled.slice(0,10);
      announce("Appointment created.");
      await loadPortal("appointments");
    } catch (error) { announce(errorText(error), "error"); }
  }

  async function submitVisitCreate(form) {
    const body = formDataMap(form, ["patient_id", "appointment_id", "chief_complaint", "symptoms"]);
    if (!body.appointment_id) delete body.appointment_id;
    try {
      const result = await request("/api/clinic/visits", { method: "POST", body });
      state.modal = null;
      announce("Visit started.");
      state.tab = "visits";
      await loadPortal("appointments");
      await loadPortal("visits");
      const visitId = result.visit?.id;
      if (visitId) await loadVisitDetail(visitId);
    } catch (error) { announce(errorText(error), "error"); }
  }

  async function saveVisit(form) {
    const data = new FormData(form);
    const vitals = {};
    VITAL_FIELDS.forEach(([key]) => {
      const raw = String(data.get(`vital_${key}`) || "").trim();
      vitals[key] = raw === "" ? null : key === "blood_pressure" ? raw : Number(raw);
    });
    const body = {
      chief_complaint: String(data.get("chief_complaint") || "").trim(),
      symptoms: String(data.get("symptoms") || "").trim(),
      vitals,
      examination_notes: String(data.get("examination_notes") || "").trim(),
      diagnosis: String(data.get("diagnosis") || "").trim(),
      diagnosis_code: String(data.get("diagnosis_code") || "").trim(),
      treatment_plan: String(data.get("treatment_plan") || "").trim(),
      referral: String(data.get("referral") || "").trim(),
      follow_up_date: String(data.get("follow_up_date") || "").trim() || null,
    };
    try {
      await request(`/api/clinic/visits/${encodeURIComponent(form.dataset.id)}`, { method: "PATCH", body });
      announce("Visit saved.");
      await loadVisitDetail(form.dataset.id);
      await loadPortal("visits");
    } catch (error) { announce(errorText(error), "error"); }
  }

  async function completeVisit(id) {
    try {
      await request(`/api/clinic/visits/${encodeURIComponent(id)}/complete`, { method: "POST" });
      announce("Visit completed.");
      await loadVisitDetail(id);
      await loadPortal("appointments");
      await loadPortal("visits");
    } catch (error) { announce(errorText(error), "error"); }
  }

  async function submitVisitRefer(form) {
    const body = formDataMap(form, ["referral", "follow_up_date"]);
    if (!body.follow_up_date) delete body.follow_up_date;
    try {
      await request(`/api/clinic/visits/${encodeURIComponent(form.dataset.id)}/refer`, { method: "POST", body });
      state.modal = null;
      announce("Referral saved.");
      await loadVisitDetail(form.dataset.id);
      await loadPortal("appointments");
      await loadPortal("visits");
    } catch (error) { announce(errorText(error), "error"); }
  }

  async function addVisitNote(form) {
    const body = formDataMap(form, ["note_type", "note_text"]);
    try {
      await request(`/api/clinic/visits/${encodeURIComponent(state.selectedVisit.id)}/notes`, { method: "POST", body });
      announce("Visit note added.");
      await loadVisitDetail(state.selectedVisit.id);
    } catch (error) { announce(errorText(error), "error"); }
  }

  async function appointmentMutation(id, action, body = undefined) {
    try {
      const options = { method: "POST" };
      if (body) options.body = body;
      await request(`/api/clinic/appointments/${encodeURIComponent(id)}/${action}`, options);
      state.modal = null;
      announce(action === "check-in" ? "Patient checked in." : action === "no-show" ? "Appointment marked as no-show." : "Appointment cancelled.");
      await loadPortal("appointments");
    } catch (error) { announce(errorText(error), "error"); }
  }

  async function searchBookingPatients(term) {
    try {
      const result = await request(`/api/clinic/patients?${queryString({ status: "active", search: term })}`);
      state.bookingPatients = Array.isArray(result.patients) ? result.patients : [];
      const list = portalRoot()?.querySelector("#clinicPatientOptions");
      if (list) list.innerHTML = state.bookingPatients.map((p) => `<option value="${esc(`${patientName(p)} · ${p.patient_number || p.id}`)}"></option>`).join("");
    } catch (error) { announce(errorText(error), "error"); }
  }

  function showModal(type, record = null) {
    state.modal = { type, record };
    state.modalError = "";
    frameMarkup();
    portalRoot()?.querySelector(".clinic-modal input:not([type=file]), .clinic-modal select")?.focus();
  }

  async function deactivate(type, id) {
    const routes = {
      patient: `/api/clinic/patients/${encodeURIComponent(id)}`,
      branch: `/api/clinic/branches/${encodeURIComponent(id)}`,
      staff: `/api/clinic/staff/${encodeURIComponent(id)}`,
      visit: `/api/clinic/visits/${encodeURIComponent(id)}`,
    };
    try {
      await request(routes[type], { method: "DELETE" });
      state.modal = null;
      if (type === "visit") {
        state.selectedVisit = null;
        state.selectedVisitId = null;
        announce("Visit voided. The clinical record is retained for audit.");
        await loadPortal("visits");
        return;
      }
      state.selectedPatient = null;
      state.selectedPatientId = null;
      announce(`${type === "patient" ? "Patient record" : type === "branch" ? "Branch" : "Staff member"} deactivated.`);
      await loadPortal(state.tab);
    } catch (error) {
      state.modal = null;
      state.error = errorText(error);
      announce(errorText(error), "error");
      frameMarkup();
    }
  }

  function handlePortalClick(event) {
    const tabButton = event.target.closest("[data-clinic-tab]");
    if (tabButton) {
      const next = tabButton.dataset.clinicTab;
      if (can(next) && state.tab !== next) {
        state.tab = next;
        state.selectedPatient = null;
        state.selectedPatientId = null;
        state.search = "";
        state.branchFilter = "";
        state.selectedVisit = null;
        state.selectedVisitId = null;
        void loadPortal(next);
      }
      return;
    }
    const actionNode = event.target.closest("[data-clinic-action]");
    if (!actionNode) {
      if (event.target.matches("[data-clinic-backdrop]")) { state.modal = null; frameMarkup(); }
      return;
    }
    const action = actionNode.dataset.clinicAction;
    const id = actionNode.dataset.id;
    if (action === "patient-section") {
      state.patientDetailTab = actionNode.dataset.section;
      void loadPortal("patients");
    }
    if (action === "new-appointment" && canBookAppointment()) {
      state.modal = { type: "appointment" };
      frameMarkup();
      portalRoot()?.querySelector('[name="patient_search"]')?.focus();
    }
    if (action === "check-in" && (isReceptionist() || isNurse())) void appointmentMutation(id, "check-in");
    if (action === "start-walk-in" && isDoctor() && state.selectedPatient?.status === "active") {
      state.modal = {
        type: "start-visit",
        appointment: {
          id: "",
          patient_id: state.selectedPatient.id,
          patient_name: patientName(state.selectedPatient),
          patient_number: state.selectedPatient.patient_number,
        },
      };
      frameMarkup();
      portalRoot()?.querySelector('[name="chief_complaint"]')?.focus();
    }
    if (action === "start-visit" && can("visits")) {
      const appointment = state.appointments.find((item) => String(item.id) === String(id));
      if (appointment?.status === "checked_in") { state.modal = { type: "start-visit", appointment }; frameMarkup(); portalRoot()?.querySelector('[name="chief_complaint"]')?.focus(); }
    }
    if (action === "cancel-appointment" && (isAdmin() || isReceptionist() || isNurse())) {
      state.modal = { type: "confirm", title: "Cancel this appointment?", description: "The cancellation reason will be recorded with the appointment.", target: { type: "appointment-cancel", id } };
      frameMarkup();
    }
    if (action === "no-show" && isReceptionist()) void appointmentMutation(id, "no-show");
    if (action === "open-visit" && id) { state.tab = "visits"; state.selectedVisit = null; void loadVisitDetail(id); }
    if (action === "visit-back") { state.selectedVisit = null; state.selectedVisitId = null; void loadPortal("visits"); }
    if (action === "complete-visit" && isDoctor() && String(state.selectedVisit?.doctor_id) === String(staffId())) void completeVisit(id);
    if (action === "refer-visit" && isDoctor() && String(state.selectedVisit?.doctor_id) === String(staffId())) { state.modal = { type: "refer", id }; frameMarkup(); }
    if (action === "void-visit" && isAdmin() && String(state.selectedVisit?.id) === String(id)) {
      state.modal = { type: "confirm", title: "Void this clinical visit?", description: "The visit will be removed from active lists but retained in the audit history.", target: { type: "visit", id } };
      frameMarkup();
    }
    if (action === "patient-detail") void loadPatientDetail(id);
    if (action === "patient-back") {
      state.selectedPatientId = null;
      state.selectedPatient = null;
      if (role() === "pharmacist") { state.loading = false; state.error = ""; frameMarkup(); }
      else void loadPortal("patients");
    }
    if (action === "patient-lookup") void loadPatientDetail(id);
    if (action === "add-patient" && (isAdmin() || isReceptionist())) showModal("patient");
    if (action === "edit-patient" && (isAdmin() || isNurse() || isReceptionist())) showModal("patient", state.selectedPatient);
    if (action === "add-branch" && isAdmin()) showModal("branch");
    if (action === "edit-branch" && isAdmin()) showModal("branch", state.branches.find((item) => String(item.id) === String(id)));
    if (action === "add-staff" && isAdmin()) showModal("staff");
    if (action === "edit-staff" && isAdmin()) showModal("staff", state.staff.find((item) => String(item.id) === String(id)));
    if (action === "delete-patient" && isAdmin()) {
      state.modal = { type: "confirm", title: "Deactivate patient record?", description: "This will soft-deactivate the patient record. The record will no longer be active in the clinic." , target: { type: "patient", id } };
      frameMarkup();
    }
    if (action === "delete-branch" && isAdmin()) {
      state.modal = { type: "confirm", title: "Deactivate branch?", description: "This will deactivate the branch. Existing clinic records are retained.", target: { type: "branch", id } };
      frameMarkup();
    }
    if (action === "delete-staff" && isAdmin()) {
      state.modal = { type: "confirm", title: "Deactivate staff member?", description: "This will deactivate this staff account.", target: { type: "staff", id } };
      frameMarkup();
    }
    if (action === "close-modal") { state.modal = null; state.modalError = ""; frameMarkup(); }
    if (action === "confirm-delete" && state.modal?.target) void deactivate(state.modal.target.type, state.modal.target.id);
  }

  function handlePortalSubmit(event) {
    const form = event.target.closest("form[data-clinic-form]");
    if (!form) return;
    event.preventDefault();
    const type = form.dataset.clinicForm;
    if (["patient", "branch", "staff"].includes(type)) void submitRecordForm(form, type);
    if (type === "settings" || type === "organization-settings") void submitGeneralForm(form, type);
    if (type === "patient-search") void submitPatientSearch(form);
    if (type === "patient-lookup") void submitLookup(form);
    if (type === "appointment-filter") {
      state.appointmentFilters = { date: formValue(form,"date"), doctor_id: isDoctor() ? staffId() : formValue(form,"doctor_id") };
      void loadPortal("appointments");
    }
    if (type === "visit-filter") {
      state.visitFilters = { date: formValue(form,"date"), doctor_id: isDoctor() ? staffId() : formValue(form,"doctor_id"), status: formValue(form,"status") };
      void loadPortal("visits");
    }
    if (type === "appointment-create" && canBookAppointment()) void createAppointment(form);
    if (type === "visit-create" && can("visits")) void submitVisitCreate(form);
    if (type === "visit-edit" && isDoctor() && String(state.selectedVisit?.doctor_id) === String(staffId()) && state.selectedVisit?.status === "in_progress") void saveVisit(form);
    if (type === "visit-note" && (isDoctor() || isNurse()) && (!isDoctor() || String(state.selectedVisit?.doctor_id) === String(staffId()))) void addVisitNote(form);
    if (type === "visit-refer" && isDoctor()) void submitVisitRefer(form);
    if (type === "cancel-appointment" && state.modal?.target?.type === "appointment-cancel" && (isAdmin() || isReceptionist() || isNurse())) void appointmentMutation(state.modal.target.id, "cancel", { reason: formValue(form,"reason") });
  }

  function handlePortalRetry(event) {
    const retry = event.target.closest("[data-clinic-retry]")?.dataset.clinicRetry;
    if (!retry) return;
    if (retry === "patient-detail") {
      if (state.selectedPatientId) void loadPatientDetail(state.selectedPatientId);
      else { state.error = ""; frameMarkup(); }
    } else if (retry === "visit-detail" && state.selectedVisitId) void loadVisitDetail(state.selectedVisitId);
    else void loadPortal(retry);
  }

  function commandMarkup() {
    if (!commandHost) return;
    commandHost.innerHTML = `<section class="clinic-command-panel"><div class="clinic-shell">
      <div class="clinic-intro"><div><p class="clinic-eyebrow">APSHULE · Command Center</p><h1>Clinic organizations</h1><p>Organization coverage and secure clinic administrator provisioning.</p></div><button type="button" class="clinic-btn clinic-btn--quiet" data-cc-clinic-action="refresh">Refresh overview</button></div>
      ${state.command.loading ? `<section class="clinic-panel clinic-command-loading"><div class="clinic-skeleton"><span></span><span></span><span></span><span></span></div></section>` : state.command.error ? `<section class="clinic-panel">${stateMarkup("Clinic overview could not be loaded", state.command.error, true, "command")}</section>` : commandContent()}
      <div class="clinic-modal-slot">${commandModalMarkup()}</div>
    </div></section>`;
  }

  function commandContent() {
    const stats = state.command.stats || {};
    const measures = [["Organizations", stats.organizations ?? state.command.organizations.length], ["Branches", stats.branches ?? 0], ["Staff", stats.staff ?? 0], ["Patients", stats.patients ?? 0]];
    const orgs = state.command.organizations;
    return `<section class="clinic-metrics">${measures.map(([label, count]) => `<article class="clinic-metric"><span>${esc(label)}</span><strong>${esc(count)}</strong></article>`).join("")}</section>
      <div class="clinic-command-grid">
        <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Organization register</h2><p>Clinic organizations on APSHULE.</p></div><span class="clinic-status">${orgs.length} organizations</span></div>
          <div class="clinic-command-list">${orgs.length ? orgs.map((org) => `<article class="clinic-org-row"><div><strong>${text(org, "name")}</strong><span>${[org.city, org.district].filter(Boolean).map(esc).join(", ") || "Location not provided"} · ${esc(org.patient_count ?? 0)} patients · ${esc(org.branch_count ?? 0)} branches</span></div><span class="clinic-status">${dateLabel(org.created_at)}</span></article>`).join("") : `<div class="clinic-empty-note">No clinic organizations have been registered yet.</div>`}</div>
        </section>
        <section class="clinic-panel"><div class="clinic-section-head"><div><h2>Provision an organization</h2><p>Create the clinic and its first administrator.</p></div></div><button class="clinic-btn" type="button" data-cc-clinic-action="create">Create clinic organization</button></section>
      </div>`;
  }

  function commandModalMarkup() {
    if (!state.command.creating) return "";
    const fields = [
      ...ORG_FIELDS,
      ["admin_name", "Administrator name", "text", "required"],
      ["admin_email", "Administrator email", "email", "required"],
      ["admin_phone", "Administrator phone", "tel", ""],
      ["admin_password", "Administrator initial password", "password", "required"],
    ];
    return `<div class="clinic-modal-backdrop" data-cc-clinic-backdrop><section class="clinic-modal" role="dialog" aria-modal="true" aria-labelledby="ccClinicModalTitle"><div class="clinic-modal-head"><div><h2 id="ccClinicModalTitle">Create clinic organization</h2><p>Register the organization and its first clinic administrator.</p></div><button type="button" class="clinic-close" aria-label="Close" data-cc-clinic-action="close">×</button></div>
      <form class="clinic-modal-body clinic-form-grid" data-cc-clinic-form>
        ${state.command.formError ? `<div class="clinic-form-error clinic-span-2" role="alert">${esc(state.command.formError)}</div>` : ""}
        <div class="clinic-form-section">Organization identity</div>
        ${fields.slice(0, ORG_FIELDS.length).map(([name, label, type, flags]) => `<div class="clinic-field ${String(flags).includes("clinic-span-2") ? "clinic-span-2" : ""}"><label for="cc-clinic-${name}">${esc(label)}${String(flags).includes("required") ? " *" : ""}</label><input class="clinic-control" id="cc-clinic-${name}" name="${name}" type="${type}" value="${name === "brand_color" ? "#00897B" : ""}" ${String(flags).includes("required") ? "required" : ""}></div>`).join("")}
        <div class="clinic-field clinic-span-2"><label for="ccClinicLogo">Organization logo</label><input class="clinic-control" id="ccClinicLogo" type="file" name="logo" accept="image/jpeg,image/png,image/webp"><p class="clinic-help">JPEG, PNG, or WebP image.</p></div>
        <div class="clinic-form-section">First administrator</div>
        ${fields.slice(ORG_FIELDS.length).map(([name, label, type, flags]) => `<div class="clinic-field"><label for="cc-clinic-${name}">${esc(label)}${String(flags).includes("required") ? " *" : ""}</label><input class="clinic-control" id="cc-clinic-${name}" name="${name}" type="${type}" ${String(flags).includes("required") ? "required" : ""} ${type === "password" ? 'autocomplete="new-password" minlength="8"' : ""}></div>`).join("")}
        <div class="clinic-span-2 clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-cc-clinic-action="close">Cancel</button><button class="clinic-btn" type="submit" ${state.command.saving ? "disabled" : ""}>${state.command.saving ? "Creating…" : "Create organization"}</button></div>
      </form></section></div>`;
  }

  async function loadCommandCenter() {
    if (!commandHost) return;
    state.command.loading = true;
    state.command.error = "";
    commandMarkup();
    try {
      const [orgPayload, statsPayload] = await Promise.all([request("/api/clinic/organizations"), request("/api/clinic/stats")]);
      state.command.organizations = Array.isArray(orgPayload.organizations) ? orgPayload.organizations : [];
      state.command.stats = statsPayload.stats || {};
    } catch (error) {
      state.command.error = errorText(error);
    } finally {
      state.command.loading = false;
      commandMarkup();
    }
  }

  async function submitCommandForm(form) {
    state.command.saving = true;
    state.command.formError = "";
    commandMarkup();
    try {
      const body = {};
      for (const [name] of [...ORG_FIELDS, ["admin_name"], ["admin_email"], ["admin_phone"], ["admin_password"]]) {
        body[name] = formValue(form, name);
      }
      const logo = form.querySelector('input[name="logo"]')?.files?.[0];
      if (logo) body.logo_base64 = await imageData(logo);
      const result = await request("/api/clinic/organizations", { method: "POST", body });
      state.command.creating = false;
      state.command.saving = false;
      state.command.formError = "";
      announce(result.email_sent === false
        ? "Clinic organization created, but the welcome email could not be sent. Share the initial password with the administrator securely."
        : "Clinic organization created.");
      await loadCommandCenter();
    } catch (error) {
      state.command.formError = errorText(error);
      state.command.saving = false;
      commandMarkup();
    }
  }

  function handleCommandClick(event) {
    const actionNode = event.target.closest("[data-cc-clinic-action]");
    if (actionNode) {
      const action = actionNode.dataset.ccClinicAction;
      if (action === "refresh") void loadCommandCenter();
      if (action === "create") { state.command.creating = true; state.command.formError = ""; commandMarkup(); }
      if (action === "close") { state.command.creating = false; state.command.formError = ""; commandMarkup(); }
      return;
    }
    if (event.target.matches("[data-cc-clinic-backdrop]")) { state.command.creating = false; commandMarkup(); }
    const retry = event.target.closest("[data-clinic-retry]");
    if (retry?.dataset.clinicRetry === "command") void loadCommandCenter();
  }

  function handleCommandSubmit(event) {
    const form = event.target.closest("[data-cc-clinic-form]");
    if (!form) return;
    event.preventDefault();
    void submitCommandForm(form);
  }

  portalHost?.addEventListener("click", handlePortalClick);
  portalHost?.addEventListener("submit", handlePortalSubmit);
  portalHost?.addEventListener("click", handlePortalRetry);
  let patientSearchTimer = null;
  portalHost?.addEventListener("input", (event) => {
    if (event.target.matches('[name="patient_search"]')) {
      clearTimeout(patientSearchTimer);
      patientSearchTimer = setTimeout(() => void searchBookingPatients(event.target.value.trim()), 220);
    }
  });
  commandHost?.addEventListener("click", handleCommandClick);
  commandHost?.addEventListener("submit", handleCommandSubmit);

  async function setUser(user) {
    const previousUserId = state.user?.id;
    const previousRole = role();
    state.user = user || null;
    state.organization = null;
    state.tab = TABS.find(([key]) => can(key))?.[0] || "patients";
    state.selectedPatient = null;
    state.selectedPatientId = null;
    state.modal = null;
    state.modalError = "";
    state.saving = false;
    state.error = "";
    state.loading = false;
    if (!state.user || previousUserId !== state.user.id || previousRole !== role()) {
      state.patients = [];
      state.branches = [];
      state.staff = [];
      state.stats = null;
      state.today = null;
      state.appointments = [];
      state.visits = [];
      state.doctors = [];
      state.settings = null;
      state.search = "";
      state.branchFilter = "";
      state.patientStatus = "active";
      state.appointmentFilters = { date: "", doctor_id: "" };
      state.visitFilters = { date: "", doctor_id: "", status: "" };
      state.selectedVisit = null;
      state.selectedVisitId = null;
      state.visitNotes = [];
      state.patientDetailTab = "info";
      state.patientAppointments = [];
      state.patientVisits = [];
      state.bookingPatients = [];
      state.command = { organizations: [], stats: null, loading: false, error: "", creating: false, saving: false };
    }
    frameMarkup();
    if (state.user && can(state.tab)) await loadPortal(state.tab);
  }

  if (portalHost) {
    frameMarkup();
    if (state.user && can(state.tab)) {
      state.tab = TABS.find(([key]) => can(key))?.[0] || "patients";
      void loadPortal(state.tab);
    }
  }
  if (commandHost) commandMarkup();

  return { setUser, loadCommandCenter };
}

export default initClinicUI;
