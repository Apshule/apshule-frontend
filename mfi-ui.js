const MFI_TABS = [
  ["dashboard", "Dashboard"],
  ["branches", "Branches"],
  ["customers", "Customers"],
  ["officers", "Officers"],
  ["settings", "Settings"],
  ["reports", "Reports"],
];
const STAFF_ROLES = new Set(["loan_officer", "loan_manager", "loan_director"]);
const OFFICER_ROLES = [
  ["loan_officer", "Loan officer"],
  ["loan_manager", "Loan manager"],
  ["loan_director", "Loan director"],
];
const IMAGE_LIMIT = 150 * 1024;
const EMPTY = "—";

export function initMfiUI({ api, getCurrentUser, notify, escapeHtml }) {
  const portalHost = document.getElementById("mfiDashboard");
  const commandHost = document.getElementById("ccMfiView");
  const state = {
    user: typeof getCurrentUser === "function" ? getCurrentUser() : null,
    tab: "dashboard",
    customers: [],
    branches: [],
    officers: [],
    search: "",
    branchFilter: "",
    customer: null,
    detailTab: "info",
    settings: null,
    organization: null,
    stats: null,
    audit: [],
    organizations: [],
    commandStats: null,
    commandError: "",
    commandLoading: true,
    commandFormOpen: false,
    pendingDelete: null,
  };

  const esc = (value) => {
    if (typeof escapeHtml === "function") return escapeHtml(value == null ? "" : String(value));
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  };
  const role = () => String(state.user?.role || "").toLowerCase();
  const isAdmin = () => role() === "mfi_admin";
  const canSeeCustomers = () => isAdmin() || STAFF_ROLES.has(role());
  const isBorrower = () => role() === "borrower";
  const userName = () => state.user?.name || state.user?.full_name || "MFI staff";
  const safeColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#17645f";
  const safeImage = (value) => /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(String(value || "")) ? value : "";
  const portal = () => portalHost?.querySelector(".mfi-portal") || null;
  const command = () => commandHost?.querySelector(".mfi-command-panel") || null;

  function announce(message, type = "success") {
    if (typeof notify === "function") notify(message, type);
  }

  function errorMessage(error) {
    const status = error?.status || error?.statusCode || error?.response?.status;
    if (status === 401) return "Your session has expired. Sign in again to continue.";
    if (status === 403) return "You do not have permission to access this MFI information.";
    return error?.message || "Something went wrong. Please try again.";
  }

  async function request(path, options) {
    if (typeof api !== "function") throw new Error("The authenticated API helper is unavailable.");
    let result;
    try {
      result = options ? await api(path, options) : await api(path);
    } catch (error) {
      throw error;
    }
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

  const value = (record, key, fallback = "") => record && record[key] != null ? record[key] : fallback;
  const text = (record, key, fallback = EMPTY) => esc(value(record, key, fallback));
  const money = (amount, currency = "UGX") => {
    if (amount == null || amount === "") return EMPTY;
    const number = Number(amount);
    if (!Number.isFinite(number)) return esc(amount);
    return `${esc(currency)} ${new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(number)}`;
  };
  const initials = (name) => String(name || "MF").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  const formattedDate = (date) => {
    if (!date) return EMPTY;
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? esc(date) : esc(new Intl.DateTimeFormat("en-UG", { day: "numeric", month: "short", year: "numeric" }).format(parsed));
  };
  const actionLabel = (action) => String(action || "updated").replace(/^mfi\./, "").replaceAll("_", " ");
  const listOf = (payload, key) => Array.isArray(payload?.[key]) ? payload[key] : [];

  function brandMarkup() {
    const org = state.organization || {};
    const name = org.name || state.user?.organization_name || state.user?.organization?.name || "APSHULE MFI";
    const image = safeImage(org.logo_base64 || state.user?.organization?.logo_base64);
    return `
      <div class="mfi-brand-lockup">
        <div class="mfi-brand-mark">${image ? `<img src="${esc(image)}" alt="">` : "A."}</div>
        <div class="mfi-brand-copy"><strong>${esc(name)}</strong><span>APSHULE · MICROFINANCE</span></div>
      </div>`;
  }

  function userChip() {
    return `<div class="mfi-user-chip"><div class="mfi-user-avatar">${esc(initials(userName()))}</div><div><strong>${esc(userName())}</strong><span>${esc(role().replaceAll("_", " ") || "staff")}</span></div></div>`;
  }

  function portalFrame() {
    if (!portalHost) return;
    const theme = safeColor(state.organization?.brand_color || state.user?.organization?.brand_color);
    portalHost.innerHTML = `
      <section class="mfi-portal" style="--mfi-primary:${esc(theme)}">
        <div class="mfi-shell">
          <header class="mfi-topbar">${brandMarkup()}${userChip()}</header>
          ${portalContent()}
        </div>
      </section>`;
    bindPortalEvents();
  }

  function portalContent() {
    if (isBorrower()) {
      return `<section class="mfi-panel"><div class="mfi-state"><div class="mfi-state-symbol">03A</div><strong>Limited access</strong><p>Borrower self-service is outside Phase 3A. Contact your MFI officer for help with your account.</p></div></section>`;
    }
    if (!isAdmin() && !STAFF_ROLES.has(role())) {
      return `<section class="mfi-panel"><div class="mfi-state"><div class="mfi-state-symbol">MFI</div><strong>MFI workspace unavailable</strong><p>This workspace is for MFI administrators and staff accounts.</p></div></section>`;
    }
    const visibleTabs = isAdmin() ? MFI_TABS : MFI_TABS.filter(([key]) => ["dashboard", "customers"].includes(key));
    const title = {
      dashboard: "Operations at a glance",
      branches: "Branches",
      customers: "Customer records",
      officers: "Officers",
      settings: "Organization settings",
      reports: "Reports",
    }[state.tab] || "Operations";
    const subline = {
      dashboard: "A clear view of your organization’s day-to-day activity.",
      branches: "Maintain locations and the managers accountable for each one.",
      customers: "Find and maintain customer records, identity, and guarantor details.",
      officers: "Keep staff access, roles, and branch assignments current.",
      settings: "Organization profile and operating defaults.",
      reports: "Reporting tools are planned for Phase 3C.",
    }[state.tab];
    return `
      <div class="mfi-page-intro">
        <div><p class="mfi-eyebrow">Microfinance · Phase 3A</p><h1>${esc(title)}</h1><p>${esc(subline)}</p></div>
      </div>
      <nav class="mfi-nav" aria-label="MFI workspace">
        ${visibleTabs.map(([key, label]) => `<button type="button" data-tab="${key}" aria-current="${state.tab === key ? "page" : "false"}">${esc(label)}</button>`).join("")}
      </nav>
      <main class="mfi-view" data-view="${esc(state.tab)}">${viewContent()}</main>
      <div class="mfi-modal-slot"></div>`;
  }

  function viewContent() {
    if (state.tab === "dashboard") return dashboardView();
    if (state.tab === "branches") return branchView();
    if (state.tab === "customers") return customerView();
    if (state.tab === "officers") return officerView();
    if (state.tab === "settings") return settingsView();
    return `<section class="mfi-placeholder"><strong>Reports are coming in Phase 3C</strong><p>Phase 3A keeps this workspace focused on people, locations, and accountability.</p></section>`;
  }

  function skeletonRows(count = 4) {
    return `<div class="mfi-skeleton" aria-label="Loading">${Array.from({ length: count }, () => "<span></span>").join("")}</div>`;
  }

  function errorState(error, retry) {
    return `<div class="mfi-state mfi-error-state"><div class="mfi-state-symbol">!</div><strong>We couldn’t load this view</strong><p>${esc(errorMessage(error))}</p><button type="button" class="mfi-btn mfi-btn--quiet" data-retry="${esc(retry)}">Try again</button></div>`;
  }

  function emptyState(title, description, buttonText = "", action = "") {
    return `<div class="mfi-state"><div class="mfi-state-symbol">·</div><strong>${esc(title)}</strong><p>${esc(description)}</p>${buttonText ? `<button type="button" class="mfi-btn" data-action="${esc(action)}">${esc(buttonText)}</button>` : ""}</div>`;
  }

  function dashboardView() {
    if (state.dashboardLoading) return `<section class="mfi-metrics">${Array.from({ length: 5 }, () => '<div class="mfi-metric"><div class="mfi-skeleton"><span></span></div></div>').join("")}</section><section class="mfi-panel">${skeletonRows(4)}</section>`;
    if (state.dashboardError) return `<section class="mfi-panel">${errorState(state.dashboardError, "dashboard")}</section>`;
    if (!isAdmin()) {
      return `<div class="mfi-dashboard-grid">
        <section class="mfi-panel"><div class="mfi-section-head"><div><h2>Customer desk</h2><p>Access customer records and guarantor information assigned to your organization.</p></div></div><div class="mfi-action-row" style="justify-content:flex-start"><button class="mfi-btn" type="button" data-tab="customers">Open customer records</button></div></section>
        <section class="mfi-quick-panel"><div><p class="mfi-eyebrow">Staff workspace</p><h2>Keep every customer detail close at hand.</h2><p>Search records, review identity details, and maintain guarantor contacts.</p></div><button class="mfi-btn" type="button" data-tab="customers">View customers</button></section>
      </div>`;
    }
    const stats = state.stats || {};
    const metric = (label, key) => `<div class="mfi-metric"><span class="mfi-metric-label">${esc(label)}</span><strong class="mfi-metric-value">${esc(value(stats, key, 0))}</strong></div>`;
    const activity = state.audit.length ? state.audit.map((item) => {
      const who = value(item, "actor_name", value(item, "actor_email", "MFI staff"));
      const target = item.metadata && typeof item.metadata === "object"
        ? (item.metadata.branch_name || item.metadata.customer_name || item.metadata.officer_name || "")
        : "";
      return `<div class="mfi-activity-item"><div class="mfi-activity-dot">${esc(initials(who))}</div><div><strong>${esc(actionLabel(item.action))}${target ? ` · ${esc(target)}` : ""}</strong><span>${esc(who)}${item.target_table ? ` · ${esc(String(item.target_table).replace("mfi_", ""))}` : ""}</span></div><time>${formattedDate(item.created_at)}</time></div>`;
    }).join("") : emptyState("No activity yet", "Organization activity will appear here as your team updates its records.");
    return `
      <section class="mfi-metrics">
        ${metric("Organizations", "organizations")}${metric("Branches", "branches")}${metric("Active officers", "officers")}
        <div class="mfi-metric"><span class="mfi-metric-label">Customers</span><strong class="mfi-metric-value">${esc(value(stats, "customers", 0))}</strong><span class="mfi-metric-note">${esc(value(stats, "active_customers", 0))} active</span></div>
        <div class="mfi-metric"><span class="mfi-metric-label">Loan portfolio</span><strong class="mfi-metric-value">Coming soon</strong></div>
        <div class="mfi-metric"><span class="mfi-metric-label">Collections</span><strong class="mfi-metric-value">Coming soon</strong></div>
      </section>
      <div class="mfi-dashboard-grid">
        <section class="mfi-panel">
          <div class="mfi-section-head"><div><h2>Recent activity</h2><p>Latest changes recorded in your organization.</p></div><span class="mfi-eyebrow">AUDIT TRAIL</span></div>
          <div class="mfi-activity-list">${activity}</div>
        </section>
        <aside class="mfi-quick-panel"><div><p class="mfi-eyebrow">Operations</p><h2>People first. Every record accountable.</h2><p>Keep customer information accurate and branch ownership clear.</p></div><button class="mfi-btn" type="button" data-tab="customers">Find a customer</button></aside>
      </div>`;
  }

  function branchView() {
    if (state.listLoading) return `<section class="mfi-panel">${skeletonRows()}</section>`;
    if (state.listError) return `<section class="mfi-panel">${errorState(state.listError, "branches")}</section>`;
    const rows = state.branches.length ? state.branches.map((branch) => `<tr>
      <td class="mfi-primary-cell"><strong>${text(branch, "name")}</strong><span>${text(branch, "code", "No branch code")}</span></td>
      <td>${text(branch, "city")}${branch.district ? `, ${text(branch, "district")}` : ""}</td>
      <td>${text(branch, "manager_name")}</td>
      <td><span class="mfi-status ${branch.active === false ? "mfi-status--inactive" : ""}">${branch.active === false ? "Inactive" : "Active"}</span></td>
      <td><div class="mfi-row-actions"><button type="button" class="mfi-icon-btn" title="Edit branch" aria-label="Edit branch" data-action="edit-branch" data-id="${esc(branch.id)}">Edit</button><button type="button" class="mfi-icon-btn" title="Delete branch" aria-label="Delete branch" data-action="delete-branch" data-id="${esc(branch.id)}">×</button></div></td>
    </tr>`).join("") : `<tr><td colspan="5">${emptyState("No branches yet", "Add your first branch to organize customer records and staff accountability.", "Add a branch", "add-branch")}</td></tr>`;
    return `<section class="mfi-panel">
      <div class="mfi-section-head"><div><h2>Branch directory</h2><p>${state.branches.length} locations in this organization.</p></div><div class="mfi-action-row"><button class="mfi-btn" type="button" data-action="add-branch">＋ Add branch</button></div></div>
      <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Branch</th><th>Location</th><th>Manager</th><th>Status</th><th><span class="mfi-visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  function customerView() {
    if (!canSeeCustomers()) return `<section class="mfi-panel">${emptyState("Customer access unavailable", "Your account cannot access customer records.")}</section>`;
    if (state.listLoading) return `<section class="mfi-panel">${skeletonRows(5)}</section>`;
    if (state.listError) return `<section class="mfi-panel">${errorState(state.listError, "customers")}</section>`;
    const rows = state.customers.length ? state.customers.map((customer) => {
      const fullName = `${value(customer, "first_name", "")} ${value(customer, "last_name", "")}`.trim();
      return `<tr>
        <td class="mfi-primary-cell"><strong>${esc(fullName || "Customer")}</strong><span>${text(customer, "national_id", "No national ID")}</span></td>
        <td>${text(customer, "phone")}</td><td>${text(customer, "branch_name")}</td>
        <td><span class="mfi-status ${customer.status === "inactive" ? "mfi-status--inactive" : ""}">${text(customer, "status", "active")}</span></td>
        <td><div class="mfi-row-actions"><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-action="view-customer" data-id="${esc(customer.id)}">View record</button>${isAdmin() ? `<button type="button" class="mfi-icon-btn" title="Delete customer" aria-label="Delete customer" data-action="delete-customer" data-id="${esc(customer.id)}">×</button>` : ""}</div></td>
      </tr>`;
    }).join("") : `<tr><td colspan="5">${emptyState(state.search ? "No matching customers" : "No customer records yet", state.search ? "Try another name, phone number, or national ID." : "When customer records are added, they will be listed here.", "Add customer", "add-customer")}</td></tr>`;
    return `<section class="mfi-panel">
      <div class="mfi-section-head"><div><h2>Customer records</h2><p>Showing up to 200 records. Customer identity stays at the center.</p></div><div class="mfi-action-row"><button type="button" class="mfi-btn" data-action="add-customer">＋ Add customer</button></div></div>
      <form class="mfi-toolbar" data-form="customer-search">
        <label class="mfi-search"><span class="mfi-visually-hidden">Search customers</span><input class="mfi-control" type="search" name="search" value="${esc(state.search)}" placeholder="Search name, phone, or national ID"></label>
        ${isAdmin() ? `<select class="mfi-control mfi-select-compact" name="branch_id" aria-label="Filter by branch"><option value="">All branches</option>${state.branches.map((branch) => `<option value="${esc(branch.id)}" ${state.branchFilter === branch.id ? "selected" : ""}>${text(branch, "name")}</option>`).join("")}</select>` : ""}
        <button type="submit" class="mfi-btn mfi-btn--quiet">Search</button>
      </form>
      <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Customer</th><th>Phone</th><th>Branch</th><th>Status</th><th>Record</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  function officerView() {
    if (state.listLoading) return `<section class="mfi-panel">${skeletonRows()}</section>`;
    if (state.listError) return `<section class="mfi-panel">${errorState(state.listError, "officers")}</section>`;
    const rows = state.officers.length ? state.officers.map((officer) => `<tr>
      <td class="mfi-primary-cell"><strong>${text(officer, "name")}</strong><span>${text(officer, "email")}</span></td>
      <td>${esc(OFFICER_ROLES.find(([key]) => key === officer.role)?.[1] || officer.role || EMPTY)}</td>
      <td>${text(officer, "branch_name")}</td><td>${text(officer, "employee_code")}</td>
      <td><span class="mfi-status ${officer.active === false ? "mfi-status--inactive" : ""}">${officer.active === false ? "Inactive" : "Active"}</span></td>
      <td><div class="mfi-row-actions"><button type="button" class="mfi-icon-btn" title="Edit officer" aria-label="Edit officer" data-action="edit-officer" data-id="${esc(officer.id)}">Edit</button>${officer.active === false ? "" : `<button type="button" class="mfi-icon-btn" title="Deactivate officer" aria-label="Deactivate officer" data-action="delete-officer" data-id="${esc(officer.id)}">×</button>`}</div></td>
    </tr>`).join("") : `<tr><td colspan="6">${emptyState("No officers added", "Add staff accounts and assign each officer to a branch.", "Add officer", "add-officer")}</td></tr>`;
    return `<section class="mfi-panel"><div class="mfi-section-head"><div><h2>Officer directory</h2><p>Manage staff access and branch assignments.</p></div><button type="button" class="mfi-btn" data-action="add-officer">＋ Add officer</button></div>
      <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Officer</th><th>Role</th><th>Branch</th><th>Employee code</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  function settingsView() {
    if (state.listLoading) return `<section class="mfi-panel">${skeletonRows(4)}</section>`;
    if (state.listError) return `<section class="mfi-panel">${errorState(state.listError, "settings")}</section>`;
    const settings = state.settings || {};
    const org = state.organization || {};
    return `<form class="mfi-panel" data-form="settings">
      <div class="mfi-section-head"><div><h2>Organization profile</h2><p>Brand and contact information shown across your portal.</p></div></div>
      <div class="mfi-form-grid">
        ${field("Organization name", "name", org.name, "text", true)}
        ${field("Registration number", "registration_number", org.registration_number)}
        ${field("TIN", "tin", org.tin)}
        ${field("License number", "license_number", org.license_number)}
        ${field("Phone", "phone", org.phone, "tel")}
        ${field("Organization email", "email", org.email, "email")}
        ${field("Website", "website", org.website, "url")}
        ${field("City", "city", org.city)}
        ${field("District", "district", org.district)}
        ${field("Country", "country", org.country || "Uganda")}
        ${field("Office address", "address", org.address, "text", false, "mfi-span-2")}
        <div class="mfi-field"><label for="mfi-brand-color">Portal brand color</label><input id="mfi-brand-color" class="mfi-control" type="color" name="brand_color" value="${esc(safeColor(org.brand_color))}"></div>
        <div class="mfi-field"><label for="mfi-logo-file">Organization logo</label><input id="mfi-logo-file" class="mfi-control" type="file" name="logo_file" accept="image/jpeg,image/png,image/webp"><small class="mfi-file-note">Optional. Image uploads are capped at 150 KB.</small></div>
        <div class="mfi-form-section">Operating defaults</div>
        ${field("Currency", "currency", settings.currency || "UGX", "text", true)}
        ${field("Default interest rate (%)", "default_interest_rate", settings.default_interest_rate ?? "24", "number", true, "", 'step="0.01" min="0"')}
        ${field("Default term (months)", "default_term_months", settings.default_term_months ?? "12", "number", true, "", 'step="1" min="1"')}
        <div class="mfi-field"><label for="mfi-frequency">Default repayment frequency</label><select id="mfi-frequency" class="mfi-control" name="default_repayment_frequency">${["weekly", "biweekly", "monthly", "quarterly"].map((frequency) => `<option value="${frequency}" ${(settings.default_repayment_frequency || "monthly") === frequency ? "selected" : ""}>${esc(frequency[0].toUpperCase() + frequency.slice(1))}</option>`).join("")}</select></div>
        ${field("Late fee (%)", "late_fee_percent", settings.late_fee_percent ?? "2", "number", true, "", 'step="0.01" min="0"')}
        ${field("Grace period (days)", "grace_period_days", settings.grace_period_days ?? "7", "number", true, "", 'step="1" min="0")}
      </div>
      <div class="mfi-action-row" style="justify-content:flex-start;margin-top:20px"><button type="submit" class="mfi-btn">Save settings</button></div>
    </form>`;
  }

  function field(label, name, current = "", type = "text", required = false, extraClass = "", extra = "") {
    const id = `mfi-${name.replaceAll("_", "-")}`;
    return `<div class="mfi-field ${extraClass}"><label for="${esc(id)}">${esc(label)}${required ? " *" : ""}</label><input id="${esc(id)}" class="mfi-control" name="${esc(name)}" type="${esc(type)}" value="${esc(current ?? "")}" ${required ? "required" : ""} ${extra}></div>`;
  }

  function renderPortalView() {
    const root = portal();
    if (!root) {
      portalFrame();
      return;
    }
    root.style.setProperty("--mfi-primary", safeColor(state.organization?.brand_color || state.user?.organization?.brand_color));
    root.innerHTML = `<div class="mfi-shell"><header class="mfi-topbar">${brandMarkup()}${userChip()}</header>${portalContent()}</div>`;
    bindPortalEvents();
  }

  function bindPortalEvents() {
    const root = portal();
    if (!root || root.dataset.bound) return;
    root.dataset.bound = "true";
    root.addEventListener("click", handlePortalActionClick);
    root.addEventListener("submit", handlePortalSubmit);
    root.addEventListener("change", handlePortalChange);
    root.addEventListener("input", handlePortalInput);
  }

  async function activateTab(tab) {
    const allowed = isAdmin() ? MFI_TABS.map(([key]) => key) : ["dashboard", "customers"];
    if (!allowed.includes(tab)) return;
    state.tab = tab;
    state.listError = null;
    state.listLoading = ["branches", "customers", "officers", "settings"].includes(tab);
    state.dashboardError = null;
    state.dashboardLoading = tab === "dashboard" && isAdmin();
    renderPortalView();
    if (tab === "dashboard" && isAdmin()) await loadDashboard();
    if (tab === "branches") await loadBranches();
    if (tab === "customers") await loadCustomers();
    if (tab === "officers") await loadOfficers();
    if (tab === "settings") await loadSettings();
    renderPortalView();
  }

  async function loadDashboard() {
    try {
      const [statsPayload, auditPayload, orgPayload] = await Promise.all([
        request("/api/mfi/stats"),
        request("/api/mfi/audit-log"),
        request("/api/mfi/organizations"),
      ]);
      state.stats = statsPayload?.stats || {};
      state.audit = listOf(auditPayload, "audit");
      state.organization = listOf(orgPayload, "organizations")[0] || state.organization;
      state.dashboardError = null;
    } catch (error) {
      state.dashboardError = error;
    } finally {
      state.dashboardLoading = false;
      renderPortalView();
    }
  }

  async function loadBranches() {
    state.listLoading = true;
    state.listError = null;
    renderPortalView();
    try {
      const payload = await request("/api/mfi/branches");
      state.branches = listOf(payload, "branches");
      try {
        state.officers = listOf(await request("/api/mfi/officers"), "officers");
      } catch (_) {
        state.officers = [];
      }
      state.listError = null;
    } catch (error) { state.listError = error; }
    finally { state.listLoading = false; renderPortalView(); }
  }

  async function loadCustomers() {
    state.listLoading = true;
    state.listError = null;
    renderPortalView();
    try {
      const params = new URLSearchParams();
      if (state.search.trim()) params.set("search", state.search.trim());
      if (state.branchFilter) params.set("branch_id", state.branchFilter);
      const query = params.toString();
      const [payload] = await Promise.all([
        request(`/api/mfi/customers${query ? `?${query}` : ""}`),
        isAdmin() && !state.branches.length ? loadBranchesForCustomerFilter() : Promise.resolve(),
      ]);
      state.customers = listOf(payload, "customers");
      state.listError = null;
    } catch (error) {
      state.listError = error;
    } finally {
      state.listLoading = false;
      renderPortalView();
    }
  }

  async function loadBranchesForCustomerFilter() {
    try { state.branches = listOf(await request("/api/mfi/branches"), "branches"); }
    catch (_) { state.branches = []; }
  }

  async function loadOfficers() {
    state.listLoading = true;
    state.listError = null;
    renderPortalView();
    try {
      const [officersPayload, branchPayload] = await Promise.all([
        request("/api/mfi/officers"),
        request("/api/mfi/branches"),
      ]);
      state.officers = listOf(officersPayload, "officers");
      state.branches = listOf(branchPayload, "branches");
      state.listError = null;
    } catch (error) { state.listError = error; }
    finally { state.listLoading = false; renderPortalView(); }
  }

  async function loadSettings() {
    state.listLoading = true;
    state.listError = null;
    renderPortalView();
    try {
      const [settingsPayload, orgPayload] = await Promise.all([
        request("/api/mfi/settings"),
        request("/api/mfi/organizations"),
      ]);
      state.settings = settingsPayload?.settings || {};
      state.organization = listOf(orgPayload, "organizations")[0] || {
        id: state.settings.organization_id,
        name: state.settings.organization_name,
        registration_number: state.settings.registration_number,
        tin: state.settings.tin,
        license_number: state.settings.license_number,
        address: state.settings.address,
        phone: state.settings.phone,
        email: state.settings.email,
        website: state.settings.website,
        logo_base64: state.settings.logo_base64,
        brand_color: state.settings.brand_color,
        city: state.settings.city,
        district: state.settings.district,
        country: state.settings.country,
      };
      state.listError = null;
    } catch (error) { state.listError = error; }
    finally { state.listLoading = false; renderPortalView(); }
  }

  function handlePortalActionClick(event) {
    const root = portal();
    const target = event.target.closest("button");
    if (!target || !root?.contains(target)) return;
    if (target.dataset.tab) {
      activateTab(target.dataset.tab);
      return;
    }
    if (target.dataset.closeModal !== undefined) {
      closeModal();
      return;
    }
    if (target.dataset.retry) {
      if (target.dataset.retry === "customer-detail") {
        renderCustomerDetails(state.customer?.id, state.detailTab);
        return;
      }
      activateTab(target.dataset.retry);
      return;
    }
    if (target.dataset.detailTab) {
      state.detailTab = target.dataset.detailTab;
      renderCustomerDetails(target.dataset.id || state.customer?.id, state.detailTab);
      return;
    }
    if (target.dataset.confirmCancel !== undefined) {
      state.pendingDelete = null;
      closeModal();
      return;
    }
    if (target.dataset.confirmYes !== undefined) {
      const pending = state.pendingDelete;
      state.pendingDelete = null;
      if (pending) performDelete(pending.type, pending.id, pending.customerId);
      return;
    }
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (action === "add-branch") openBranchForm();
    if (action === "edit-branch") openBranchForm(state.branches.find((row) => row.id === id));
    if (action === "delete-branch") confirmDelete("branch", id);
    if (action === "add-officer") openOfficerForm();
    if (action === "edit-officer") openOfficerForm(state.officers.find((row) => row.id === id));
    if (action === "delete-officer") confirmDelete("officer", id);
    if (action === "add-customer") openCustomerForm();
    if (action === "view-customer") renderCustomerDetails(id, "info");
    if (action === "delete-customer") confirmDelete("customer", id);
    if (action === "edit-customer") editCustomer(id);
    if (action === "add-guarantor") openGuarantorForm(state.customer?.id);
    if (action === "edit-guarantor") {
      const guarantor = state.currentGuarantors?.find((row) => row.id === id);
      openGuarantorForm(state.customer?.id, guarantor);
    }
    if (action === "delete-guarantor") confirmDelete("guarantor", id, state.customer?.id);
  }

  async function handlePortalSubmit(event) {
    const form = event.target.closest("form");
    if (!form) return;
    const type = form.dataset.form;
    if (!type) return;
    event.preventDefault();
    if (type === "customer-search") {
      const data = new FormData(form);
      state.search = String(data.get("search") || "");
      state.branchFilter = String(data.get("branch_id") || "");
      await loadCustomers();
      return;
    }
    setFormBusy(form, true);
    clearFormError(form);
    try {
      if (type === "branch") await submitBranch(form);
      else if (type === "officer") await submitOfficer(form);
      else if (type === "customer") await submitCustomer(form);
      else if (type === "guarantor") await submitGuarantor(form);
      else if (type === "settings") await submitSettings(form);
    } catch (error) {
      showFormError(form, errorMessage(error));
      announce(errorMessage(error), "error");
      setFormBusy(form, false);
    }
  }

  async function handlePortalChange(event) {
    const control = event.target;
    if (control.name === "branch_id" && control.closest('[data-form="customer-search"]')) {
      state.branchFilter = control.value;
      await loadCustomers();
    }
  }

  function handlePortalInput(event) {
    const field = event.target;
    if (field.name === "brand_color") {
      const root = portal();
      if (root && /^#[a-f0-9]{6}$/i.test(field.value)) root.style.setProperty("--mfi-primary", field.value);
    }
  }

  function setFormBusy(form, busy) {
    form.dataset.busy = busy ? "true" : "false";
    const controls = [
      ...form.querySelectorAll('button[type="submit"]'),
      ...portal().querySelectorAll(`[form="${CSS.escape(form.id)}"][type="submit"]`),
    ];
    controls.forEach((button) => {
      button.disabled = busy;
      if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
      button.textContent = busy ? "Saving…" : button.dataset.originalText;
    });
  }

  function showFormError(form, message) {
    let node = form.querySelector(".mfi-form-error");
    if (!node) {
      node = document.createElement("div");
      node.className = "mfi-form-error";
      node.setAttribute("role", "alert");
      form.prepend(node);
    }
    node.textContent = message;
  }

  function clearFormError(form) {
    form.querySelector(".mfi-form-error")?.remove();
  }

  function closeModal() {
    const slot = portal()?.querySelector(".mfi-modal-slot");
    if (slot) slot.innerHTML = "";
  }

  function modalMarkup(title, description, body, submitText = "", wide = false) {
    return `<div class="mfi-modal-backdrop" data-modal-backdrop><section class="mfi-modal ${wide ? "mfi-modal--wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="mfi-modal-head"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><button type="button" class="mfi-close" aria-label="Close" data-close-modal>×</button></header>
      ${body}
      ${submitText ? `<footer class="mfi-modal-foot"><button type="button" class="mfi-btn mfi-btn--quiet" data-close-modal>Cancel</button><button type="submit" form="mfi-modal-form" class="mfi-btn">${esc(submitText)}</button></footer>` : ""}
    </section></div>`;
  }

  function putModal(html) {
    const slot = portal()?.querySelector(".mfi-modal-slot");
    if (slot) slot.innerHTML = html;
    slot?.querySelector(".mfi-modal-backdrop")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
  }

  function selectField(label, name, items, current = "", required = false) {
    return `<div class="mfi-field"><label for="mfi-${esc(name)}">${esc(label)}${required ? " *" : ""}</label><select id="mfi-${esc(name)}" name="${esc(name)}" class="mfi-control" ${required ? "required" : ""}><option value="">Select ${esc(label.toLowerCase())}</option>${items.map((item) => `<option value="${esc(item.value)}" ${String(current || "") === String(item.value) ? "selected" : ""}>${esc(item.label)}</option>`).join("")}</select></div>`;
  }

  function openBranchForm(branch = null) {
    if (!isAdmin()) return;
    const editing = Boolean(branch);
    const managers = state.officers.filter((officer) => officer.active !== false && ["loan_manager", "loan_director"].includes(officer.role));
    const body = `<form id="mfi-modal-form" class="mfi-modal-body" data-form="branch" data-id="${esc(branch?.id || "")}">
      <div class="mfi-form-grid">
        ${field("Branch name", "name", branch?.name || "", "text", true)}
        ${field("Branch code", "code", branch?.code)}
        ${field("Phone", "phone", branch?.phone, "tel")}
        ${field("City", "city", branch?.city)}
        ${field("District", "district", branch?.district)}
        ${selectField("Branch manager", "manager_id", managers.map((officer) => ({ value: officer.user_id, label: `${officer.name} · ${officer.role.replaceAll("_", " ")}` })), branch?.manager_id)}
        <div class="mfi-field mfi-span-2"><label for="mfi-address">Address</label><textarea id="mfi-address" name="address" class="mfi-control">${esc(branch?.address || "")}</textarea></div>
        ${editing ? `<div class="mfi-field"><label for="mfi-active">Status</label><select class="mfi-control" id="mfi-active" name="active"><option value="true" ${branch.active !== false ? "selected" : ""}>Active</option><option value="false" ${branch.active === false ? "selected" : ""}>Inactive</option></select></div>` : ""}
      </div>
    </form>`;
    putModal(modalMarkup(editing ? "Edit branch" : "Add a branch", "Keep location and manager details accurate.", body, editing ? "Save branch" : "Create branch"));
  }

  function openOfficerForm(officer = null) {
    if (!isAdmin()) return;
    const editing = Boolean(officer);
    const names = String(officer?.name || "").trim().split(/\s+/);
    const body = `<form id="mfi-modal-form" class="mfi-modal-body" data-form="officer" data-id="${esc(officer?.id || "")}">
      <div class="mfi-form-grid">
        ${field("First name", "first_name", names[0] || "", "text", true)}
        ${field("Last name", "last_name", names.slice(1).join(" "), "text", true)}
        ${field("Work email", "email", officer?.email, "email", true)}
        ${field("Phone", "phone", officer?.phone, "tel")}
        ${selectField("Officer role", "role", OFFICER_ROLES.map(([value, label]) => ({ value, label })), officer?.role, true)}
        ${selectField("Branch", "branch_id", state.branches.filter((branch) => branch.active !== false).map((branch) => ({ value: branch.id, label: branch.name })), officer?.branch_id)}
        ${field("Employee code", "employee_code", officer?.employee_code)}
        ${field("Hire date", "hired_on", officer?.hired_on ? String(officer.hired_on).slice(0, 10) : "", "date")}
        ${editing ? `<div class="mfi-field"><label for="mfi-active">Status</label><select class="mfi-control" id="mfi-active" name="active"><option value="true" ${officer.active !== false ? "selected" : ""}>Active</option><option value="false" ${officer.active === false ? "selected" : ""}>Inactive</option></select></div>` : field("Temporary password", "password", "", "password", true)}
        ${!editing ? '<p class="mfi-file-note mfi-span-2">Use at least 8 characters. The officer can change this after signing in.</p>' : ""}
      </div>
    </form>`;
    putModal(modalMarkup(editing ? "Edit officer" : "Add an officer", "Assign a clear role and branch for accountability.", body, editing ? "Save officer" : "Create officer"));
  }

  function openCustomerForm(customer = null) {
    const editing = Boolean(customer);
    const body = `<form id="mfi-modal-form" class="mfi-modal-body" data-form="customer" data-id="${esc(customer?.id || "")}">
      <div class="mfi-form-grid">
        <div class="mfi-form-section">Identity</div>
        ${field("First name", "first_name", customer?.first_name, "text", true)}
        ${field("Last name", "last_name", customer?.last_name, "text", true)}
        ${selectField("Gender", "gender", [["female", "Female"], ["male", "Male"], ["other", "Other"], ["prefer_not_to_say", "Prefer not to say"]].map(([value, label]) => ({ value, label })), customer?.gender)}
        ${field("Date of birth", "date_of_birth", customer?.date_of_birth ? String(customer.date_of_birth).slice(0, 10) : "", "date")}
        ${field("National ID", "national_id", customer?.national_id)}
        ${field("TIN", "tin", customer?.tin)}
        ${field("Phone", "phone", customer?.phone, "tel")}
        ${field("Email", "email", customer?.email, "email")}
        ${field("Occupation", "occupation", customer?.occupation)}
        ${field("Monthly income (UGX)", "monthly_income", customer?.monthly_income, "number", false, "", 'min="0" step="1"')}
        ${isAdmin() ? selectField("Branch", "branch_id", state.branches.filter((branch) => branch.active !== false).map((branch) => ({ value: branch.id, label: branch.name })), customer?.branch_id) : ""}
        ${field("Customer photo", "photo_file", "", "file", false, "", 'accept="image/jpeg,image/png,image/webp"')}
        <p class="mfi-file-note mfi-span-2">JPEG, PNG or WebP. Files are compressed if needed and limited to 150 KB before upload.</p>
        <div class="mfi-form-section">Address</div>
        ${field("Village", "village", customer?.village)}
        ${field("District", "district", customer?.district)}
        <div class="mfi-field mfi-span-2"><label for="mfi-address">Address</label><textarea id="mfi-address" class="mfi-control" name="address">${esc(customer?.address || "")}</textarea></div>
        <div class="mfi-form-section">Family contacts</div>
        ${field("Spouse name", "spouse_name", customer?.spouse_name)}
        ${field("Spouse phone", "spouse_phone", customer?.spouse_phone, "tel")}
        ${field("Next-of-kin name", "nok_name", customer?.nok_name)}
        ${field("Next-of-kin relationship", "nok_relationship", customer?.nok_relationship)}
        ${field("Next-of-kin phone", "nok_phone", customer?.nok_phone, "tel")}
        ${editing ? selectField("Record status", "status", [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }], customer?.status || "active") : ""}
      </div>
    </form>`;
    putModal(modalMarkup(editing ? "Edit customer record" : "Add a customer", "Capture the details staff need to serve this customer reliably.", body, editing ? "Save record" : "Create customer", true));
  }

  function openGuarantorForm(customerId, guarantor = null) {
    const editing = Boolean(guarantor);
    const body = `<form id="mfi-modal-form" class="mfi-modal-body" data-form="guarantor" data-id="${esc(guarantor?.id || "")}" data-customer-id="${esc(customerId || "")}">
      <div class="mfi-form-grid">
        ${field("Full name", "full_name", guarantor?.full_name, "text", true)}
        ${field("Relationship", "relationship", guarantor?.relationship)}
        ${field("Phone", "phone", guarantor?.phone, "tel")}
        ${field("National ID", "national_id", guarantor?.national_id)}
        ${field("Occupation", "occupation", guarantor?.occupation)}
        ${field("Monthly income (UGX)", "monthly_income", guarantor?.monthly_income, "number", false, "", 'min="0" step="1"')}
        ${field("Photo", "photo_file", "", "file", false, "", 'accept="image/jpeg,image/png,image/webp"')}
        ${field("Signature image", "signature_file", "", "file", false, "", 'accept="image/jpeg,image/png,image/webp"')}
        <div class="mfi-field mfi-span-2"><label for="mfi-guarantor-address">Address</label><textarea id="mfi-guarantor-address" name="address" class="mfi-control">${esc(guarantor?.address || "")}</textarea></div>
        <p class="mfi-file-note mfi-span-2">Image files are limited to 150 KB each before upload.</p>
      </div>
    </form>`;
    putModal(modalMarkup(editing ? "Edit guarantor" : "Add a guarantor", "Keep guarantor details attached to this customer record.", body, editing ? "Save guarantor" : "Add guarantor", true));
  }

  async function submitBranch(form) {
    const id = form.dataset.id;
    const body = formBody(form);
    if (body.active !== undefined) body.active = body.active === "true";
    await request(id ? `/api/mfi/branches/${encodeURIComponent(id)}` : "/api/mfi/branches", {
      method: id ? "PATCH" : "POST", body,
    });
    announce(id ? "Branch updated." : "Branch created.");
    closeModal();
    await loadBranches();
  }

  async function submitOfficer(form) {
    const id = form.dataset.id;
    const body = formBody(form);
    if (body.active !== undefined) body.active = body.active === "true";
    await request(id ? `/api/mfi/officers/${encodeURIComponent(id)}` : "/api/mfi/officers", {
      method: id ? "PATCH" : "POST", body,
    });
    announce(id ? "Officer updated." : "Officer account created.");
    closeModal();
    await loadOfficers();
  }

  async function submitCustomer(form) {
    const id = form.dataset.id;
    const body = formBody(form);
    if (body.monthly_income !== undefined && body.monthly_income !== "") body.monthly_income = Number(body.monthly_income);
    const photo = form.querySelector('[name="photo_file"]')?.files?.[0];
    if (photo) body.photo_base64 = await imageAsDataUrl(photo);
    await request(id ? `/api/mfi/customers/${encodeURIComponent(id)}` : "/api/mfi/customers", {
      method: id ? "PATCH" : "POST", body,
    });
    announce(id ? "Customer record updated." : "Customer record created.");
    closeModal();
    await loadCustomers();
  }

  async function submitGuarantor(form) {
    const id = form.dataset.id;
    const customerId = form.dataset.customerId;
    const body = formBody(form);
    if (body.monthly_income !== undefined && body.monthly_income !== "") body.monthly_income = Number(body.monthly_income);
    const photo = form.querySelector('[name="photo_file"]')?.files?.[0];
    const signature = form.querySelector('[name="signature_file"]')?.files?.[0];
    if (photo) body.photo_base64 = await imageAsDataUrl(photo);
    if (signature) body.signature_base64 = await imageAsDataUrl(signature);
    await request(id ? `/api/mfi/guarantors/${encodeURIComponent(id)}` : `/api/mfi/customers/${encodeURIComponent(customerId)}/guarantors`, {
      method: id ? "PATCH" : "POST", body,
    });
    announce(id ? "Guarantor updated." : "Guarantor added.");
    await renderCustomerDetails(customerId, "guarantors");
  }

  async function submitSettings(form) {
    const body = formBody(form);
    const logo = form.querySelector('[name="logo_file"]')?.files?.[0];
    const orgBody = {};
    ["name", "registration_number", "tin", "license_number", "address", "phone", "email", "website", "brand_color", "city", "district", "country"]
      .forEach((key) => { if (body[key] !== undefined) orgBody[key] = body[key]; });
    if (logo) orgBody.logo_base64 = await imageAsDataUrl(logo);
    const orgId = state.organization?.id || state.settings?.organization_id;
    if (!orgId) throw new Error("Organization identity is not available. Reload settings before saving.");
    await request(`/api/mfi/organizations/${encodeURIComponent(orgId)}`, { method: "PATCH", body: orgBody });
    const settingsBody = {
      currency: String(body.currency || "UGX").toUpperCase(),
      default_interest_rate: Number(body.default_interest_rate),
      default_term_months: Number(body.default_term_months),
      default_repayment_frequency: body.default_repayment_frequency,
      late_fee_percent: Number(body.late_fee_percent),
      grace_period_days: Number(body.grace_period_days),
    };
    await request("/api/mfi/settings", { method: "PATCH", body: settingsBody });
    announce("Organization settings saved.");
    await loadSettings();
  }

  function formBody(form) {
    const body = {};
    new FormData(form).forEach((fieldValue, key) => {
      if (key.endsWith("_file")) return;
      body[key] = fieldValue;
    });
    return body;
  }

  async function imageAsDataUrl(file) {
    if (!file) return "";
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
    if (file.size <= IMAGE_LIMIT) return readAsDataUrl(file);
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      throw new Error("This image could not be compressed. Choose a JPEG, PNG, or WebP image under 150 KB.");
    }
    const canvas = document.createElement("canvas");
    let width = bitmap.width;
    let height = bitmap.height;
    let output = "";
    for (let attempt = 0; attempt < 9; attempt += 1) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0, width, height);
      output = canvas.toDataURL("image/jpeg", Math.max(.48, .88 - attempt * .055));
      if (approxBase64Bytes(output) <= IMAGE_LIMIT) break;
      width = Math.max(160, Math.round(width * .82));
      height = Math.max(160, Math.round(height * .82));
    }
    bitmap.close?.();
    if (approxBase64Bytes(output) > IMAGE_LIMIT) throw new Error("Image compression could not reach the 150 KB upload limit.");
    return output;
  }

  function approxBase64Bytes(dataUrl) {
    const encoded = dataUrl.split(",")[1] || "";
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    return Math.floor(encoded.length * 3 / 4) - padding;
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("The selected image could not be read."));
      reader.readAsDataURL(file);
    });
  }

  async function renderCustomerDetails(id, tab = "info") {
    if (!id) return;
    state.detailTab = tab;
    state.customerDetailsLoading = true;
    state.customerDetailsError = null;
    state.customer = state.customers.find((row) => row.id === id) || state.customer;
    state.currentGuarantors = state.currentGuarantors || [];
    const initial = customerDetailShell(id, tab, true);
    putModal(initial);
    try {
      const customerPayload = await request(`/api/mfi/customers/${encodeURIComponent(id)}`);
      state.customer = customerPayload?.customer || {};
      if (tab === "guarantors") {
        const guarantorPayload = await request(`/api/mfi/customers/${encodeURIComponent(id)}/guarantors`);
        state.currentGuarantors = listOf(guarantorPayload, "guarantors");
      }
      state.customerDetailsError = null;
    } catch (error) {
      state.customerDetailsError = error;
    } finally {
      state.customerDetailsLoading = false;
      putModal(customerDetailShell(id, tab, false));
    }
  }

  function customerDetailShell(id, tab, loading) {
    const customer = state.customer || {};
    const name = `${value(customer, "first_name", "")} ${value(customer, "last_name", "")}`.trim() || "Customer record";
    let body;
    if (loading) body = `<div class="mfi-modal-body">${skeletonRows(4)}</div>`;
    else if (state.customerDetailsError) body = `<div class="mfi-modal-body">${errorState(state.customerDetailsError, "customer-detail")}</div>`;
    else if (tab === "guarantors") {
      const rows = state.currentGuarantors?.length ? state.currentGuarantors.map((guarantor) => `<tr>
        <td class="mfi-primary-cell"><strong>${text(guarantor, "full_name")}</strong><span>${text(guarantor, "relationship")}</span></td><td>${text(guarantor, "phone")}</td><td>${text(guarantor, "national_id")}</td>
        <td><div class="mfi-row-actions"><button type="button" class="mfi-icon-btn" aria-label="Edit guarantor" title="Edit guarantor" data-action="edit-guarantor" data-id="${esc(guarantor.id)}">Edit</button>${isAdmin() ? `<button type="button" class="mfi-icon-btn" aria-label="Delete guarantor" title="Delete guarantor" data-action="delete-guarantor" data-id="${esc(guarantor.id)}">×</button>` : ""}</div></td>
      </tr>`).join("") : `<tr><td colspan="4">${emptyState("No guarantors recorded", "Add a trusted guarantor to this customer record.", "Add guarantor", "add-guarantor")}</td></tr>`;
      body = `<div class="mfi-modal-body"><div class="mfi-subtabs" role="tablist"><button type="button" data-detail-tab="info" data-id="${esc(id)}" aria-selected="false">Info</button><button type="button" data-detail-tab="guarantors" data-id="${esc(id)}" aria-selected="true">Guarantors <span>(${state.currentGuarantors?.length || 0})</span></button></div><div class="mfi-section-head"><div><h2>Guarantor details</h2><p>Contacts linked to ${esc(name)}.</p></div><button type="button" class="mfi-btn" data-action="add-guarantor">＋ Add guarantor</button></div><div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Guarantor</th><th>Phone</th><th>National ID</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    } else {
      const image = safeImage(customer.photo_base64);
      const details = [
        ["First name", customer.first_name], ["Last name", customer.last_name],
        ["Gender", customer.gender], ["Date of birth", customer.date_of_birth],
        ["National ID", customer.national_id], ["TIN", customer.tin],
        ["Phone", customer.phone], ["Email", customer.email],
        ["Occupation", customer.occupation], ["Monthly income", customer.monthly_income == null ? "" : money(customer.monthly_income)],
        ["Branch", customer.branch_name], ["Status", customer.status],
        ["Village", customer.village], ["District", customer.district],
        ["Address", customer.address], ["Spouse", customer.spouse_name],
        ["Spouse phone", customer.spouse_phone], ["Next of kin", customer.nok_name],
        ["Relationship", customer.nok_relationship], ["Next-of-kin phone", customer.nok_phone],
        ["Added", customer.created_at ? formattedDate(customer.created_at) : ""],
      ];
      body = `<div class="mfi-modal-body"><div class="mfi-subtabs" role="tablist"><button type="button" data-detail-tab="info" data-id="${esc(id)}" aria-selected="true">Info</button><button type="button" data-detail-tab="guarantors" data-id="${esc(id)}" aria-selected="false">Guarantors</button></div>
        ${image ? `<div style="margin:0 0 12px"><img src="${esc(image)}" alt="" style="width:76px;height:76px;object-fit:cover;border-radius:15px;border:1px solid var(--mfi-line)"></div>` : ""}
        <div class="mfi-info-grid">${details.map(([label, item]) => `<div class="mfi-info-item"><span>${esc(label)}</span><strong>${item === undefined || item === null || item === "" ? EMPTY : typeof item === "string" && item.startsWith("UGX ") ? item : esc(item)}</strong></div>`).join("")}</div></div>`;
    }
    return `<div class="mfi-modal-backdrop" data-modal-backdrop><section class="mfi-modal mfi-modal--wide" role="dialog" aria-modal="true" aria-label="${esc(name)}">
      <header class="mfi-modal-head"><div><h2>${esc(name)}</h2><p>Customer record · ${esc(customer.branch_name || "Branch not assigned")}</p></div><div class="mfi-action-row"><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-action="edit-customer" data-id="${esc(id)}">Edit record</button><button type="button" class="mfi-close" data-close-modal aria-label="Close">×</button></div></header>
      ${body}</section></div>`;
  }

  function confirmDelete(type, id, customerId = "") {
    const labels = { branch: "branch", officer: "officer", customer: "customer record", guarantor: "guarantor" };
    const label = labels[type] || "record";
    state.pendingDelete = { type, id, customerId };
    const body = `<div class="mfi-modal-body"><div class="mfi-state"><div class="mfi-state-symbol">!</div><strong>Confirm ${type === "officer" ? "deactivation" : "deletion"}</strong><p>${type === "officer" ? "This will deactivate the account and revoke its access." : `This will permanently delete this ${label}${type === "customer" ? " and its linked guarantors" : ""}. This action cannot be undone.`}</p></div></div>`;
    putModal(`<div class="mfi-modal-backdrop" data-modal-backdrop><section class="mfi-modal" role="dialog" aria-modal="true"><header class="mfi-modal-head"><div><h2>${type === "officer" ? "Deactivate officer?" : "Delete this record?"}</h2><p>Review before continuing.</p></div><button type="button" class="mfi-close" data-close-modal>×</button></header>${body}<footer class="mfi-modal-foot"><button type="button" class="mfi-btn mfi-btn--quiet" data-confirm-cancel>Cancel</button><button type="button" class="mfi-btn mfi-btn--danger" data-confirm-yes>${type === "officer" ? "Deactivate" : "Delete"}</button></footer></section></div>`);
  }

  async function performDelete(type, id, customerId) {
    const routes = {
      branch: `/api/mfi/branches/${encodeURIComponent(id)}`,
      officer: `/api/mfi/officers/${encodeURIComponent(id)}`,
      customer: `/api/mfi/customers/${encodeURIComponent(id)}`,
      guarantor: `/api/mfi/guarantors/${encodeURIComponent(id)}`,
    };
    try {
      await request(routes[type], { method: "DELETE" });
      closeModal();
      announce(type === "officer" ? "Officer deactivated." : `${type[0].toUpperCase()}${type.slice(1)} deleted.`);
      if (type === "branch") await loadBranches();
      if (type === "officer") await loadOfficers();
      if (type === "customer") await loadCustomers();
      if (type === "guarantor") await renderCustomerDetails(customerId, "guarantors");
    } catch (error) {
      announce(errorMessage(error), "error");
      state.pendingDelete = null;
      putModal(`<div class="mfi-modal-backdrop"><section class="mfi-modal" role="dialog" aria-modal="true"><header class="mfi-modal-head"><div><h2>Record not changed</h2><p>${esc(errorMessage(error))}</p></div><button type="button" class="mfi-close" data-close-modal>×</button></header><footer class="mfi-modal-foot"><button type="button" class="mfi-btn" data-close-modal>Close</button></footer></section></div>`);
    }
  }

  async function editCustomer(id) {
    try {
      const payload = await request(`/api/mfi/customers/${encodeURIComponent(id)}`);
      if (payload?.customer) openCustomerForm(payload.customer);
    } catch (error) {
      announce(errorMessage(error), "error");
    }
  }

  async function setUser(user) {
    state.user = user || (typeof getCurrentUser === "function" ? getCurrentUser() : null);
    state.tab = "dashboard";
    state.organization = null;
    state.stats = null;
    state.audit = [];
    state.customers = [];
    state.branches = [];
    state.officers = [];
    state.settings = null;
    state.search = "";
    state.branchFilter = "";
    state.listError = null;
    state.dashboardError = null;
    if (portalHost) {
      portalFrame();
      if (isAdmin()) await activateTab("dashboard");
    }
  }

  function renderCommandShell() {
    if (!commandHost) return;
    commandHost.innerHTML = `<section class="mfi-command-panel"><div class="mfi-shell">${commandContent()}</div></section>`;
    commandHost.querySelector(".mfi-command-panel")?.addEventListener("click", handleCommandClick);
    commandHost.querySelector(".mfi-command-panel")?.addEventListener("submit", handleCommandSubmit);
  }

  function commandContent() {
    if (state.commandLoading) return `<div class="mfi-page-intro"><div><p class="mfi-eyebrow">APSHULE · MFI OPERATIONS</p><h1>Microfinance organizations</h1><p>Organizations, branch reach, and customer records across the platform.</p></div></div><div class="mfi-metrics">${Array.from({ length: 4 }, () => '<div class="mfi-metric"><span>Loading</span><strong>—</strong></div>').join("")}</div><section class="mfi-panel">${skeletonRows(4)}</section>`;
    if (state.commandError) return `<div class="mfi-page-intro"><div><p class="mfi-eyebrow">APSHULE · MFI OPERATIONS</p><h1>Microfinance organizations</h1><p>Platform-wide MFI organization directory.</p></div></div><section class="mfi-panel"><div class="mfi-state mfi-error-state"><div class="mfi-state-symbol">!</div><strong>Command Center data unavailable</strong><p>${esc(errorMessage(state.commandError))}</p><button type="button" class="mfi-btn mfi-btn--quiet" data-command-retry>Try again</button></div></section>`;
    const stats = state.commandStats || {};
    const metrics = [
      ["Organizations", "organizations"],
      ["Branches", "branches"],
      ["Officers", "officers"],
      ["Customers", "customers"],
      ["Active customers", "active_customers"],
    ].map(([label, key]) => `<div class="mfi-metric"><span>${esc(label)}</span><strong>${esc(value(stats, key, 0))}</strong></div>`).join("");
    const orgRows = state.organizations.length ? state.organizations.map((org) => `<tr>
      <td><div class="mfi-brand-preview"><div class="mfi-brand-mark" style="background:${esc(safeColor(org.brand_color))}">${safeImage(org.logo_base64) ? `<img src="${esc(safeImage(org.logo_base64))}" alt="">` : "A."}</div><div class="mfi-primary-cell"><strong>${text(org, "name")}</strong><span>${text(org, "city")}${org.district ? `, ${text(org, "district")}` : ""}</span></div></div></td>
      <td>${text(org, "registration_number")}</td><td>${text(org, "admin_name")}</td><td>${text(org, "admin_email")}</td><td>${esc(value(org, "branch_count", 0))}</td><td>${esc(value(org, "customer_count", 0))}</td>
    </tr>`).join("") : `<tr><td colspan="6"><div class="mfi-state"><div class="mfi-state-symbol">·</div><strong>No MFI organizations yet</strong><p>Create the first organization to start platform operations.</p></div></td></tr>`;
    return `<div class="mfi-page-intro"><div><p class="mfi-eyebrow">APSHULE · MFI OPERATIONS</p><h1>Microfinance organizations</h1><p>Organization coverage and customer records across the platform.</p></div><button type="button" class="mfi-btn" data-command-add>＋ Add organization</button></div>
      <div class="mfi-metrics">${metrics}</div>
      ${state.commandFormOpen ? commandOrganizationForm() : ""}
      <section class="mfi-panel"><div class="mfi-section-head"><div><h2>Organization directory</h2><p>${state.organizations.length} organizations · live platform records</p></div></div><div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Organization</th><th>Registration</th><th>Administrator</th><th>Login email</th><th>Branches</th><th>Customers</th></tr></thead><tbody>${orgRows}</tbody></table></div></section>`;
  }

  function commandOrganizationForm() {
    return `<section class="mfi-panel mfi-inline-form"><div class="mfi-section-head"><div><h2>New MFI organization</h2><p>Create the organization profile and first administrator login.</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-command-cancel>Cancel</button></div>
      <form data-command-form><div class="mfi-form-grid">
        ${field("Organization name", "name", "", "text", true)}
        ${field("Administrator name", "adminName")}
        ${field("Administrator login email", "loginEmail", "", "email", true)}
        ${field("Temporary password", "loginPassword", "", "password", true, "", 'minlength="8"')}
        ${field("Registration number", "registration_number")}
        ${field("TIN", "tin")}
        ${field("License number", "license_number")}
        ${field("Phone", "phone", "", "tel")}
        ${field("Organization email", "email", "", "email")}
        ${field("Website", "website", "", "url")}
        ${field("City", "city")}
        ${field("District", "district")}
        ${field("Country", "country", "Uganda")}
        ${field("Address", "address", "", "text", false, "mfi-span-2")}
        <div class="mfi-field"><label for="cc-brand-color">Portal brand color</label><input id="cc-brand-color" class="mfi-control" type="color" name="brand_color" value="#17645f"></div>
        <div class="mfi-field"><label for="cc-logo-file">Logo</label><input id="cc-logo-file" class="mfi-control" type="file" name="logo_file" accept="image/jpeg,image/png,image/webp"><small>Max 150 KB before upload.</small></div>
      </div><div class="mfi-action-row" style="justify-content:flex-start;margin-top:18px"><button class="mfi-btn" type="submit">Create organization</button></div></form>
    </section>`;
  }

  async function loadCommandCenter() {
    if (!commandHost) return;
    state.commandLoading = true;
    state.commandError = "";
    renderCommandShell();
    try {
      const [statsPayload, organizationsPayload] = await Promise.all([
        request("/api/mfi/stats"),
        request("/api/mfi/organizations"),
      ]);
      state.commandStats = statsPayload?.stats || {};
      state.organizations = listOf(organizationsPayload, "organizations");
      state.commandError = "";
    } catch (error) {
      state.commandError = error;
    } finally {
      state.commandLoading = false;
      renderCommandShell();
    }
  }

  function handleCommandClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-command-add")) {
      state.commandFormOpen = !state.commandFormOpen;
      renderCommandShell();
    } else if (button.hasAttribute("data-command-cancel")) {
      state.commandFormOpen = false;
      renderCommandShell();
    } else if (button.hasAttribute("data-command-retry")) {
      loadCommandCenter();
    }
  }

  async function handleCommandSubmit(event) {
    const form = event.target.closest("[data-command-form]");
    if (!form) return;
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Creating…";
    const body = formBody(form);
    try {
      const logo = form.querySelector('[name="logo_file"]')?.files?.[0];
      if (logo) body.logo_base64 = await imageAsDataUrl(logo);
      await request("/api/mfi/organizations", { method: "POST", body });
      announce("MFI organization created.");
      state.commandFormOpen = false;
      await loadCommandCenter();
    } catch (error) {
      showFormError(form, errorMessage(error));
      announce(errorMessage(error), "error");
      submit.disabled = false;
      submit.textContent = "Create organization";
    }
  }

  if (portalHost) {
    portalFrame();
    if (isAdmin()) activateTab("dashboard");
    else if (canSeeCustomers()) activateTab("customers");
  }
  if (commandHost) {
    renderCommandShell();
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && portal()?.querySelector(".mfi-modal-backdrop")) closeModal();
  });

  return {
    setUser,
    loadCommandCenter,
  };
}

export default initMfiUI;