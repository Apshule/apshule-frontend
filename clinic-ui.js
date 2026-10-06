const PHOTO_LIMIT = 200 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TABS = [
  ["overview", "Overview"],
  ["patients", "Patients"],
  ["branches", "Branches"],
  ["staff", "Staff"],
  ["settings", "Settings"],
];
const ROLE_TABS = {
  clinic_admin: new Set(["overview", "patients", "branches", "staff", "settings"]),
  doctor: new Set(["patients"]),
  nurse: new Set(["patients"]),
  receptionist: new Set(["patients", "branches"]),
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
    return Number.isNaN(date.getTime()) ? esc(value) : esc(new Intl.DateTimeFormat("en-UG", { day: "numeric", month: "short", year: "numeric" }).format(date));
  }
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
          <div class="clinic-brand"><div class="clinic-brand-mark" aria-hidden="true">A.</div><div><strong>${esc(brandName())}</strong><span>APSHULE · CLINIC WORKSPACE</span></div></div>
          <div class="clinic-user"><div class="clinic-avatar" aria-hidden="true">${esc(initials(userName()))}</div><div><strong>${esc(userName())}</strong><span>${esc(role().replaceAll("_", " ") || "clinic staff")}</span></div></div>
        </header>
        ${pharmacistLookup ? `<div class="clinic-intro"><div><p class="clinic-eyebrow">Clinic workspace</p><h1>Patient detail access</h1><p>Open an assigned patient profile using its record ID. Patient lists are not available to this role.</p></div></div>` : ""}
        ${allowed.length ? `<nav class="clinic-nav" aria-label="Clinic workspace">${allowed.map(([key, label]) => `<button type="button" data-clinic-tab="${key}" aria-current="${state.tab === key ? "page" : "false"}">${esc(label)}</button>`).join("")}</nav>` : ""}
        <main class="clinic-view">${pharmacistLookup ? lookupView() : portalView()}</main>
        <div class="clinic-modal-slot">${modalMarkup()}</div>
      </div>
    </section>`;
  }

  function intro(title, description, eyebrow = "Clinic workspace") {
    return `<div class="clinic-intro"><div><p class="clinic-eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p>${esc(description)}</p></div></div>`;
  }

  function portalView() {
    if (!state.user) return `${intro("Clinic workspace", "Sign in with a clinic account to view and manage records.")}<section class="clinic-panel">${stateMarkup("Clinic access required", "Your account does not have access to the clinic workspace.")}</section>`;
    if (!ROLE_TABS[role()]) return `${intro("Clinic workspace", "This account is not assigned to a supported clinic role.")}<section class="clinic-panel">${stateMarkup("Clinic access unavailable", "Ask a clinic administrator to confirm your role and organization access.")}</section>`;
    let title = "Clinic overview";
    let desc = "A clear view of your clinic's people, locations, and patient records.";
    if (state.tab === "patients") { title = "Patient records"; desc = "Find a patient record and review the details your role allows."; }
    if (state.tab === "branches") { title = "Branches"; desc = "View clinic locations and their contact details."; }
    if (state.tab === "staff") { title = "Clinic team"; desc = "Manage staff access, roles, and branch assignments."; }
    if (state.tab === "settings") { title = "Clinic settings"; desc = "Update organization identity and the clinic's operating defaults."; }
    return `${intro(title, desc)}${viewContent()}`;
  }

  function viewContent() {
    if (state.loading) return `<section class="clinic-panel"><div class="clinic-skeleton" aria-label="Loading"><span></span><span></span><span></span><span></span></div></section>`;
    if (state.error) return `<section class="clinic-panel">${stateMarkup("We could not load this view", errorText({ message: state.error }), true, state.selectedPatientId ? "patient-detail" : state.tab)}${state.selectedPatientId ? `<div class="clinic-actions"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="patient-back">Back to patient records</button></div>` : ""}</section>`;
    if (state.tab === "overview") return dashboard();
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
    const stats = state.stats || {};
    const metrics = [
      ["Patients", stats.patients ?? 0],
      ["Active patients", stats.active_patients ?? 0],
      ["Branches", stats.branches ?? 0],
      ["Team members", stats.staff ?? 0],
    ];
    return `<section class="clinic-metrics">${metrics.map(([label, count]) => `<article class="clinic-metric"><span>${esc(label)}</span><strong>${esc(count)}</strong></article>`).join("")}</section>
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
        <div class="clinic-actions">${canEdit ? `<button type="button" class="clinic-btn" data-clinic-action="edit-patient" data-id="${esc(patient.id)}">Edit record</button>` : ""}${isAdmin() ? `<button type="button" class="clinic-btn clinic-btn--danger" data-clinic-action="delete-patient" data-id="${esc(patient.id)}">Deactivate</button>` : ""}</div>
      </div>
      <div class="clinic-profile-layout"><article class="clinic-subpanel"><h3>Patient information</h3><div class="clinic-info-grid">${fields.map(([label, val]) => `<div class="clinic-info-item"><span>${esc(label)}</span><strong>${val == null || val === "" ? empty : esc(val)}</strong></div>`).join("")}</div></article>
        <aside class="clinic-subpanel"><h3>Other clinic services</h3><p class="clinic-help">These areas are not active in this release.</p><ul class="clinic-phase-list">
          <li><strong>Appointments</strong><span>Coming in phase 4B</span></li>
          <li><strong>Prescriptions</strong><span>Coming in phase 4B</span></li>
          <li><strong>Pharmacy</strong><span>Coming in phase 4C</span></li>
          <li><strong>Billing</strong><span>Coming in phase 4C</span></li>
        </ul></aside>
      </div>
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
    if (modal.type === "confirm") return `<div class="clinic-modal-backdrop" data-clinic-backdrop><section class="clinic-modal" role="dialog" aria-modal="true" aria-labelledby="clinicModalTitle"><div class="clinic-modal-head"><div><h2 id="clinicModalTitle">${esc(modal.title)}</h2><p>${esc(modal.description)}</p></div><button type="button" class="clinic-close" aria-label="Close" data-clinic-action="close-modal">×</button></div><div class="clinic-modal-foot"><button type="button" class="clinic-btn clinic-btn--quiet" data-clinic-action="close-modal">Cancel</button><button type="button" class="clinic-btn clinic-btn--danger" data-clinic-action="confirm-delete">Deactivate</button></div></section></div>`;
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
        const [statsPayload, branchesPayload] = await Promise.all([
          request("/api/clinic/stats"),
          request("/api/clinic/branches"),
        ]);
        state.stats = statsPayload.stats || {};
        state.branches = Array.isArray(branchesPayload.branches) ? branchesPayload.branches : [];
      } else if (tab === "patients") {
        if (state.selectedPatientId) {
          const payload = await request(`/api/clinic/patients/${encodeURIComponent(state.selectedPatientId)}`);
          state.selectedPatient = payload.patient || null;
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
    } catch (error) {
      state.error = errorText(error);
    } finally {
      state.loading = false;
      frameMarkup();
    }
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
    };
    try {
      await request(routes[type], { method: "DELETE" });
      state.modal = null;
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
  }

  function handlePortalRetry(event) {
    const retry = event.target.closest("[data-clinic-retry]")?.dataset.clinicRetry;
    if (!retry) return;
    if (retry === "patient-detail") {
      if (state.selectedPatientId) void loadPatientDetail(state.selectedPatientId);
      else { state.error = ""; frameMarkup(); }
    } else void loadPortal(retry);
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
  commandHost?.addEventListener("click", handleCommandClick);
  commandHost?.addEventListener("submit", handleCommandSubmit);

  async function setUser(user) {
    const previousUserId = state.user?.id;
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
    if (!state.user || previousUserId !== state.user.id) {
      state.patients = [];
      state.branches = [];
      state.staff = [];
      state.stats = null;
      state.settings = null;
      state.search = "";
      state.branchFilter = "";
      state.patientStatus = "active";
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
