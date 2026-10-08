const STRINGS = {
  cc_dashboard: "Dashboard", cc_users: "Users", cc_institutions: "Institutions",
  cc_analytics: "Analytics", cc_settings: "Settings", cc_command_center: "Command Center",
  cc_operator_space: "Platform operations", cc_dashboard_intro: "A live view across APSHULE sectors.",
  cc_active_users: "Users", cc_institutions_total: "Institutions", cc_revenue_30d: "Revenue · 30 days",
  cc_registered_accounts: "All registered accounts", cc_across_sectors: "Across education, MFI, clinic and farm",
  cc_successful_payments: "Successful payments", cc_api_worker: "API Worker", cc_database: "Database",
  cc_object_storage: "Object storage", cc_farm_ops: "Farm Ops", cc_ncdc_content: "Curriculum and standards",
  cc_institution: "Institution", cc_last_login: "Last login",
  cc_deployments_errors: "Deployment and error monitoring",
  cc_schools: "schools", cc_organizations: "organizations", cc_clinics: "clinics", cc_farms: "farms",
  cc_user_activated: "User activated.",
  cc_user_deactivated_note: "User marked inactive and current sessions revoked. Sign-in policy was left unchanged.",
  cc_scheduled_date_prompt: "Optional deletion date/time (YYYY-MM-DDTHH:mm). Leave blank to allow completion now.",
  cc_danger_zone: "Danger zone",
  cc_purge_browser_cache: "Purge this browser's AppShule cache",
  cc_purge_cache_warning: "This clears cached app files on this browser. Offline access may be unavailable until the app is loaded online again.",
  cc_reset_stats_unavailable: "Resetting stats is unavailable because dashboard totals are calculated from operational records; resetting them would delete source data.",
  cc_reset_stats: "Reset stats",
  cc_cache_cleared: "Cached app files cleared. Reloading the app.",
  cc_active_sessions: "Active sessions", cc_not_tracked: "Not tracked", cc_health: "System health",
  cc_recent_activity: "Recent activity", cc_sector_snapshots: "Sector snapshots",
  cc_open_legacy: "Open existing sector tools", cc_refresh: "Refresh", cc_search: "Search",
  cc_add_user: "Add user", cc_all_roles: "All roles", cc_all_sectors: "All sectors",
  cc_all_statuses: "All statuses", cc_name: "Name", cc_email: "Email", cc_role: "Role",
  cc_sector: "Sector", cc_status: "Status", cc_actions: "Actions", cc_active: "Active",
  cc_inactive: "Inactive", cc_save: "Save changes", cc_cancel: "Cancel", cc_phone: "Phone",
  cc_reset_password: "Request password reset", cc_request_deletion: "Request deletion",
  cc_deactivate: "Deactivate", cc_activate: "Activate", cc_impersonate: "View as user",
  cc_no_users: "No users match these filters.", cc_previous: "Previous", cc_next: "Next",
  cc_search_institutions: "Search institutions", cc_edit_institution: "Edit institution",
  cc_branding: "Institution branding", cc_suspended: "Suspended", cc_reactivate: "Reactivate",
  cc_suspend: "Suspend", cc_institution_status_note: "Administrative status only; existing sector sign-in and access are unchanged.",
  cc_members: "Members", cc_view_as: "View as", cc_no_institutions: "No institutions found.",
  cc_from: "From", cc_to: "To", cc_export_csv: "Export CSV", cc_users_trend: "User growth",
  cc_by_sector: "Users by sector", cc_top_actions: "Top actions", cc_time_activity: "Activity by hour",
  cc_platform_settings: "Platform settings", cc_roles_permissions: "Roles and permissions",
  cc_audit_log: "Audit log", cc_privacy_center: "Privacy and PDPO", cc_announcements: "Announcements",
  cc_communications: "Communications", cc_default_language: "Default language",
  cc_timezone: "Timezone", cc_session_timeout: "Session timeout (minutes)",
  cc_password_minimum: "Password minimum length", cc_require_two_factor: "Require two-factor authentication",
  cc_backup_reminder: "Backup reminder (days)", cc_settings_saved: "Settings saved.",
  cc_saved_but_not_enforced: "Saved setting; enforcement is not configured by this feature.",
  cc_permission_read: "Read Command Center", cc_permission_manage: "Manage Command Center",
  cc_granted: "Granted", cc_denied: "Not granted", cc_save_permissions: "Save permissions",
  cc_audit_filter: "Filter by action", cc_all: "All", cc_consents: "Consent records",
  cc_deletion_requests: "Deletion requests", cc_export_user: "Export user data",
  cc_pending: "Pending", cc_approve: "Approve", cc_reject: "Reject", cc_complete: "Complete",
  cc_admin_notes: "Administrator notes", cc_scheduled_for: "Scheduled for (optional)",
  cc_user_id: "User ID", cc_type: "Type", cc_version: "Version", cc_consented_at: "Recorded at",
  cc_ip: "IP address", cc_user_agent: "User agent", cc_reason: "Reason",
  cc_no_requests: "No deletion requests found.", cc_new_announcement: "Create announcement",
  cc_title: "Title", cc_message: "Message", cc_target: "Audience", cc_severity: "Severity",
  cc_create_announcement: "Publish announcement", cc_global: "All users", cc_in_app: "In-app",
  cc_email_broadcast: "Email broadcast", cc_subject: "Subject", cc_send_email: "Send email",
  cc_send_in_app: "Create in-app announcement", cc_recipients: "Recipients",
  cc_urgent: "Urgent", cc_warning: "Warning", cc_info: "Information",
  cc_no_activity: "No recent activity.", cc_loading: "Loading…", cc_error: "Could not load data.",
  cc_consent_title: "Review and accept our policies", cc_consent_intro: "Please review the current Terms of Service and Privacy Policy to continue.",
  cc_terms_accept: "I agree to the Terms of Service.", cc_privacy_accept: "I acknowledge the Privacy Policy.",
  cc_terms: "Terms of Service", cc_privacy: "Privacy Policy", cc_accept_continue: "Accept and continue",
  cc_sign_out: "Sign out", cc_announcement_dismiss: "Dismiss", cc_no_data: "No data available.",
  cc_education: "Education", cc_ncdc: "NCDC", cc_mfi: "Microfinance", cc_clinic: "Clinic",
  cc_farm: "Farm", cc_student: "Students", cc_teacher: "Teachers", cc_customers: "Customers",
  cc_loans: "Loans", cc_patients: "Patients", cc_visits: "Visits", cc_animals: "Animals",
  cc_workers: "Workers", cc_open_details: "Open details", cc_update: "Update",
  cc_email_target: "Target group", cc_announcement_target: "Announcement audience",
  cc_confirm_delete: "Create a PDPO deletion request for this user? No profile data will be removed unless an authorized admin completes the request.",
  cc_role_saved: "Permissions saved.", cc_request_created: "Deletion request submitted.",
};

const ROLE_OPTIONS = [
  "superadmin", "school", "teacher", "individual", "parent", "clinic_admin", "doctor",
  "nurse", "receptionist", "pharmacist", "patient", "mfi_admin", "loan_officer",
  "loan_manager", "loan_director", "borrower", "farm_admin", "farm_manager", "farm_worker",
];
const SECTOR_OPTIONS = ["education", "ncdc", "mfi", "clinic", "farm"];
const SECTOR_KEYS = {
  education: "cc_education", ncdc: "cc_ncdc", mfi: "cc_mfi", clinic: "cc_clinic", farm: "cc_farm",
  farm_ops: "cc_farm_ops",
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/gu, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const fmt = (value) => Number(value ?? 0).toLocaleString();
const dateText = (value) => value ? new Date(value).toLocaleString() : "—";
const safeImageSrc = (value) => {
  if (typeof value !== "string") return null;
  if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/iu.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; }
  catch { return null; }
};
const statusPill = (value) => `<span class="cc6-status ${esc(String(value || "pending").toLowerCase())}">${esc(value || "pending")}</span>`;
const optionList = (items, selected = "") => items.map((item) => {
  const value = typeof item === "string" ? item : item.value;
  const label = typeof item === "string" ? item : item.label;
  return `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
}).join("");

export function initCommandCenterUI({ apiBase, getToken, getUser, notify, activateSectorPanel, startImpersonation }) {
  const commandCenter = document.getElementById("commandCenter");
  if (!commandCenter) return { setUser: () => {} };

  const root = document.createElement("div");
  root.id = "ccPhase6c";
  root.innerHTML = `
    <header class="cc6-head">
      <div><div class="cc6-eyebrow" data-i18n="cc_operator_space"></div><h1 data-i18n="cc_command_center"></h1><p data-i18n="cc_dashboard_intro"></p></div>
      <span class="cc6-head-status">Command access</span>
    </header>
    <nav class="cc6-tabs" role="tablist" aria-label="Command Center sections">
      <button class="cc6-tab" role="tab" aria-selected="true" data-cc6-tab="dashboard" data-i18n="cc_dashboard"></button>
      <button class="cc6-tab" role="tab" aria-selected="false" data-cc6-tab="users" data-i18n="cc_users"></button>
      <button class="cc6-tab" role="tab" aria-selected="false" data-cc6-tab="institutions" data-i18n="cc_institutions"></button>
      <button class="cc6-tab" role="tab" aria-selected="false" data-cc6-tab="analytics" data-i18n="cc_analytics"></button>
      <button class="cc6-tab" role="tab" aria-selected="false" data-cc6-tab="settings" data-i18n="cc_settings"></button>
    </nav>
    <section class="cc6-view" id="cc6-dashboard" role="tabpanel">
      <div class="cc6-grid" id="cc6Metrics"></div>
      <div class="cc6-grid-2">
        <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_health"></h3></div><div class="cc6-panel-body" id="cc6Health"></div></section>
        <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_recent_activity"></h3><button class="cc6-button secondary small" data-refresh="overview" data-i18n="cc_refresh"></button></div><div class="cc6-panel-body" id="cc6Activity"></div></section>
      </div>
      <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_sector_snapshots"></h3><button class="cc6-button secondary small" data-open-legacy="true" data-i18n="cc_open_legacy"></button></div><div class="cc6-panel-body"><div class="cc6-snapshot-list" id="cc6Snapshots"></div></div></section>
      <details class="cc6-legacy"><summary data-i18n="cc_open_legacy"></summary><div id="cc6LegacyContent"></div></details>
    </section>
    <section class="cc6-view" id="cc6-users" role="tabpanel" hidden>
      <div class="cc6-section-head"><div><h2 data-i18n="cc_users"></h2><p id="cc6UserStats"></p></div><button class="cc6-button" data-action="new-user" data-i18n="cc_add_user"></button></div>
      <form id="cc6UserFilters" class="cc6-toolbar">
        <input class="cc6-field" name="search" aria-label="Search users" data-i18n-placeholder="cc_search" style="max-width:250px">
        <select class="cc6-select" name="role" aria-label="Filter role" style="max-width:180px"></select>
        <select class="cc6-select" name="sector" aria-label="Filter sector" style="max-width:170px"></select>
        <select class="cc6-select" name="status" aria-label="Filter status" style="max-width:150px"></select>
        <button class="cc6-button secondary" type="submit" data-i18n="cc_search"></button>
      </form>
      <section class="cc6-panel"><div class="cc6-panel-body cc6-table-wrap" id="cc6UsersTable"></div></section>
      <div class="cc6-toolbar"><button class="cc6-button secondary small" data-page="-1" data-i18n="cc_previous"></button><span id="cc6UserPage"></span><button class="cc6-button secondary small" data-page="1" data-i18n="cc_next"></button></div>
    </section>
    <section class="cc6-view" id="cc6-institutions" role="tabpanel" hidden>
      <div class="cc6-section-head"><div><h2 data-i18n="cc_institutions"></h2><p data-i18n="cc_institution_status_note"></p></div></div>
      <form id="cc6InstitutionFilters" class="cc6-toolbar">
        <input class="cc6-field" name="search" aria-label="Search institutions" data-i18n-placeholder="cc_search" style="max-width:260px">
        <select class="cc6-select" name="sector" aria-label="Filter sector" style="max-width:200px"></select>
        <select class="cc6-select" name="setup_sector" aria-label="Choose sector for institution setup" style="max-width:200px"></select>
        <button class="cc6-button secondary" type="button" data-institution-setup="true">Add institution</button>
        <button class="cc6-button secondary" type="submit" data-i18n="cc_search"></button>
      </form>
      <div class="cc6-grid" id="cc6InstitutionsList"></div>
    </section>
    <section class="cc6-view" id="cc6-analytics" role="tabpanel" hidden>
      <div class="cc6-section-head"><div><h2 data-i18n="cc_analytics"></h2><p>Includes released and closed farm sales in revenue calculations.</p></div></div>
      <form id="cc6AnalyticsFilters" class="cc6-toolbar">
        <label class="cc6-label"><span data-i18n="cc_from"></span><input type="date" class="cc6-field" name="from"></label>
        <label class="cc6-label"><span data-i18n="cc_to"></span><input type="date" class="cc6-field" name="to"></label>
        <button class="cc6-button" type="submit" data-i18n="cc_refresh"></button>
        <button class="cc6-button secondary" type="button" data-export="analytics" data-i18n="cc_export_csv"></button>
      </form>
      <div class="cc6-grid" id="cc6AnalyticsMetrics"></div>
      <div class="cc6-grid-2">
        <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_users_trend"></h3></div><div class="cc6-panel-body" id="cc6Trend"></div></section>
        <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_by_sector"></h3></div><div class="cc6-panel-body" id="cc6BySector"></div></section>
        <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_top_actions"></h3></div><div class="cc6-panel-body" id="cc6TopActions"></div></section>
        <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_time_activity"></h3></div><div class="cc6-panel-body" id="cc6Hourly"></div></section>
      </div>
    </section>
    <section class="cc6-view" id="cc6-settings" role="tabpanel" hidden>
      <div class="cc6-section-head"><div><h2 data-i18n="cc_settings"></h2><p data-i18n="cc_saved_but_not_enforced"></p></div></div>
      <nav class="cc6-tabs" aria-label="Settings sections">
        <button class="cc6-tab" aria-selected="true" data-ops-tab="platform" data-i18n="cc_platform_settings"></button>
        <button class="cc6-tab" aria-selected="false" data-ops-tab="roles" data-i18n="cc_roles_permissions"></button>
        <button class="cc6-tab" aria-selected="false" data-ops-tab="audit" data-i18n="cc_audit_log"></button>
        <button class="cc6-tab" aria-selected="false" data-ops-tab="privacy" data-i18n="cc_privacy_center"></button>
        <button class="cc6-tab" aria-selected="false" data-ops-tab="announcements" data-i18n="cc_announcements"></button>
      </nav>
      <div data-ops-view="platform">
        <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_platform_settings"></h3></div><div class="cc6-panel-body" id="cc6PlatformSettings"></div></section>
      </div>
      <div data-ops-view="roles" hidden><section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_roles_permissions"></h3></div><div class="cc6-panel-body" id="cc6Roles"></div></section></div>
      <div data-ops-view="audit" hidden>
        <form id="cc6AuditFilters" class="cc6-toolbar"><input class="cc6-field" name="actor_id" placeholder="Actor ID"><input class="cc6-field" name="sector" placeholder="Sector"><input class="cc6-field" name="action" data-i18n-placeholder="cc_audit_filter"><input class="cc6-field" type="date" name="from"><input class="cc6-field" type="date" name="to"><button class="cc6-button secondary" type="submit" data-i18n="cc_search"></button><button class="cc6-button secondary" type="button" data-export="audit" data-i18n="cc_export_csv"></button></form>
        <section class="cc6-panel"><div class="cc6-panel-body cc6-table-wrap" id="cc6Audit"></div></section>
      </div>
      <div data-ops-view="privacy" hidden>
        <div class="cc6-toolbar"><button class="cc6-button secondary small" data-privacy-tab="consents" data-i18n="cc_consents"></button><button class="cc6-button secondary small" data-privacy-tab="deletions" data-i18n="cc_deletion_requests"></button></div>
        <div id="cc6ConsentsPane"><form id="cc6ConsentFilters" class="cc6-toolbar"><input class="cc6-field" name="user_id" data-i18n-placeholder="cc_user_id" style="max-width:320px"><button class="cc6-button secondary" type="submit" data-i18n="cc_search"></button></form><section class="cc6-panel"><div class="cc6-panel-body cc6-table-wrap" id="cc6Consents"></div></section></div>
        <div id="cc6DeletionsPane" hidden><form id="cc6DeletionFilters" class="cc6-toolbar"><select name="status" class="cc6-select" style="max-width:200px"></select><button class="cc6-button secondary" type="submit" data-i18n="cc_search"></button></form><section class="cc6-panel"><div class="cc6-panel-body cc6-table-wrap" id="cc6DeletionRequests"></div></section></div>
        <form id="cc6ExportUserForm" class="cc6-toolbar"><input name="user_id" class="cc6-field" data-i18n-placeholder="cc_user_id" required style="max-width:320px"><button class="cc6-button secondary" type="submit" data-i18n="cc_export_user"></button></form>
      </div>
      <div data-ops-view="announcements" hidden>
        <div class="cc6-grid-2">
          <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_new_announcement"></h3></div><div class="cc6-panel-body" id="cc6AnnouncementForm"></div></section>
          <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_communications"></h3></div><div class="cc6-panel-body" id="cc6CommunicationsForm"></div></section>
        </div>
        <section class="cc6-panel"><div class="cc6-panel-head"><h3 data-i18n="cc_announcements"></h3></div><div class="cc6-panel-body cc6-table-wrap" id="cc6Announcements"></div></section>
      </div>
    </section>
    <dialog class="cc6-dialog" id="cc6Dialog"><div id="cc6DialogContent"></div></dialog>
  `;
  commandCenter.prepend(root);

  const legacyHost = root.querySelector("#cc6LegacyContent");
  const legacyHeading = commandCenter.querySelector(":scope > .cc-heading");
  const legacyTabs = commandCenter.querySelector(":scope > .cc-tabs");
  if (legacyHeading) legacyHost.append(legacyHeading);
  if (legacyTabs) legacyHost.append(legacyTabs);
  for (const panel of [...commandCenter.querySelectorAll(":scope > .cc-view")]) legacyHost.append(panel);

  const state = { userPage: 1, userQuery: "", users: [], institutions: [], strings: {}, settings: {}, analytics: null };
  const lang = () => {
    try { return localStorage.getItem("apshule_language") || localStorage.getItem("language") || "en"; }
    catch { return "en"; }
  };
  const t = (key) => state.strings[key] || STRINGS[key] || key;
  const api = async (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    const token = getToken?.();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(`${apiBase}${path}`, {
      ...options, headers,
      body: options.body !== undefined && !(options.body instanceof FormData) && typeof options.body !== "string"
        ? JSON.stringify(options.body) : options.body,
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(data?.message || data?.error || `Request failed (${response.status})`);
    return data;
  };
  const showError = (error) => notify?.(error?.message || t("cc_error"), "error");
  const applyI18n = () => {
    for (const element of root.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
    for (const element of root.querySelectorAll("[data-i18n-placeholder]")) element.placeholder = t(element.dataset.i18nPlaceholder);
  };
  const loadTranslations = async () => {
    try {
      const result = await api(`/api/settings/i18n/strings?lang=${encodeURIComponent(lang())}`);
      state.strings = { ...result, ...state.strings };
    } catch { /* English strings remain available offline. */ }
    applyI18n();
  };
  const openDialog = (html) => {
    root.querySelector("#cc6DialogContent").innerHTML = html;
    const dialog = root.querySelector("#cc6Dialog");
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
  };
  const closeDialog = () => {
    const dialog = root.querySelector("#cc6Dialog");
    if (dialog.close) dialog.close();
    else dialog.removeAttribute("open");
  };
  const dialogFrame = (title, body) => `<div class="cc6-dialog-head"><h3>${esc(title)}</h3><button type="button" class="cc6-close" data-dialog-close aria-label="Close">&times;</button></div><div class="cc6-dialog-body">${body}</div>`;
  const table = (headers, rows) => `<div class="cc6-table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows || ""}</tbody></table></div>`;
  const setTab = async (name) => {
    for (const btn of root.querySelectorAll("[data-cc6-tab]")) btn.setAttribute("aria-selected", String(btn.dataset.cc6Tab === name));
    for (const panel of root.querySelectorAll(".cc6-view")) panel.hidden = panel.id !== `cc6-${name}`;
    if (name === "dashboard") await loadOverview();
    if (name === "users") await loadUsers();
    if (name === "institutions") await loadInstitutions();
    if (name === "analytics") await loadAnalytics();
    if (name === "settings") await loadSettings();
  };
  const setOpsTab = async (name) => {
    for (const btn of root.querySelectorAll("[data-ops-tab]")) btn.setAttribute("aria-selected", String(btn.dataset.opsTab === name));
    for (const panel of root.querySelectorAll("[data-ops-view]")) panel.hidden = panel.dataset.opsView !== name;
    if (name === "platform") await loadSettings();
    if (name === "roles") await loadRoles();
    if (name === "audit") await loadAudit();
    if (name === "privacy") await loadConsents();
    if (name === "announcements") await loadAnnouncements();
  };

  async function loadOverview() {
    const target = root.querySelector("#cc6Metrics");
    target.innerHTML = `<div class="cc6-card">${esc(t("cc_loading"))}</div>`;
    try {
      const data = await api("/api/cc/overview");
      const totals = data.totals || {};
      target.innerHTML = [
        [t("cc_active_users"), fmt(totals.users), t("cc_registered_accounts")],
        [t("cc_institutions_total"), fmt(totals.institutions), t("cc_across_sectors")],
        [t("cc_revenue_30d"), fmt(totals.revenue_30d), t("cc_successful_payments")],
        [t("cc_active_sessions"), t("cc_not_tracked"), t("cc_not_tracked")],
      ].map(([label, value, note]) => `<article class="cc6-card"><div class="cc6-metric-label">${esc(label)}</div><div class="cc6-metric-value">${esc(value)}</div><div class="cc6-metric-note">${esc(note)}</div></article>`).join("");
      const health = data.health || {};
      root.querySelector("#cc6Health").innerHTML = [
        [t("cc_api_worker"), health.worker_ok], [t("cc_database"), health.db_ok], [t("cc_object_storage"), health.r2_ok],
      ].map(([label, ok]) => `<div class="cc6-list-row"><span>${esc(label)}</span>${statusPill(ok ? "available" : "not_configured")}</div>`).join("")
        + `<div class="cc6-list-row"><span>${esc(t("cc_deployments_errors"))}</span>${statusPill(t("cc_not_tracked"))}</div>`
        + (data.alerts || []).map((alert) => `<div class="cc6-alert ${esc(alert.type)}"><span>${esc(alert.message)}</span><strong>${fmt(alert.count)}</strong></div>`).join("");
      const activity = data.recent_activity || [];
      root.querySelector("#cc6Activity").innerHTML = activity.length ? activity.slice(0, 8).map((entry) =>
        `<div class="cc6-list-row"><div><strong>${esc(entry.action)}</strong><small>${esc(entry.actor_email || "System")} · ${esc(entry.target_table || "")}</small></div><small>${esc(dateText(entry.created_at))}</small></div>`).join("")
        : `<div class="cc6-empty">${esc(t("cc_no_activity"))}</div>`;
      const snapshots = data.snapshots || {};
      root.querySelector("#cc6Snapshots").innerHTML = [
        ["education", `${fmt(totals.by_sector?.education)} ${t("cc_schools")} · ${fmt(snapshots.education?.students)} ${t("cc_student")} · ${fmt(snapshots.education?.teachers)} ${t("cc_teacher")}`],
        ["ncdc", t("cc_ncdc_content")],
        ["mfi", `${fmt(totals.by_sector?.mfi)} ${t("cc_organizations")} · ${fmt(snapshots.mfi?.customers)} ${t("cc_customers")} · ${fmt(snapshots.mfi?.loans)} ${t("cc_loans")}`],
        ["clinic", `${fmt(totals.by_sector?.clinic)} ${t("cc_clinics")} · ${fmt(snapshots.clinic?.patients)} ${t("cc_patients")} · ${fmt(snapshots.clinic?.visits)} ${t("cc_visits")}`],
        ["farm", `${fmt(totals.by_sector?.farm)} ${t("cc_farms")} · ${fmt(snapshots.farm?.animals)} ${t("cc_animals")} · ${fmt(snapshots.farm?.workers)} ${t("cc_workers")}`],
        ["farm_ops", `${fmt(snapshots.farm?.workers)} ${t("cc_workers")} · ${t("cc_open_legacy")}`],
      ].map(([sector, note]) => `<button class="cc6-snapshot" type="button" data-sector-panel="${esc(sector === "farm_ops" ? "farm" : sector)}"><strong>${esc(t(SECTOR_KEYS[sector]))}</strong><span>${esc(note)}</span></button>`).join("");
    } catch (error) { target.innerHTML = `<div class="cc6-empty">${esc(error.message)}</div>`; }
  }

  async function loadUsers() {
    const form = root.querySelector("#cc6UserFilters");
    const filters = new FormData(form);
    const query = new URLSearchParams({ page: String(state.userPage), limit: "50" });
    for (const key of ["search", "role", "sector", "status"]) if (filters.get(key)) query.set(key, filters.get(key));
    const target = root.querySelector("#cc6UsersTable");
    target.innerHTML = `<div class="cc6-empty">${esc(t("cc_loading"))}</div>`;
    try {
      const data = await api(`/api/cc/users?${query}`);
      state.users = data.users || [];
      const stats = data.stats || {};
      const byRole = (stats.by_role || []).map((row) => `${row.role}: ${fmt(row.count)}`).join(" · ");
      root.querySelector("#cc6UserStats").textContent = `${fmt(stats.total)} total · ${fmt(stats.active)} ${t("cc_active").toLowerCase()} · ${fmt(stats.inactive)} ${t("cc_inactive").toLowerCase()}${byRole ? ` · ${byRole}` : ""}`;
      root.querySelector("#cc6UserPage").textContent = `Page ${data.page || 1}`;
      const rows = state.users.map((user) => `<tr>
        <td><button class="cc6-click" type="button" data-user-detail="${esc(user.id)}">${esc(user.name)}</button></td>
        <td>${esc(user.email)}</td><td>${esc(user.role)}</td><td>${esc(user.sector || "—")}</td>
        <td>${esc(user.institution_name || "—")}</td><td>${esc(dateText(user.last_login))}</td>
        <td>${statusPill(user.is_active ? "active" : "inactive")}</td>
        <td><button class="cc6-button secondary small" data-user-detail="${esc(user.id)}">${esc(t("cc_open_details"))}</button></td>
      </tr>`).join("");
      target.innerHTML = state.users.length ? table([t("cc_name"), t("cc_email"), t("cc_role"), t("cc_sector"), t("cc_institution"), t("cc_last_login"), t("cc_status"), t("cc_actions")], rows)
        : `<div class="cc6-empty">${esc(t("cc_no_users"))}</div>`;
    } catch (error) { target.innerHTML = `<div class="cc6-empty">${esc(error.message)}</div>`; }
  }

  function initFilters() {
    const roleItems = [{ value: "", label: t("cc_all_roles") }, ...ROLE_OPTIONS.map((value) => ({ value, label: value }))];
    const sectorItems = [{ value: "", label: t("cc_all_sectors") }, ...SECTOR_OPTIONS.map((value) => ({ value, label: t(SECTOR_KEYS[value] || value) }))];
    const statusItems = [{ value: "", label: t("cc_all_statuses") }, { value: "active", label: t("cc_active") }, { value: "inactive", label: t("cc_inactive") }];
    root.querySelector('#cc6UserFilters [name="role"]').innerHTML = optionList(roleItems);
    root.querySelector('#cc6UserFilters [name="sector"]').innerHTML = optionList(sectorItems);
    root.querySelector('#cc6UserFilters [name="status"]').innerHTML = optionList(statusItems);
    root.querySelector('#cc6InstitutionFilters [name="sector"]').innerHTML = optionList([{ value: "", label: t("cc_all_sectors") }, ...SECTOR_OPTIONS.map((value) => ({ value, label: t(SECTOR_KEYS[value] || value) }))]);
    root.querySelector('#cc6InstitutionFilters [name="setup_sector"]').innerHTML = optionList(SECTOR_OPTIONS.filter((sector) => sector !== "ncdc").map((value) => ({ value, label: t(SECTOR_KEYS[value]) })));
    root.querySelector('#cc6DeletionFilters [name="status"]').innerHTML = optionList([{ value: "", label: t("cc_all") }, "pending", "approved", "rejected", "completed"].map((x) => typeof x === "string" ? { value: x, label: x } : x));
  }

  function userDialog(user) {
    const target = user || {};
    const isNew = !target.id;
    const form = `<form data-form="${isNew ? "user-create" : "user-edit"}" data-id="${esc(target.id)}">
      <div class="cc6-form-grid">
        <label class="cc6-label">${esc(t("cc_name"))}<input class="cc6-field" name="name" maxlength="120" required value="${esc(target.name)}"></label>
        <label class="cc6-label">${esc(t("cc_email"))}<input class="cc6-field" type="email" name="email" maxlength="254" required value="${esc(target.email)}"></label>
        <label class="cc6-label">${esc(t("cc_phone"))}<input class="cc6-field" name="phone" maxlength="40" value="${esc(target.phone)}"></label>
        <label class="cc6-label">${esc(t("cc_role"))}<select class="cc6-select" name="role" required>${optionList(ROLE_OPTIONS, target.role || "individual")}</select></label>
        <label class="cc6-label">${esc(t("cc_sector"))}<select class="cc6-select" name="sector" required>${optionList(SECTOR_OPTIONS, target.sector || "education")}</select></label>
      </div><p class="cc6-hint">${isNew ? "The user will receive an email to set a password." : "Deactivation revokes active sessions. Account deletion requires an approved PDPO request."}</p>
      <div class="cc6-toolbar"><button class="cc6-button" type="submit">${esc(isNew ? t("cc_add_user") : t("cc_save"))}</button>${!isNew ? `<button class="cc6-button secondary" type="button" data-user-action="reset" data-id="${esc(target.id)}">${esc(t("cc_reset_password"))}</button>` : ""}</div>
    </form>`;
    openDialog(dialogFrame(isNew ? t("cc_add_user") : t("cc_users"), form));
  }

  function openUserDetail(user) {
    const actions = `<div class="cc6-toolbar">
      <button class="cc6-button secondary" data-user-action="edit" data-id="${esc(user.id)}">${esc(t("cc_update"))}</button>
      <button class="cc6-button secondary" data-user-action="impersonate" data-id="${esc(user.id)}">${esc(t("cc_impersonate"))}</button>
      <button class="cc6-button secondary" data-user-action="${user.is_active ? "deactivate" : "activate"}" data-id="${esc(user.id)}">${esc(user.is_active ? t("cc_deactivate") : t("cc_activate"))}</button>
      <button class="cc6-button secondary" data-user-action="reset" data-id="${esc(user.id)}">${esc(t("cc_reset_password"))}</button>
      <button class="cc6-button danger" data-user-action="delete" data-id="${esc(user.id)}">${esc(t("cc_request_deletion"))}</button>
    </div><div class="cc6-panel"><div class="cc6-panel-head"><h3>Recent account activity</h3></div><div class="cc6-panel-body" id="cc6UserActivity">${esc(t("cc_loading"))}</div></div>`;
    openDialog(dialogFrame(user.name, `<p>${esc(user.email)} · ${esc(user.role)} · ${esc(user.sector || "—")} · ${user.is_active ? t("cc_active") : t("cc_inactive")}</p>${actions}`));
    api(`/api/cc/users/${encodeURIComponent(user.id)}/activity`).then((data) => {
      const element = root.querySelector("#cc6UserActivity");
      if (element) element.innerHTML = (data.activity || []).map((entry) => `<div class="cc6-list-row"><strong>${esc(entry.action)}</strong><small>${esc(dateText(entry.created_at))}</small></div>`).join("") || `<div class="cc6-empty">${esc(t("cc_no_activity"))}</div>`;
    }).catch((error) => { const element = root.querySelector("#cc6UserActivity"); if (element) element.textContent = error.message; });
  }

  async function loadInstitutions() {
    const filters = new FormData(root.querySelector("#cc6InstitutionFilters"));
    const query = new URLSearchParams();
    if (filters.get("sector")) query.set("sector", filters.get("sector"));
    if (filters.get("search")) query.set("search", filters.get("search"));
    const target = root.querySelector("#cc6InstitutionsList");
    target.innerHTML = `<div class="cc6-empty">${esc(t("cc_loading"))}</div>`;
    try {
      const data = await api(`/api/cc/institutions?${query}`);
      state.institutions = data.institutions || [];
      target.innerHTML = state.institutions.length ? state.institutions.map((institution) => {
        const status = institution.status || "active";
        const logo = institution.logo_base64 ? `<img alt="" src="${esc(institution.logo_base64)}" style="height:38px;width:38px;object-fit:contain;border-radius:8px">` : "";
        return `<article class="cc6-card"><div class="cc6-list-row">${logo}<strong>${esc(institution.name)}</strong>${statusPill(status)}</div><p class="cc6-metric-note">${esc(t(SECTOR_KEYS[institution.sector] || institution.sector))} · ${fmt(institution.user_count)} users<br>Created ${esc(dateText(institution.created_at))}</p><button class="cc6-button secondary small" data-institution="${esc(institution.sector)}:${esc(institution.id)}">${esc(t("cc_open_details"))}</button></article>`;
      }).join("") : `<div class="cc6-empty">${esc(t("cc_no_institutions"))}</div>`;
    } catch (error) { target.innerHTML = `<div class="cc6-empty">${esc(error.message)}</div>`; }
  }

  async function openInstitution(sector, id) {
    try {
      const data = await api(`/api/cc/institutions/${encodeURIComponent(sector)}/${encodeURIComponent(id)}`);
      const institution = data.institution || {};
      const branding = data.branding || {};
      const members = data.members || [];
      const statsData = await api(`/api/cc/institutions/${encodeURIComponent(sector)}/${encodeURIComponent(id)}/stats`);
      const stats = statsData.stats || {};
      const statsMarkup = Object.entries(stats).map(([key, value]) => `<div class="cc6-list-row"><span>${esc(key.replaceAll("_", " "))}</span><strong>${fmt(value)}</strong></div>`).join("");
      const memberMarkup = members.map((member) => `<div class="cc6-list-row"><span>${esc(member.name)} <small>${esc(member.email)} · ${esc(member.role)}</small></span><button class="cc6-button secondary small" data-user-action="impersonate" data-id="${esc(member.id)}" data-user-payload="${esc(JSON.stringify(member))}">${esc(t("cc_view_as"))}</button></div>`).join("");
      const body = `<p>${esc(t("cc_institution_status_note"))}</p><div class="cc6-toolbar">${data.status === "suspended" ? `<button class="cc6-button success" data-inst-action="reactivate" data-sector="${esc(sector)}" data-id="${esc(id)}">${esc(t("cc_reactivate"))}</button>` : `<button class="cc6-button danger" data-inst-action="suspend" data-sector="${esc(sector)}" data-id="${esc(id)}">${esc(t("cc_suspend"))}</button>`}</div>
        <h4>${esc(t("cc_edit_institution"))}</h4><form data-form="institution-edit" data-sector="${esc(sector)}" data-id="${esc(id)}"><div class="cc6-form-grid">
        ${["name", "email", "phone", "address", "website"].map((key) => `<label class="cc6-label">${esc(key)}<input class="cc6-field" name="${key}" value="${esc(institution[key])}"></label>`).join("")}
        <label class="cc6-label">Brand colour<input class="cc6-field" name="brand_color" value="${esc(institution.brand_color || "")}" placeholder="#4b2e9e"></label>
        <label class="cc6-label wide">Institution logo<input class="cc6-field" type="file" name="logo_file" accept="image/png,image/jpeg,image/webp"><small>PNG, JPEG or WebP; max 300 KB. Saved in the institution record.</small></label>
        <label class="cc6-label wide">Display name<input class="cc6-field" name="display_name" value="${esc(branding.display_name || "")}"></label>
        <label class="cc6-label">Dual-logo header<select class="cc6-select" name="dual_logo_enabled">${optionList([{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }], String(branding.dual_logo_enabled === true))}</select></label>
        <label class="cc6-label">APSHULE logo position<select class="cc6-select" name="appshule_logo_position">${optionList([{ value: "left", label: "Left" }, { value: "right", label: "Right" }], branding.appshule_logo_position || "right")}</select></label>
        <label class="cc6-label">APSHULE logo size<input class="cc6-field" type="number" name="appshule_logo_size" min="16" max="120" value="${esc(branding.appshule_logo_size || 32)}"></label>
        <label class="cc6-label">Institution logo size<input class="cc6-field" type="number" name="institution_logo_size" min="16" max="120" value="${esc(branding.institution_logo_size || 40)}"></label>
        <label class="cc6-label">Header background<input class="cc6-field" name="header_bg_color" value="${esc(branding.header_bg_color || "")}" placeholder="#4b2e9e"></label>
        <label class="cc6-label">Header text color<input class="cc6-field" name="header_text_color" value="${esc(branding.header_text_color || "#FFFFFF")}" placeholder="#FFFFFF"></label>
        <label class="cc6-label"><input type="checkbox" name="show_appshule_name" ${branding.show_appshule_name !== false ? "checked" : ""}> Show APSHULE name</label>
        <label class="cc6-label"><input type="checkbox" name="show_institution_name" ${branding.show_institution_name !== false ? "checked" : ""}> Show institution name</label>
        </div><button class="cc6-button" type="submit">${esc(t("cc_save"))}</button></form>
        <section class="cc6-panel"><div class="cc6-panel-head"><h3>Institution statistics</h3></div><div class="cc6-panel-body">${statsMarkup || "No statistics available."}</div></section>
        <section class="cc6-panel"><div class="cc6-panel-head"><h3>${esc(t("cc_members"))}</h3></div><div class="cc6-panel-body">${memberMarkup || "No linked users found."}</div></section>`;
      openDialog(dialogFrame(institution.name || "Institution", body));
    } catch (error) { showError(error); }
  }

  async function loadAnalytics() {
    const form = root.querySelector("#cc6AnalyticsFilters");
    const params = new URLSearchParams();
    const from = form.elements.from.value;
    const to = form.elements.to.value;
    if (from) params.set("from", `${from}T00:00:00Z`);
    if (to) params.set("to", `${to}T23:59:59Z`);
    try {
      const data = await api(`/api/cc/analytics?${params}`);
      state.analytics = { from, to, data };
      root.querySelector("#cc6AnalyticsMetrics").innerHTML = [
        [t("cc_active_users"), fmt(data.users?.total)], ["Added in period", fmt(data.users?.added)],
        ["Payment volume", fmt((data.revenue || []).reduce((sum, row) => sum + Number(row.total || 0), 0))],
      ].map(([label, value]) => `<article class="cc6-card"><div class="cc6-metric-label">${esc(label)}</div><div class="cc6-metric-value">${esc(value)}</div></article>`).join("");
      const trend = data.trends || [];
      const maxTrend = Math.max(1, ...trend.map((row) => Number(row.users || 0)));
      root.querySelector("#cc6Trend").innerHTML = trend.length ? `<div class="cc6-two-col-list">${trend.map((row) => `<div class="cc6-list-row"><span>${esc(String(row.day).slice(0, 10))}</span><div style="min-width:60%;max-width:70%"><div class="cc6-meter"><i style="width:${Math.min(100, Number(row.users || 0) / maxTrend * 100)}%"></i></div></div><strong>${fmt(row.users)}</strong></div>`).join("")}</div>` : `<div class="cc6-empty">${esc(t("cc_no_data"))}</div>`;
      root.querySelector("#cc6BySector").innerHTML = (data.by_sector || []).map((row) => `<div class="cc6-list-row"><span>${esc(row.sector || "unassigned")}</span><strong>${fmt(row.users)}</strong></div>`).join("") || `<div class="cc6-empty">${esc(t("cc_no_data"))}</div>`;
      root.querySelector("#cc6TopActions").innerHTML = (data.top_actions || []).map((row) => `<div class="cc6-list-row"><span>${esc(row.action)}</span><strong>${fmt(row.count)}</strong></div>`).join("") || `<div class="cc6-empty">${esc(t("cc_no_data"))}</div>`;
      root.querySelector("#cc6Hourly").innerHTML = (data.activity || []).map((row) => `<div class="cc6-list-row"><span>${String(row.hour).padStart(2, "0")}:00</span><strong>${fmt(row.count)}</strong></div>`).join("") || `<div class="cc6-empty">${esc(t("cc_no_data"))}</div>`;
      const chart = (id, type, labels, values, label, colors) => {
        const Chart = globalThis.Chart;
        const container = root.querySelector(`#${id}`);
        if (!container || !Chart) return;
        state.charts ||= {};
        state.charts[id]?.destroy?.();
        container.innerHTML = `<canvas aria-label="${esc(label)}" role="img"></canvas>`;
        state.charts[id] = new Chart(container.querySelector("canvas"), {
          type,
          data: { labels, datasets: [{ label, data: values, backgroundColor: colors, borderColor: "#4b2e9e", borderWidth: type === "line" ? 2 : 1, tension: .28, fill: type === "line" }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: type === "doughnut" } }, scales: type === "doughnut" ? {} : { y: { beginAtZero: true, ticks: { precision: 0 } } } },
        });
        container.style.height = "250px";
      };
      chart("cc6Trend", "line", trend.map((row) => String(row.day).slice(0, 10)), trend.map((row) => Number(row.users || 0)), t("cc_users_trend"), "#4b2e9e");
      const sectorRevenue = data.revenue_by_sector || [];
      chart("cc6BySector", "bar", sectorRevenue.map((row) => row.sector || "unassigned"), sectorRevenue.map((row) => Number(row.total || 0)), t("cc_by_sector"), "#20a27b");
      const actions = data.top_actions || [];
      chart("cc6TopActions", "doughnut", actions.map((row) => row.action), actions.map((row) => Number(row.count || 0)), t("cc_top_actions"), actions.map((_, i) => ["#4b2e9e", "#20a27b", "#f2a65a", "#4f8fbd", "#c95d63", "#8d79c5"][i % 6]));
      const hourly = data.activity || [];
      const hourCounts = new Map(hourly.map((row) => [Number(row.hour), Number(row.count || 0)]));
      const peakHour = Math.max(1, ...hourCounts.values());
      root.querySelector("#cc6Hourly").innerHTML = `<div class="cc6-heatmap" role="img" aria-label="${esc(t("cc_time_activity"))}">${Array.from({ length: 24 }, (_, hour) => {
        const count = hourCounts.get(hour) || 0;
        const opacity = count ? .12 + .78 * count / peakHour : .05;
        return `<div class="cc6-heatmap-cell" title="${String(hour).padStart(2, "0")}:00 · ${fmt(count)}"><strong>${String(hour).padStart(2, "0")}</strong><small>${fmt(count)}</small><i style="display:block;border-radius:3px;height:4px;background:rgba(75,46,158,${opacity})"></i></div>`;
      }).join("")}</div>`;
    } catch (error) { showError(error); }
  }

  async function loadSettings() {
    try {
      const data = await api("/api/cc/settings");
      state.settings = data.settings || {};
      const s = state.settings;
      root.querySelector("#cc6PlatformSettings").innerHTML = `<form data-form="settings"><div class="cc6-form-grid">
        <label class="cc6-label">${esc(t("cc_default_language"))}<select class="cc6-select" name="default_language">${optionList(["en", "lg", "nyn", "nyo", "ach", "xog", "sw"], s.default_language || "en")}</select></label>
        <label class="cc6-label">${esc(t("cc_timezone"))}<input class="cc6-field" name="timezone" value="${esc(s.timezone || "Africa/Kampala")}"></label>
        <label class="cc6-label">${esc(t("cc_session_timeout"))}<input class="cc6-field" type="number" min="5" max="1440" name="session_timeout_minutes" value="${esc(s.session_timeout_minutes || 60)}"></label>
        <label class="cc6-label">${esc(t("cc_password_minimum"))}<input class="cc6-field" type="number" min="8" max="128" name="password_min_length" value="${esc(s.password_min_length || 8)}"></label>
        <label class="cc6-label">${esc(t("cc_backup_reminder"))}<input class="cc6-field" type="number" min="1" max="365" name="backup_reminder_days" value="${esc(s.backup_reminder_days || 30)}"></label>
        <label class="cc6-label"><span>${esc(t("cc_require_two_factor"))}</span><select class="cc6-select" name="require_two_factor">${optionList([{ value: "false", label: "No" }, { value: "true", label: "Yes" }], String(Boolean(s.require_two_factor)))}</select></label>
        </div><p class="cc6-hint">${esc(t("cc_saved_but_not_enforced"))} ${esc(t("cc_active_sessions"))}: ${esc(data.active_sessions || t("cc_not_tracked"))}.</p><button class="cc6-button" type="submit">${esc(t("cc_save"))}</button></form>`;
      root.querySelector("#cc6PlatformSettings").insertAdjacentHTML("beforeend", `<section class="cc6-danger-zone"><h3>${esc(t("cc_danger_zone"))}</h3><p>${esc(t("cc_purge_cache_warning"))}</p><button class="cc6-button danger" type="button" data-danger-action="purge-cache">${esc(t("cc_purge_browser_cache"))}</button><button class="cc6-button danger" type="button" disabled title="${esc(t("cc_reset_stats_unavailable"))}">${esc(t("cc_reset_stats"))}</button><p class="cc6-hint">${esc(t("cc_reset_stats_unavailable"))}</p></section>`);
    } catch (error) { root.querySelector("#cc6PlatformSettings").textContent = error.message; }
  }

  async function loadRoles() {
    const target = root.querySelector("#cc6Roles");
    try {
      const data = await api("/api/cc/security/roles");
      const permissionRows = Array.isArray(data.permissions) ? data.permissions
        : Object.entries(data.roles || {}).flatMap(([role, rows]) => rows.map((row) => ({ ...row, role })));
      const roles = [...new Set([...ROLE_OPTIONS, ...permissionRows.map((r) => r.role).filter(Boolean)])];
      target.innerHTML = table([t("cc_role"), t("cc_permission_read"), t("cc_permission_manage"), t("cc_actions")], roles.map((role) => {
        const current = permissionRows.filter((row) => row.role === role);
        const read = current.some((row) => row.permission === "cc.read" || row.permission === "*");
        const manage = current.some((row) => row.permission === "cc.manage" || row.permission === "*");
        return `<tr><td>${esc(role)}</td><td><input type="checkbox" data-role-permission="cc.read" data-role="${esc(role)}" ${read ? "checked" : ""}></td><td><input type="checkbox" data-role-permission="cc.manage" data-role="${esc(role)}" ${manage ? "checked" : ""}></td><td><button class="cc6-button secondary small" data-save-role="${esc(role)}">${esc(t("cc_save_permissions"))}</button></td></tr>`;
      }).join(""));
    } catch (error) { target.textContent = error.message; }
  }

  async function loadAudit() {
    const query = new URLSearchParams();
    for (const key of ["actor_id", "sector", "action", "from", "to"]) {
      const value = root.querySelector(`#cc6AuditFilters [name="${key}"]`)?.value;
      if (value) query.set(key, ["from", "to"].includes(key) ? `${value}${key === "from" ? "T00:00:00Z" : "T23:59:59Z"}` : value);
    }
    try {
      const data = await api(`/api/cc/security/audit?${query}`);
      const rows = data.entries || [];
      root.querySelector("#cc6Audit").innerHTML = table(["Date", "Actor", t("cc_role"), "Action", t("cc_type"), t("cc_user_id"), "Result", "IP"], rows.map((row) =>
        `<tr><td>${esc(dateText(row.created_at))}</td><td>${esc(row.actor_email || row.actor_id || "System")}</td><td>${esc(row.actor_role || "—")}</td><td>${esc(row.action)}</td><td>${esc(row.target_table || "—")}</td><td>${esc(row.target_id || "—")}</td><td>${esc(row.result || "success")}</td><td>${esc(row.ip || "—")}</td></tr>`).join(""));
    } catch (error) { root.querySelector("#cc6Audit").textContent = error.message; }
  }

  async function loadConsents() {
    const userId = root.querySelector('#cc6ConsentFilters [name="user_id"]').value;
    const query = new URLSearchParams();
    if (userId) query.set("user_id", userId);
    try {
      const data = await api(`/api/cc/pdpo/consents?${query}`);
      const rows = data.consents || [];
      root.querySelector("#cc6Consents").innerHTML = table([t("cc_name"), t("cc_user_id"), t("cc_type"), t("cc_version"), t("cc_consented_at"), t("cc_ip"), t("cc_user_agent")], rows.map((row) =>
        `<tr><td>${esc(row.name || row.email || "Deleted user")}</td><td>${esc(row.user_id)}</td><td>${esc(row.consent_type)}</td><td>${esc(row.version)}</td><td>${esc(dateText(row.consented_at))}</td><td>${esc(row.ip || "—")}</td><td title="${esc(row.user_agent)}">${esc(row.user_agent || "—")}</td></tr>`).join(""));
    } catch (error) { root.querySelector("#cc6Consents").textContent = error.message; }
  }

  async function loadDeletionRequests() {
    const status = root.querySelector('#cc6DeletionFilters [name="status"]').value;
    const query = new URLSearchParams();
    if (status) query.set("status", status);
    try {
      const data = await api(`/api/cc/pdpo/deletion-requests?${query}`);
      const rows = data.requests || [];
      root.querySelector("#cc6DeletionRequests").innerHTML = rows.length ? table([t("cc_name"), t("cc_email"), t("cc_reason"), t("cc_status"), "Created", t("cc_actions")], rows.map((row) => {
        const action = row.status === "pending"
          ? `<button class="cc6-button success small" data-deletion-action="approved" data-id="${esc(row.id)}">${esc(t("cc_approve"))}</button><button class="cc6-button danger small" data-deletion-action="rejected" data-id="${esc(row.id)}">${esc(t("cc_reject"))}</button>`
          : row.status === "approved" ? `<button class="cc6-button danger small" data-deletion-action="completed" data-id="${esc(row.id)}">${esc(t("cc_complete"))}</button>` : "";
        return `<tr><td>${esc(row.name || "Deleted user")}</td><td>${esc(row.user_email)}</td><td>${esc(row.reason || "—")}</td><td>${statusPill(row.status)}</td><td>${esc(dateText(row.created_at))}</td><td>${action}</td></tr>`;
      }).join("")) : `<div class="cc6-empty">${esc(t("cc_no_requests"))}</div>`;
    } catch (error) { root.querySelector("#cc6DeletionRequests").textContent = error.message; }
  }

  async function loadAnnouncements() {
    try {
      const data = await api("/api/cc/announcements");
      const rows = data.announcements || [];
      root.querySelector("#cc6Announcements").innerHTML = table([t("cc_title"), t("cc_message"), t("cc_target"), t("cc_severity"), "Active", t("cc_actions")], rows.map((row) =>
        `<tr><td>${esc(row.title)}</td><td>${esc(String(row.body || "").slice(0, 140))}</td><td>${esc(row.target_type)}${row.target_sector ? ` · ${esc(row.target_sector)}` : ""}</td><td>${statusPill(row.severity)}</td><td>${row.active ? "Yes" : "No"}</td><td><button class="cc6-button secondary small" data-announcement-toggle="${esc(row.id)}" data-active="${String(!row.active)}">${row.active ? "Archive" : "Activate"}</button></td></tr>`).join(""));
      root.querySelector("#cc6AnnouncementForm").innerHTML = `<form data-form="announcement"><div class="cc6-form-grid">
        <label class="cc6-label">${esc(t("cc_title"))}<input class="cc6-field" name="title" maxlength="160" required></label>
        <label class="cc6-label">${esc(t("cc_severity"))}<select class="cc6-select" name="severity">${optionList([{ value: "info", label: t("cc_info") }, { value: "warning", label: t("cc_warning") }, { value: "urgent", label: t("cc_urgent") }])}</select></label>
        <label class="cc6-label">${esc(t("cc_target"))}<select class="cc6-select" name="target_type">${optionList([{ value: "global", label: t("cc_global") }, { value: "sector", label: t("cc_sector") }, { value: "role", label: t("cc_role") }, { value: "institution", label: "Institution" }])}</select></label>
        <label class="cc6-label">${esc(t("cc_sector"))}<select class="cc6-select" name="target_sector">${optionList(SECTOR_OPTIONS)}</select></label>
        <label class="cc6-label">${esc(t("cc_role"))}<select class="cc6-select" name="target_role">${optionList(ROLE_OPTIONS)}</select></label>
        <label class="cc6-label wide">${esc(t("cc_message"))}<textarea class="cc6-textarea" name="body" maxlength="5000" required></textarea></label>
        <label class="cc6-label wide">Institution ID (for institution audience)<input class="cc6-field" name="target_institution_id"></label>
        <label class="cc6-label">Starts at<input class="cc6-field" type="datetime-local" name="starts_at"></label>
        <label class="cc6-label">Ends at<input class="cc6-field" type="datetime-local" name="ends_at"></label>
        <label class="cc6-label"><input type="checkbox" name="send_email"> Send email</label>
        <label class="cc6-label"><input type="checkbox" name="send_in_app" checked> Send in-app</label>
        </div><button class="cc6-button" type="submit">${esc(t("cc_create_announcement"))}</button></form>`;
      root.querySelector("#cc6CommunicationsForm").innerHTML = `<form data-form="communication"><div class="cc6-form-grid">
        <label class="cc6-label">${esc(t("cc_email_target"))}<select class="cc6-select" name="target_type">${optionList([{ value: "global", label: t("cc_global") }, { value: "sector", label: t("cc_sector") }, { value: "role", label: t("cc_role") }, { value: "institution", label: "Institution" }])}</select></label>
        <label class="cc6-label">${esc(t("cc_sector"))}<select class="cc6-select" name="sector">${optionList(SECTOR_OPTIONS)}</select></label>
        <label class="cc6-label">${esc(t("cc_role"))}<select class="cc6-select" name="role">${optionList(ROLE_OPTIONS)}</select></label>
        <label class="cc6-label">${esc(t("cc_subject"))}<input class="cc6-field" name="subject" maxlength="200" required></label>
        <label class="cc6-label wide">${esc(t("cc_message"))}<textarea class="cc6-textarea" name="message" maxlength="10000" required></textarea></label>
        <label class="cc6-label wide">Institution ID (if applicable)<input class="cc6-field" name="institution_id"></label>
        <label class="cc6-label wide"><input type="checkbox" name="also_in_app"> Also publish as an in-app announcement</label>
        </div><button class="cc6-button" type="submit">${esc(t("cc_send_email"))}</button></form>`;
    } catch (error) { root.querySelector("#cc6Announcements").textContent = error.message; }
  }

  async function downloadCsv(path, filename) {
    try {
      const token = getToken?.();
      const response = await fetch(`${apiBase}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) { showError(error); }
  }

  async function downloadJson(path, filename) {
    try {
      const token = getToken?.();
      const response = await fetch(`${apiBase}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const json = await response.json();
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) { showError(error); }
  }

  function installConsentDialog() {
    if (document.getElementById("ccPhase6c-consent")) return;
    const overlay = document.createElement("div");
    overlay.id = "ccPhase6c-consent";
    overlay.hidden = true;
    overlay.innerHTML = `<section class="cc6-consent-box" role="dialog" aria-modal="true" aria-labelledby="cc6-consent-title">
      <h2 id="cc6-consent-title">${esc(t("cc_consent_title"))}</h2><p>${esc(t("cc_consent_intro"))}</p>
      <label><input type="checkbox" id="cc6AcceptTerms"><span>${esc(t("cc_terms_accept"))} <a href="https://appshule.com/terms.html" target="_blank" rel="noopener">${esc(t("cc_terms"))}</a></span></label>
      <label><input type="checkbox" id="cc6AcceptPrivacy"><span>${esc(t("cc_privacy_accept"))} <a href="https://appshule.com/privacy.html" target="_blank" rel="noopener">${esc(t("cc_privacy"))}</a></span></label>
      <div class="cc6-consent-actions"><button type="button" data-consent-signout>${esc(t("cc_sign_out"))}</button><button type="button" class="accept" data-consent-accept>${esc(t("cc_accept_continue"))}</button></div>
    </section>`;
    document.body.append(overlay);
    overlay.addEventListener("click", async (event) => {
      if (event.target.closest("[data-consent-signout]")) document.getElementById("logoutBtn")?.click();
      if (event.target.closest("[data-consent-accept]")) {
        const tosAccepted = overlay.querySelector("#cc6AcceptTerms").checked;
        const privacyAccepted = overlay.querySelector("#cc6AcceptPrivacy").checked;
        if (!tosAccepted || !privacyAccepted) { notify?.("Please accept both policies to continue.", "error"); return; }
        try {
          await api("/api/consent/accept", { method: "POST", body: { tosAccepted, privacyAccepted } });
          overlay.hidden = true; document.body.classList.remove("cc6-consent-required");
          notify?.("Consent recorded.", "success");
        } catch (error) { showError(error); }
      }
    });
  }

  async function loadUserSurface(user) {
    if (!user) {
      document.getElementById("ccPhase6c-consent")?.setAttribute("hidden", "");
      document.body.classList.remove("cc6-consent-required");
      root.querySelector("#ccPhase6c-brandmark")?.remove();
      document.getElementById("cc6AnnouncementBanner")?.remove();
      return;
    }
    try {
      const data = await api("/api/consent/status");
      installConsentDialog();
      const overlay = document.getElementById("ccPhase6c-consent");
      overlay.hidden = !data.required;
      document.body.classList.toggle("cc6-consent-required", Boolean(data.required));
    } catch (error) { console.error("Consent status unavailable", error); }
    try {
      const [announcementData, brandData] = await Promise.all([
        api("/api/announcements/active"), api("/api/consent/branding/current"),
      ]);
      const bannerData = announcementData.announcements?.[0];
      if (bannerData) {
        let banner = document.getElementById("cc6AnnouncementBanner");
        if (!banner) {
          banner = document.createElement("aside");
          banner.id = "cc6AnnouncementBanner";
          banner.className = "cc6-announcement";
          document.querySelector("#appScreen .header")?.after(banner);
        }
        if (banner) {
          banner.className = `cc6-announcement severity-${["info", "warning", "urgent"].includes(bannerData.severity) ? bannerData.severity : "info"}`;
          banner.innerHTML = `<strong>${esc(bannerData.title)}</strong><p>${esc(bannerData.body)}</p><button class="cc6-button secondary small" data-dismiss-announcement="${esc(bannerData.id)}">${esc(t("cc_announcement_dismiss"))}</button>`;
        }
      } else document.getElementById("cc6AnnouncementBanner")?.remove();
      const brand = brandData.branding;
      if (brand?.institution_name) {
        const headerLeft = document.querySelector("#appScreen .header-left");
        if (headerLeft) {
          let mark = document.getElementById("ccPhase6c-brandmark");
          if (!mark) { mark = document.createElement("div"); mark.id = "ccPhase6c-brandmark"; headerLeft.append(mark); }
          const institutionLogo = safeImageSrc(brand.logo);
          const institutionSize = Math.max(16, Math.min(120, Number(brand.institution_logo_size) || 40));
          const appshuleSize = Math.max(16, Math.min(120, Number(brand.appshule_logo_size) || 32));
          const logo = institutionLogo ? `<img src="${esc(institutionLogo)}" alt="" style="width:${institutionSize}px;height:${institutionSize}px">` : "";
          mark.innerHTML = `${logo}${brand.show_institution_name === false ? "" : `<span>${esc(brand.display_name || brand.institution_name)}</span>`}`;
          const appLogo = headerLeft.querySelector(".header-logo-img");
          const appName = headerLeft.querySelector(".app-title");
          if (appLogo) { appLogo.style.width = `${appshuleSize}px`; appLogo.style.height = `${appshuleSize}px`; }
          if (appName) appName.hidden = brand.show_appshule_name === false;
          if (brand.appshule_logo_position === "left") headerLeft.insertBefore(mark, appLogo || headerLeft.firstChild);
          else headerLeft.append(mark);
          if (brand.header_bg_color && /^#[0-9a-f]{6}$/iu.test(brand.header_bg_color)) document.querySelector("#appScreen .header").style.backgroundColor = brand.header_bg_color;
          if (brand.header_text_color && /^#[0-9a-f]{6}$/iu.test(brand.header_text_color)) document.querySelector("#appScreen .header").style.color = brand.header_text_color;
          if (brand.brand_color && /^#[0-9a-f]{6}$/iu.test(brand.brand_color)) document.documentElement.style.setProperty("--institution-brand-color", brand.brand_color);
        }
      } else {
        document.getElementById("ccPhase6c-brandmark")?.remove();
        const appLogo = document.querySelector("#appScreen .header-logo-img");
        const appName = document.querySelector("#appScreen .app-title");
        const header = document.querySelector("#appScreen .header");
        if (appLogo) { appLogo.style.width = ""; appLogo.style.height = ""; }
        if (appName) appName.hidden = false;
        if (header) { header.style.backgroundColor = ""; header.style.color = ""; }
      }
    } catch (error) { console.error("User announcements or branding unavailable", error); }
  }

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.dataset.cc6Tab) { await setTab(button.dataset.cc6Tab); return; }
      if (button.dataset.opsTab) { await setOpsTab(button.dataset.opsTab); return; }
      if (button.dataset.privacyTab) {
        const deleting = button.dataset.privacyTab === "deletions";
        root.querySelector("#cc6ConsentsPane").hidden = deleting;
        root.querySelector("#cc6DeletionsPane").hidden = !deleting;
        if (deleting) await loadDeletionRequests(); else await loadConsents();
        return;
      }
      if (button.hasAttribute("data-dialog-close")) { closeDialog(); return; }
      if (button.dataset.refresh === "overview") { await loadOverview(); return; }
      if (button.dataset.sectorPanel) { activateSectorPanel?.(button.dataset.sectorPanel); return; }
      if (button.dataset.openLegacy) { root.querySelector(".cc6-legacy").open = true; root.querySelector(".cc6-legacy").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      if (button.dataset.dangerAction === "purge-cache") {
        if (!confirm(t("cc_purge_cache_warning"))) return;
        if (!("caches" in window)) throw new Error("This browser does not support the Cache API.");
        const names = (await window.caches.keys()).filter((name) => /^apshule-cache-/u.test(name));
        await Promise.all(names.map((name) => window.caches.delete(name)));
        notify?.(t("cc_cache_cleared"), "success");
        setTimeout(() => location.reload(), 250);
        return;
      }
      if (button.dataset.action === "new-user") { userDialog(null); return; }
      if (button.dataset.page) { state.userPage = Math.max(1, state.userPage + Number(button.dataset.page)); await loadUsers(); return; }
      if (button.dataset.userDetail) {
        const user = state.users.find((row) => row.id === button.dataset.userDetail);
        if (user) openUserDetail(user);
        return;
      }
      if (button.dataset.userAction) {
        const id = button.dataset.id;
        const user = state.users.find((row) => row.id === id);
        if (button.dataset.userAction === "edit") { if (user) userDialog(user); return; }
        if (button.dataset.userAction === "delete") {
          if (!confirm(t("cc_confirm_delete"))) return;
          await api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
          notify?.(t("cc_request_created"), "success"); closeDialog(); await loadUsers(); return;
        }
        if (button.dataset.userAction === "impersonate") {
          const impersonatedUser = user || JSON.parse(button.dataset.userPayload || "null");
          if (!impersonatedUser) throw new Error("The selected user could not be loaded.");
          if (startImpersonation) { await startImpersonation(impersonatedUser); return; }
          throw new Error("User impersonation is unavailable.");
        }
        if (button.dataset.userAction === "reset") {
          await api(`/api/cc/users/${encodeURIComponent(id)}`, { method: "PATCH", body: { reset_password: true } });
          notify?.("Password reset instructions sent.", "success"); return;
        }
        const activate = button.dataset.userAction === "activate";
        await api(`/api/cc/users/${encodeURIComponent(id)}/${activate ? "activate" : "deactivate"}`, { method: "POST" });
        notify?.(activate ? t("cc_user_activated") : t("cc_user_deactivated_note"), "success");
        closeDialog(); await loadUsers(); return;
      }
      if (button.dataset.institution) {
        const [sector, id] = button.dataset.institution.split(":");
        await openInstitution(sector, id); return;
      }
      if (button.dataset.institutionSetup) {
        const sector = root.querySelector('#cc6InstitutionFilters [name="setup_sector"]').value || "education";
        root.querySelector(".cc6-legacy").open = true;
        activateSectorPanel?.(sector);
        root.querySelector(".cc6-legacy").scrollIntoView({ behavior: "smooth", block: "start" });
        notify?.(`Opened the existing ${t(SECTOR_KEYS[sector] || sector)} setup tools.`, "success");
        return;
      }
      if (button.dataset.instAction) {
        await api(`/api/cc/institutions/${button.dataset.sector}/${button.dataset.id}/${button.dataset.instAction}`, { method: "POST" });
        notify?.("Institution status updated. This records administrative status only; it does not block sector sign-in.", "success");
        await openInstitution(button.dataset.sector, button.dataset.id); await loadInstitutions(); return;
      }
      if (button.dataset.saveRole) {
        const role = button.dataset.saveRole;
        const permissions = [...root.querySelectorAll("input[data-role-permission]")]
          .filter((input) => input.dataset.role === role)
          .map((input) => ({ permission: input.dataset.rolePermission, granted: input.checked }));
        await api(`/api/cc/security/roles/${encodeURIComponent(role)}`, { method: "PATCH", body: { permissions } });
        notify?.(t("cc_role_saved"), "success"); await loadRoles(); return;
      }
      if (button.dataset.deletionAction) {
        const status = button.dataset.deletionAction;
        let extra = {};
        if (status === "approved" || status === "rejected") {
          const notes = prompt(t("cc_admin_notes"), "");
          if (notes === null) return;
          extra = { admin_notes: notes };
          if (status === "approved") {
            const scheduledFor = prompt(t("cc_scheduled_date_prompt"), "");
            if (scheduledFor === null) return;
            if (scheduledFor) extra.scheduled_for = new Date(scheduledFor).toISOString();
          }
        } else if (!confirm("This permanently anonymizes direct profile identifiers. Sector records are retained.")) return;
        await api(`/api/cc/pdpo/deletion-requests/${encodeURIComponent(button.dataset.id)}`, { method: "PATCH", body: { status, ...extra } });
        notify?.("Deletion request updated.", "success"); await loadDeletionRequests(); return;
      }
      if (button.dataset.export === "analytics") {
        const query = new URLSearchParams();
        if (state.analytics?.from) query.set("from", `${state.analytics.from}T00:00:00Z`);
        if (state.analytics?.to) query.set("to", `${state.analytics.to}T23:59:59Z`);
        await downloadCsv(`/api/cc/analytics/export?${query}`, "apshule-analytics.csv"); return;
      }
      if (button.dataset.export === "audit") { await downloadCsv("/api/cc/security/audit/export", "apshule-audit.csv"); return; }
      if (button.dataset.announcementToggle) {
        await api(`/api/cc/announcements/${encodeURIComponent(button.dataset.announcementToggle)}`, {
          method: "PATCH", body: { active: button.dataset.active === "true" },
        });
        await loadAnnouncements(); return;
      }
      if (button.dataset.dismissAnnouncement) {
        await api(`/api/announcements/${encodeURIComponent(button.dataset.dismissAnnouncement)}/dismiss`, { method: "POST", body: {} });
        document.getElementById("cc6AnnouncementBanner")?.remove(); return;
      }
    } catch (error) { showError(error); }
  });

  root.addEventListener("submit", async (event) => {
    const form = event.target.closest("form");
    if (!form) return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      if (form.id === "cc6UserFilters") { state.userPage = 1; await loadUsers(); return; }
      if (form.id === "cc6InstitutionFilters") { await loadInstitutions(); return; }
      if (form.id === "cc6AnalyticsFilters") { await loadAnalytics(); return; }
      if (form.id === "cc6AuditFilters") { await loadAudit(); return; }
      if (form.id === "cc6ConsentFilters") { await loadConsents(); return; }
      if (form.id === "cc6DeletionFilters") { await loadDeletionRequests(); return; }
      if (form.id === "cc6ExportUserForm") {
        const id = String(values.user_id || "").trim();
        if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new Error("Enter a valid user ID.");
        await downloadJson(`/api/cc/pdpo/export-all?user_id=${encodeURIComponent(id)}`, `apshule-user-${id}-export.json`); return;
      }
      if (form.dataset.form === "user-create") {
        await api("/api/cc/users", { method: "POST", body: values });
        notify?.("User created. Password setup instructions have been sent.", "success");
        closeDialog(); await loadUsers(); return;
      }
      if (form.dataset.form === "user-edit") {
        await api(`/api/cc/users/${encodeURIComponent(form.dataset.id)}`, { method: "PATCH", body: values });
        notify?.("User updated.", "success"); closeDialog(); await loadUsers(); return;
      }
      if (form.dataset.form === "institution-edit") {
        const logoFile = form.elements.logo_file.files?.[0];
        const institution = {};
        for (const key of ["name", "email", "phone", "address", "website", "brand_color"]) {
          if (values[key] !== undefined && values[key] !== "") institution[key] = values[key];
        }
        if (logoFile) {
          if (logoFile.size > 300 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(logoFile.type)) {
            throw new Error("Choose a PNG, JPEG or WebP logo no larger than 300 KB.");
          }
          institution.logo_base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("The logo file could not be read."));
            reader.readAsDataURL(logoFile);
          });
        }
        if (Object.keys(institution).length) {
          await api(`/api/cc/institutions/${form.dataset.sector}/${form.dataset.id}`, { method: "PATCH", body: institution });
        }
        const branding = {
          display_name: values.display_name || null,
          dual_logo_enabled: values.dual_logo_enabled === "true",
          appshule_logo_position: values.appshule_logo_position,
          appshule_logo_size: Number(values.appshule_logo_size),
          institution_logo_size: Number(values.institution_logo_size),
          header_bg_color: values.header_bg_color || null,
          header_text_color: values.header_text_color || "#FFFFFF",
          show_appshule_name: form.elements.show_appshule_name.checked,
          show_institution_name: form.elements.show_institution_name.checked,
        };
        await api(`/api/cc/branding/${form.dataset.sector}/${form.dataset.id}`, { method: "PATCH", body: branding });
        notify?.("Institution and branding updated.", "success");
        await openInstitution(form.dataset.sector, form.dataset.id); await loadInstitutions(); return;
      }
      if (form.dataset.form === "settings") {
        values.require_two_factor = values.require_two_factor === "true";
        for (const key of ["session_timeout_minutes", "password_min_length", "backup_reminder_days"]) values[key] = Number(values[key]);
        await api("/api/cc/settings", { method: "PATCH", body: values });
        notify?.(t("cc_settings_saved"), "success"); return;
      }
      if (form.dataset.form === "announcement") {
        const sendInApp = form.elements.send_in_app.checked;
        const sendEmail = form.elements.send_email.checked;
        if (!sendInApp && !sendEmail) throw new Error("Choose email, in-app, or both.");
        const target = { type: values.target_type };
        if (values.target_type === "sector" || values.target_type === "institution") target.sector = values.target_sector;
        if (values.target_type === "institution") target.institution_id = values.target_institution_id;
        if (values.target_type === "role") target.role = values.target_role;
        if (sendInApp) {
          const payload = {
            target_type: values.target_type,
            target_sector: values.target_sector || null,
            target_institution_id: values.target_institution_id || null,
            target_role: values.target_role || null,
            title: values.title,
            body: values.body,
            severity: values.severity,
            starts_at: values.starts_at ? new Date(values.starts_at).toISOString() : undefined,
            ends_at: values.ends_at ? new Date(values.ends_at).toISOString() : undefined,
          };
          await api("/api/cc/announcements", { method: "POST", body: payload });
        }
        let mailResult = null;
        if (sendEmail) mailResult = await api("/api/cc/communicate/email", {
          method: "POST", body: { target, subject: values.title, message: values.body },
        });
        notify?.(mailResult ? `${t("cc_recipients")}: ${mailResult.sent} sent, ${mailResult.failed} failed.` : "Announcement published.", mailResult?.failed ? "error" : "success");
        await loadAnnouncements(); return;
      }
      if (form.dataset.form === "communication") {
        const target = { type: values.target_type };
        if (values.target_type === "sector") target.sector = values.sector;
        if (values.target_type === "role") target.role = values.role;
        if (values.target_type === "institution") { target.sector = values.sector; target.institution_id = values.institution_id; }
        const result = await api("/api/cc/communicate/email", { method: "POST", body: { target, subject: values.subject, message: values.message } });
        if (form.elements.also_in_app.checked) await api("/api/cc/communicate/inapp", { method: "POST", body: { target, title: values.subject, message: values.message } });
        notify?.(`${t("cc_recipients")}: ${result.sent} sent, ${result.failed} failed.`, result.failed ? "error" : "success"); return;
      }
    } catch (error) { showError(error); }
  });

  root.querySelector("#cc6Dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeDialog();
  });
  for (const btn of root.querySelectorAll("[data-cc6-tab]")) {
    if (btn.dataset.cc6Tab === "dashboard") btn.setAttribute("aria-selected", "true");
  }
  installConsentDialog();
  void loadTranslations().then(initFilters);

  return {
    setUser(user) {
      void loadUserSurface(user);
      if (user?.role === "superadmin") void setTab("dashboard");
    },
  };
}
