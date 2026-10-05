const MFI_TABS = [
  ["dashboard", "Dashboard"],
  ["branches", "Branches"],
  ["customers", "Customers"],
  ["collateral", "Collateral"],
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
const COLLATERAL_IMAGE_LIMIT = 200 * 1024;
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
    collateralRecords: [],
    collateralSummary: null,
    collateralTypes: [],
    collateralCustomers: [],
    valuers: [],
    legalOfficers: [],
    collateralFilters: { customer_id: "", status: "", type_id: "" },
    collateralDetail: null,
    collateralDetailId: null,
    settingsSubtab: "profile",
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
    const visibleTabs = isAdmin()
      ? MFI_TABS
      : MFI_TABS.filter(([key]) => ["dashboard", "customers", "collateral"].includes(key));
    const title = {
      dashboard: "Operations at a glance",
      branches: "Branches",
      customers: "Customer records",
      collateral: "Collateral management",
      officers: "Officers",
      settings: "Organization settings",
      reports: "Reports",
    }[state.tab] || "Operations";
    const subline = {
      dashboard: "A clear view of your organization’s day-to-day activity.",
      branches: "Maintain locations and the managers accountable for each one.",
      customers: "Find and maintain customer records, identity, and guarantor details.",
      collateral: "Register, score, review, and verify customer collateral.",
      officers: "Keep staff access, roles, and branch assignments current.",
      settings: "Organization profile and operating defaults.",
      reports: "Reporting tools are planned for Phase 3C.",
    }[state.tab];
    return `
      <div class="mfi-page-intro">
        <div><p class="mfi-eyebrow">Microfinance · Phase 3B</p><h1>${esc(title)}</h1><p>${esc(subline)}</p></div>
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
    if (state.tab === "collateral") return collateralView();
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

  const COLLATERAL_STATUSES = [
    ["draft", "Draft"], ["pending_review", "Pending review"], ["approved", "Approved"],
    ["rejected", "Rejected"], ["awaiting_valuation", "Awaiting valuation"],
    ["valued", "Valued"], ["awaiting_legal", "Awaiting legal"],
    ["legal_cleared", "Legal cleared"], ["legal_issue", "Legal issue"],
  ];
  const statusLabel = (status) => COLLATERAL_STATUSES.find(([key]) => key === status)?.[1] || String(status || "Unknown").replaceAll("_", " ");

  function collateralView() {
    if (state.listLoading) return `<section class="mfi-panel">${skeletonRows(5)}</section>`;
    if (state.listError) return `<section class="mfi-panel">${errorState(state.listError, "collateral")}</section>`;
    if (state.collateralDetailId) return collateralDetailView();
    const summary = state.collateralSummary || {};
    const metrics = [
      ["Total collateral", value(summary, "total_collateral", 0)],
      ["Total value", money(value(summary, "total_value", 0))],
      ["Pending review", value(summary, "pending_review", 0)],
      ["Approved", value(summary, "approved", 0)],
    ];
    const rows = state.collateralRecords.length ? state.collateralRecords.map((record) => `<tr>
      <td class="mfi-primary-cell"><strong>${text(record, "title")}</strong><span>${text(record, "collateral_type_name", "Type not set")}</span></td>
      <td>${esc(`${value(record, "customer_first_name", "")} ${value(record, "customer_last_name", "")}`.trim() || "Customer")}</td>
      <td>${money(record.estimated_value, record.currency || "UGX")}</td>
      <td><span class="mfi-score-pill">${esc(record.score ?? "—")}</span></td>
      <td><span class="mfi-status ${["rejected", "legal_issue"].includes(record.status) ? "mfi-status--inactive" : record.status === "pending_review" ? "mfi-status--attention" : ""}">${esc(statusLabel(record.status))}</span></td>
      <td><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-action="collateral-detail" data-id="${esc(record.id)}">View record</button></td>
    </tr>`).join("") : `<tr><td colspan="6">${emptyState("No collateral records yet", "Register customer assets to begin review and verification.", "Add collateral", "add-collateral")}</td></tr>`;
    return `<section class="mfi-metrics">${metrics.map(([label, amount]) => `<div class="mfi-metric"><span class="mfi-metric-label">${esc(label)}</span><strong class="mfi-metric-value">${esc(amount)}</strong></div>`).join("")}</section>
      <section class="mfi-panel">
        <div class="mfi-section-head"><div><h2>Collateral register</h2><p>Scored assets, review status, valuation, and legal verification.</p></div><button type="button" class="mfi-btn" data-action="add-collateral">＋ Add collateral</button></div>
        <form class="mfi-toolbar" data-form="collateral-filter">
          <select class="mfi-control mfi-select-compact" name="customer_id" aria-label="Filter by customer"><option value="">All customers</option>${state.collateralCustomers.map((customer) => `<option value="${esc(customer.id)}" ${state.collateralFilters.customer_id === customer.id ? "selected" : ""}>${esc(`${customer.first_name} ${customer.last_name}`)}</option>`).join("")}</select>
          <select class="mfi-control mfi-select-compact" name="status" aria-label="Filter by status"><option value="">All statuses</option>${COLLATERAL_STATUSES.map(([key, label]) => `<option value="${key}" ${state.collateralFilters.status === key ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>
          <select class="mfi-control mfi-select-compact" name="type_id" aria-label="Filter by collateral type"><option value="">All types</option>${state.collateralTypes.map((type) => `<option value="${esc(type.id)}" ${state.collateralFilters.type_id === type.id ? "selected" : ""}>${text(type, "name")}</option>`).join("")}</select>
          <button type="submit" class="mfi-btn mfi-btn--quiet">Filter</button>
        </form>
        <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Title / Type</th><th>Customer</th><th>Value</th><th>Score</th><th>Status</th><th>Record</th></tr></thead><tbody>${rows}</tbody></table></div>
      </section>`;
  }

  function collateralDetailView() {
    const record = state.collateralDetail;
    if (state.collateralDetailLoading) return `<section class="mfi-panel">${skeletonRows(5)}</section>`;
    if (state.collateralDetailError) return `<section class="mfi-panel">${errorState(state.collateralDetailError, "collateral-detail")}</section>`;
    if (!record) return `<section class="mfi-panel">${emptyState("Collateral record unavailable", "This record may have been removed.")}</section>`;
    const photos = Array.isArray(record.photos) ? record.photos : [];
    const docs = Array.isArray(record.documents) ? record.documents : [];
    const score = record.score_breakdown && typeof record.score_breakdown === "object" ? record.score_breakdown : {};
    const components = [
      ["Type", score.type], ["Value tier", score.value],
      ["Condition", score.condition], ["Documents", score.documents],
    ].filter(([, item]) => item);
    const timeline = state.collateralTimeline?.length ? state.collateralTimeline.map((item) => {
      const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
      const note = metadata.notes || metadata.reason || metadata.valuation_notes || "";
      const statusText = metadata.status_to ? ` · ${statusLabel(metadata.status_to)}` : "";
      return `<li class="mfi-timeline-item"><span class="mfi-timeline-dot"></span><div><strong>${esc(actionLabel(item.action))}${esc(statusText)}</strong><p>${esc(note || item.actor_name || "Activity recorded")}</p><time>${formattedDate(item.created_at)}</time></div></li>`;
    }).join("") : `<li class="mfi-timeline-empty">No recorded activity yet.</li>`;
    const requiredValuation = record.requires_valuation !== false;
    const requiredLegal = record.requires_legal === true;
    let actions = "";
    if (record.status === "draft") actions = `<button class="mfi-btn" data-collateral-action="submit" data-id="${esc(record.id)}">Submit for review</button>`;
    if (record.status === "rejected" && (isAdmin() || role() === "loan_manager")) actions = `<button class="mfi-btn" data-action="edit-collateral" data-id="${esc(record.id)}">Edit and resubmit</button>`;
    if (record.status === "pending_review" && (isAdmin() || role() === "loan_manager")) actions = `<button class="mfi-btn" data-collateral-action="approve" data-id="${esc(record.id)}">Approve</button><button class="mfi-btn mfi-btn--danger" data-collateral-action="reject" data-id="${esc(record.id)}">Reject</button>`;
    if (record.status === "approved" && requiredValuation) actions = `<button class="mfi-btn" data-collateral-action="assign-valuer" data-id="${esc(record.id)}">Assign valuer</button>`;
    if (record.status === "approved" && !requiredValuation && requiredLegal) actions = `<button class="mfi-btn" data-collateral-action="assign-legal" data-id="${esc(record.id)}">Assign legal officer</button>`;
    if (record.status === "approved" && !requiredValuation && !requiredLegal) actions = `<span class="mfi-status">Workflow complete</span>`;
    if (record.status === "awaiting_valuation") actions = `<button class="mfi-btn" data-collateral-action="record-valuation" data-id="${esc(record.id)}">Record valuation</button>`;
    if (record.status === "valued" && requiredLegal) actions = `<button class="mfi-btn" data-collateral-action="assign-legal" data-id="${esc(record.id)}">Assign legal officer</button>`;
    if (record.status === "valued" && !requiredLegal && (isAdmin() || role() === "loan_manager")) actions = `<button class="mfi-btn" data-collateral-action="complete" data-id="${esc(record.id)}">Complete</button>`;
    if (record.status === "awaiting_legal") actions = `<button class="mfi-btn" data-collateral-action="record-legal" data-id="${esc(record.id)}">Record legal outcome</button>`;
    if (record.status === "legal_cleared" && (isAdmin() || role() === "loan_manager")) actions = `<button class="mfi-btn" data-collateral-action="complete" data-id="${esc(record.id)}">Complete</button>`;
    const valuation = record.valuation_report && typeof record.valuation_report === "object" ? record.valuation_report : null;
    return `<section class="mfi-panel mfi-collateral-detail">
      <div class="mfi-section-head"><div><button type="button" class="mfi-link-button" data-action="collateral-back">← Back to collateral</button><h2>${text(record, "title")}</h2><p>${text(record, "collateral_type_name")} · ${esc(`${value(record, "customer_first_name", "")} ${value(record, "customer_last_name", "")}`.trim())}</p></div>
        <div class="mfi-action-row">${record.status === "draft" || record.status === "rejected" ? `<button type="button" class="mfi-btn mfi-btn--quiet" data-action="edit-collateral" data-id="${esc(record.id)}">Edit</button>` : ""}${isAdmin() ? `<button type="button" class="mfi-btn mfi-btn--danger mfi-btn--small" data-action="delete-collateral" data-id="${esc(record.id)}">Delete</button>` : ""}</div>
      </div>
      <div class="mfi-collateral-status-line"><span class="mfi-status ${["rejected", "legal_issue"].includes(record.status) ? "mfi-status--inactive" : record.status === "pending_review" ? "mfi-status--attention" : ""}">${esc(statusLabel(record.status))}</span><span>Created ${formattedDate(record.created_at)}</span></div>
      <div class="mfi-collateral-detail-grid">
        <article class="mfi-subpanel"><h3>Collateral details</h3><div class="mfi-info-grid">
          ${[
            ["Estimated value", money(record.estimated_value, record.currency || "UGX")],
            ["Condition", value(record, "condition")], ["Location", value(record, "location")],
            ["Branch", value(record, "branch_name")], ["Valuer", value(record, "valuer_name")],
            ["Legal officer", value(record, "legal_officer_name")], ["Legal outcome", value(record, "legal_status")],
          ].map(([label, content]) => `<div class="mfi-info-item"><span>${esc(label)}</span><strong>${content === EMPTY ? EMPTY : esc(content || EMPTY)}</strong></div>`).join("")}
        </div>${record.description ? `<p class="mfi-collateral-description">${text(record, "description")}</p>` : ""}</article>
        <article class="mfi-subpanel mfi-score-card"><div class="mfi-section-head"><div><h3>Collateral score</h3><p>Weighted risk and evidence score</p></div><strong class="mfi-score-large">${esc(record.score ?? "—")}<small>/100</small></strong></div>
          ${components.map(([label, item]) => `<div class="mfi-score-row"><span>${esc(label)} · ${Math.round(Number(item.weight) * 100)}%</span><strong>${esc(item.score)} <small>+${Number(item.weighted).toFixed(1)}</small></strong></div>`).join("")}
        </article>
      </div>
      ${photos.length ? `<article class="mfi-subpanel"><h3>Photos</h3><div class="mfi-photo-gallery">${photos.map((photo) => safeImage(photo)).filter(Boolean).map((photo) => `<img src="${esc(photo)}" alt="Collateral photo">`).join("")}</div></article>` : ""}
      <article class="mfi-subpanel"><h3>Documents</h3>${docs.length ? `<ul class="mfi-document-list">${docs.map((doc) => {
        const label = typeof doc === "string" ? doc : doc?.name || doc?.title || doc?.url || "Supporting document";
        const url = typeof doc === "object" && doc ? doc.url || doc.href : "";
        return `<li>${url && /^https?:\/\//i.test(String(url)) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label)}</li>`;
      }).join("")}</ul>` : `<p class="mfi-muted-copy">No supporting documents attached.</p>`}${valuation ? `<div class="mfi-valuation-note"><strong>Valuation report</strong><span>${money(valuation.amount, record.currency || "UGX")} · ${formattedDate(valuation.valuation_date)}</span><p>${esc(valuation.notes || "No valuation notes.")}</p></div>` : ""}</article>
      <article class="mfi-subpanel"><h3>Workflow history and notes</h3><ol class="mfi-timeline">${timeline}</ol></article>
      <div class="mfi-action-row mfi-collateral-actions">${actions}</div>
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
    const tabs = [
      ["profile", "Organization profile"],
      ["collateral-types", "Collateral types"],
      ["valuers", "Valuers"],
      ["legal-officers", "Legal officers"],
    ];
    const content = state.settingsSubtab === "profile"
      ? settingsProfileView()
      : state.settingsSubtab === "collateral-types"
        ? collateralTypeSettingsView()
        : registrySettingsView(state.settingsSubtab);
    return `<nav class="mfi-subtabs mfi-settings-tabs" role="tablist" aria-label="Organization settings">
      ${tabs.map(([key, label]) => `<button type="button" data-settings-tab="${key}" aria-selected="${state.settingsSubtab === key ? "true" : "false"}">${esc(label)}</button>`).join("")}
    </nav>${content}`;
  }

  function settingsProfileView() {
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
        ${field("Grace period (days)", "grace_period_days", settings.grace_period_days ?? "7", "number", true, "", 'step="1" min="0"')}
      </div>
      <div class="mfi-action-row" style="justify-content:flex-start;margin-top:20px"><button type="submit" class="mfi-btn">Save settings</button></div>
    </form>`;
  }

  function collateralTypeSettingsView() {
    const rows = state.collateralTypes.length ? state.collateralTypes.map((type) => `<tr>
      <td class="mfi-primary-cell"><strong>${text(type, "name")}</strong><span>${text(type, "code")}</span></td>
      <td>${text(type, "category")}</td><td>${esc(type.base_score ?? 50)}</td>
      <td>${type.requires_valuation ? "Required" : "No"}</td><td>${type.requires_legal ? "Required" : "No"}</td>
      <td><div class="mfi-row-actions"><button type="button" class="mfi-icon-btn" data-action="edit-collateral-type" data-id="${esc(type.id)}">Edit</button><button type="button" class="mfi-icon-btn" data-action="delete-collateral-type" data-id="${esc(type.id)}" aria-label="Deactivate ${text(type, "name")}">×</button></div></td>
    </tr>`).join("") : `<tr><td colspan="6">${emptyState("No collateral types", "Seed the standard collateral catalog or add a custom type.")}</td></tr>`;
    return `<section class="mfi-panel"><div class="mfi-section-head"><div><h2>Collateral types</h2><p>Organization-specific score baselines and verification requirements.</p></div><div class="mfi-action-row"><button type="button" class="mfi-btn mfi-btn--quiet" data-action="seed-collateral-types">Seed defaults</button><button type="button" class="mfi-btn" data-action="add-collateral-type">＋ Add type</button></div></div>
      <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Type</th><th>Category</th><th>Base score</th><th>Valuation</th><th>Legal</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  function registrySettingsView(tab) {
    const valuersTab = tab === "valuers";
    const records = valuersTab ? state.valuers : state.legalOfficers;
    const label = valuersTab ? "valuer" : "legal officer";
    const rows = records.length ? records.map((item) => `<tr>
      <td class="mfi-primary-cell"><strong>${text(item, "full_name")}</strong><span>${text(item, "email")}</span></td>
      <td>${text(item, "phone")}</td><td>${text(item, valuersTab ? "license_number" : "law_firm")}</td>
      <td><div class="mfi-row-actions"><button type="button" class="mfi-icon-btn" data-action="edit-registry" data-kind="${valuersTab ? "valuer" : "legal-officer"}" data-id="${esc(item.id)}">Edit</button><button type="button" class="mfi-icon-btn" data-action="delete-registry" data-kind="${valuersTab ? "valuer" : "legal-officer"}" data-id="${esc(item.id)}" aria-label="Deactivate ${text(item, "full_name")}">×</button></div></td>
    </tr>`).join("") : `<tr><td colspan="4">${emptyState(`No ${label}s added`, `Add approved external ${label} contacts for verification assignments.`)}</td></tr>`;
    return `<section class="mfi-panel"><div class="mfi-section-head"><div><h2>${valuersTab ? "External valuers" : "External legal officers"}</h2><p>Maintain organization contacts available during collateral verification.</p></div><button type="button" class="mfi-btn" data-action="add-registry" data-kind="${valuersTab ? "valuer" : "legal-officer"}">＋ Add ${label}</button></div>
      <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Name / Email</th><th>Phone</th><th>${valuersTab ? "License" : "Law firm"}</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
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
    const allowed = isAdmin() ? MFI_TABS.map(([key]) => key) : ["dashboard", "customers", "collateral"];
    if (!allowed.includes(tab)) return;
    state.tab = tab;
    state.listError = null;
    state.listLoading = ["branches", "customers", "collateral", "officers", "settings"].includes(tab);
    state.dashboardError = null;
    state.dashboardLoading = tab === "dashboard" && isAdmin();
    renderPortalView();
    if (tab === "dashboard" && isAdmin()) await loadDashboard();
    if (tab === "branches") await loadBranches();
    if (tab === "customers") await loadCustomers();
    if (tab === "collateral") await loadCollateral();
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

  async function loadCollateral() {
    state.listLoading = true;
    state.listError = null;
    renderPortalView();
    try {
      const params = new URLSearchParams();
      Object.entries(state.collateralFilters).forEach(([key, current]) => {
        if (current) params.set(key, current);
      });
      const query = params.toString();
      const [listPayload, summaryPayload, typePayload, customerPayload] = await Promise.all([
        request(`/api/mfi/collateral${query ? `?${query}` : ""}`),
        request("/api/mfi/collateral/summary"),
        request("/api/mfi/collateral-types"),
        request("/api/mfi/customers"),
      ]);
      state.collateralRecords = listOf(listPayload, "collateral");
      state.collateralSummary = summaryPayload?.summary || {};
      state.collateralTypes = listOf(typePayload, "types");
      state.collateralCustomers = listOf(customerPayload, "customers");
      if (isAdmin()) {
        const [valuerPayload, legalPayload] = await Promise.all([
          request("/api/mfi/valuers"),
          request("/api/mfi/legal-officers"),
        ]);
        state.valuers = listOf(valuerPayload, "valuers");
        state.legalOfficers = listOf(legalPayload, "legal-officers");
      } else {
        state.valuers = [];
        state.legalOfficers = [];
      }
    } catch (error) {
      state.listError = error;
    } finally {
      state.listLoading = false;
      renderPortalView();
    }
  }

  async function loadCollateralDetail(id) {
    state.collateralDetailId = id;
    state.collateralDetailLoading = true;
    state.collateralDetailError = null;
    renderPortalView();
    try {
      const payload = await request(`/api/mfi/collateral/${encodeURIComponent(id)}`);
      state.collateralDetail = payload?.collateral || null;
      state.collateralTimeline = listOf(payload, "timeline");
    } catch (error) {
      state.collateralDetailError = error;
    } finally {
      state.collateralDetailLoading = false;
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
      const [settingsPayload, orgPayload, typePayload, valuerPayload, legalPayload] = await Promise.all([
        request("/api/mfi/settings"),
        request("/api/mfi/organizations"),
        request("/api/mfi/collateral-types"),
        request("/api/mfi/valuers"),
        request("/api/mfi/legal-officers"),
      ]);
      state.settings = settingsPayload?.settings || {};
      state.collateralTypes = listOf(typePayload, "types");
      state.valuers = listOf(valuerPayload, "valuers");
      state.legalOfficers = listOf(legalPayload, "legal-officers");
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
      if (target.dataset.retry === "collateral-detail") {
        loadCollateralDetail(state.collateralDetailId);
        return;
      }
      activateTab(target.dataset.retry);
      return;
    }
    if (target.dataset.settingsTab) {
      state.settingsSubtab = target.dataset.settingsTab;
      renderPortalView();
      return;
    }
    if (target.dataset.collateralAction) {
      handleCollateralAction(target.dataset.collateralAction, target.dataset.id);
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
    if (action === "add-collateral") openCollateralForm();
    if (action === "collateral-detail") loadCollateralDetail(id);
    if (action === "collateral-back") {
      state.collateralDetail = null;
      state.collateralDetailId = null;
      state.collateralTimeline = [];
      renderPortalView();
    }
    if (action === "edit-collateral") {
      const record = state.collateralRecords.find((row) => row.id === id) || state.collateralDetail;
      if (record) openCollateralForm(record);
    }
    if (action === "delete-collateral") confirmDelete("collateral", id);
    if (action === "seed-collateral-types") seedCollateralTypes();
    if (action === "add-collateral-type") openCollateralTypeForm();
    if (action === "edit-collateral-type") openCollateralTypeForm(state.collateralTypes.find((row) => row.id === id));
    if (action === "delete-collateral-type") confirmDelete("collateral-type", id);
    if (action === "add-registry") openRegistryForm(target.dataset.kind);
    if (action === "edit-registry") {
      const records = target.dataset.kind === "valuer" ? state.valuers : state.legalOfficers;
      openRegistryForm(target.dataset.kind, records.find((row) => row.id === id));
    }
    if (action === "delete-registry") confirmDelete(target.dataset.kind, id);
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
    if (type === "collateral-filter") {
      const data = new FormData(form);
      state.collateralFilters = {
        customer_id: String(data.get("customer_id") || ""),
        status: String(data.get("status") || ""),
        type_id: String(data.get("type_id") || ""),
      };
      await loadCollateral();
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
      else if (type === "collateral") await submitCollateral(form);
      else if (type === "collateral-action") await submitCollateralAction(form);
      else if (type === "collateral-type") await submitCollateralType(form);
      else if (type === "valuer" || type === "legal-officer") await submitRegistry(form, type);
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
    if (
      control.closest('[data-form="collateral-filter"]') &&
      ["customer_id", "status", "type_id"].includes(control.name)
    ) {
      const form = control.closest("form");
      const data = new FormData(form);
      state.collateralFilters = {
        customer_id: String(data.get("customer_id") || ""),
        status: String(data.get("status") || ""),
        type_id: String(data.get("type_id") || ""),
      };
      await loadCollateral();
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

  function openCollateralForm(record = null) {
    const editing = Boolean(record);
    const customerItems = state.collateralCustomers.map((customer) => ({
      value: customer.id,
      label: `${customer.first_name} ${customer.last_name}${customer.phone ? ` · ${customer.phone}` : ""}`,
    }));
    const typeItems = state.collateralTypes.map((type) => ({
      value: type.id, label: `${type.name} · base ${type.base_score}`,
    }));
    const conditionItems = ["excellent", "good", "fair", "poor"].map((value) => ({
      value, label: value[0].toUpperCase() + value.slice(1),
    }));
    const existingDocs = Array.isArray(record?.documents)
      ? record.documents.map((doc) => typeof doc === "string" ? doc : doc?.name || doc?.title || "").filter(Boolean).join("\n")
      : "";
    const body = `<form id="mfi-modal-form" class="mfi-modal-body" data-form="collateral" data-id="${esc(record?.id || "")}">
      <div class="mfi-form-grid">
        ${selectField("Customer", "customer_id", customerItems, record?.customer_id, true)}
        ${selectField("Collateral type", "collateral_type_id", typeItems, record?.collateral_type_id, true)}
        ${field("Collateral title", "title", record?.title || "", "text", true)}
        ${field("Estimated value (UGX)", "estimated_value", record?.estimated_value ?? "", "number", true, "", 'min="0" step="0.01"')}
        ${selectField("Condition", "condition", conditionItems, record?.condition || "good", true)}
        ${field("Location", "location", record?.location || "")}
        <div class="mfi-field mfi-span-2"><label for="mfi-collateral-description">Description</label><textarea id="mfi-collateral-description" name="description" class="mfi-control">${esc(record?.description || "")}</textarea></div>
        <div class="mfi-field mfi-span-2"><label for="mfi-collateral-photos">Photos (each up to 200 KB)</label><input id="mfi-collateral-photos" class="mfi-control" type="file" name="photos_file" accept="image/jpeg,image/png,image/webp" multiple><small>JPEG, PNG, or WebP. New photos are added to any existing photos.</small></div>
        <div class="mfi-field mfi-span-2"><label for="mfi-collateral-documents">Supporting documents</label><textarea id="mfi-collateral-documents" name="documents_text" class="mfi-control" placeholder="One document name or link per line">${esc(existingDocs)}</textarea><small>Enter document names or secure links, one per line.</small></div>
      </div>
    </form>`;
    putModal(modalMarkup(editing ? "Edit collateral" : "Register collateral", "Record the asset and supporting evidence. Scoring updates automatically.", body, editing ? "Save changes" : "Create draft", true));
  }

  function openCollateralActionForm(action, id) {
    const record = state.collateralDetail || state.collateralRecords.find((item) => item.id === id);
    let title = "Update collateral workflow";
    let description = "Enter the required workflow details.";
    let body = "";
    if (action === "approve" || action === "reject") {
      title = action === "approve" ? "Approve collateral" : "Reject collateral";
      description = action === "approve" ? "Confirm review approval and add optional notes." : "A rejection reason is required.";
      body = `<div class="mfi-field"><label for="mfi-review-note">${action === "approve" ? "Review notes" : "Reason for rejection"}${action === "reject" ? " *" : ""}</label><textarea id="mfi-review-note" class="mfi-control" name="${action === "approve" ? "notes" : "reason"}" ${action === "reject" ? "required" : ""}></textarea></div>`;
    } else if (action === "assign-valuer") {
      title = "Assign a valuer";
      description = "Choose a registered valuer or enter an external contact.";
      body = `<div class="mfi-form-grid">${selectField("Registered valuer", "valuer_id", state.valuers.map((item) => ({ value: item.id, label: `${item.full_name}${item.license_number ? ` · ${item.license_number}` : ""}` })))}${field("Valuer name", "valuer_name", "", "text", !state.valuers.length)}${field("Valuer phone", "valuer_phone")}</div>`;
    } else if (action === "record-valuation") {
      title = "Record valuation";
      description = "Enter the assessed market value and report notes.";
      body = `<div class="mfi-form-grid">${field("Valuation amount (UGX)", "valuation_amount", record?.estimated_value ?? "", "number", true, "", 'min="0" step="0.01"')}${field("Valuation date", "valuation_date", new Date().toISOString().slice(0, 10), "date") }<div class="mfi-field mfi-span-2"><label for="mfi-valuation-notes">Valuation notes</label><textarea id="mfi-valuation-notes" name="valuation_notes" class="mfi-control"></textarea></div></div>`;
    } else if (action === "assign-legal") {
      title = "Assign legal review";
      description = "Choose a registered legal officer or enter an external contact.";
      body = `<div class="mfi-form-grid">${selectField("Registered legal officer", "legal_officer_id", state.legalOfficers.map((item) => ({ value: item.id, label: `${item.full_name}${item.law_firm ? ` · ${item.law_firm}` : ""}` })))}${field("Legal officer name", "legal_officer_name", "", "text", !state.legalOfficers.length)}</div>`;
    } else if (action === "record-legal") {
      title = "Record legal outcome";
      description = "Record whether the collateral title is clear or has an issue.";
      body = `${selectField("Legal outcome", "legal_status", [{ value: "clear", label: "Clear" }, { value: "disputed", label: "Disputed" }, { value: "encumbered", label: "Encumbered" }], "", true)}<div class="mfi-field"><label for="mfi-legal-notes">Notes</label><textarea id="mfi-legal-notes" name="notes" class="mfi-control"></textarea></div>`;
    }
    const form = `<form id="mfi-modal-form" class="mfi-modal-body" data-form="collateral-action" data-operation="${esc(action)}" data-id="${esc(id)}">${body}</form>`;
    putModal(modalMarkup(title, description, form, "Save and continue", true));
  }

  function handleCollateralAction(action, id) {
    if (!id) return;
    if (action === "submit" || action === "complete") {
      mutateCollateral(action, id, {}).catch((error) => announce(errorMessage(error), "error"));
      return;
    }
    openCollateralActionForm(action, id);
  }

  async function mutateCollateral(action, id, body) {
    const endpoint = {
      submit: `/api/mfi/collateral/${encodeURIComponent(id)}/submit`,
      approve: `/api/mfi/collateral/${encodeURIComponent(id)}/approve`,
      reject: `/api/mfi/collateral/${encodeURIComponent(id)}/reject`,
      "assign-valuer": `/api/mfi/collateral/${encodeURIComponent(id)}/assign-valuer`,
      "record-valuation": `/api/mfi/collateral/${encodeURIComponent(id)}/record-valuation`,
      "assign-legal": `/api/mfi/collateral/${encodeURIComponent(id)}/assign-legal`,
      "record-legal": `/api/mfi/collateral/${encodeURIComponent(id)}/record-legal`,
      complete: `/api/mfi/collateral/${encodeURIComponent(id)}/complete`,
    }[action];
    if (!endpoint) throw new Error("Unknown collateral workflow action.");
    await request(endpoint, { method: "POST", body });
    closeModal();
    announce("Collateral workflow updated.");
    await loadCollateral();
    await loadCollateralDetail(id);
  }

  async function submitCollateral(form) {
    const id = form.dataset.id;
    const body = formBody(form);
    body.estimated_value = Number(body.estimated_value);
    body.documents = String(body.documents_text || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
    delete body.documents_text;
    const current = id ? state.collateralDetail || state.collateralRecords.find((item) => item.id === id) : null;
    const files = [...(form.querySelector('[name="photos_file"]')?.files || [])];
    const existingPhotos = Array.isArray(current?.photos) ? current.photos : [];
    if (existingPhotos.length + files.length > 10) {
      throw new Error("A collateral record can contain at most 10 photos.");
    }
    const newPhotos = await Promise.all(files.map((file) => imageAsDataUrl(file, COLLATERAL_IMAGE_LIMIT)));
    body.photos = [...existingPhotos, ...newPhotos];
    await request(id ? `/api/mfi/collateral/${encodeURIComponent(id)}` : "/api/mfi/collateral", {
      method: id ? "PATCH" : "POST", body,
    });
    closeModal();
    announce(id ? "Collateral updated." : "Collateral draft created.");
    await loadCollateral();
  }

  async function submitCollateralAction(form) {
    const body = formBody(form);
    if (body.valuation_amount !== undefined) body.valuation_amount = Number(body.valuation_amount);
    if (body.valuer_id === "") delete body.valuer_id;
    if (body.legal_officer_id === "") delete body.legal_officer_id;
    if (body.valuation_date === "") delete body.valuation_date;
    if (form.dataset.operation === "assign-valuer" && !body.valuer_id && !body.valuer_name?.trim()) {
      throw new Error("Select a registered valuer or enter a valuer name.");
    }
    if (form.dataset.operation === "assign-legal" && !body.legal_officer_id && !body.legal_officer_name?.trim()) {
      throw new Error("Select a registered legal officer or enter a name.");
    }
    await mutateCollateral(form.dataset.operation, form.dataset.id, body);
  }

  async function seedCollateralTypes() {
    try {
      const result = await request("/api/mfi/collateral-types/seed-defaults", { method: "POST", body: {} });
      announce(`Added ${Number(result?.created || 0)} default collateral types.`);
      await loadSettings();
    } catch (error) {
      announce(error.message || "Could not seed collateral types.", "error");
    }
  }

  function openCollateralTypeForm(type = null) {
    const editing = Boolean(type);
    const body = `<form id="mfi-modal-form" class="mfi-modal-body" data-form="collateral-type" data-id="${esc(type?.id || "")}">
      <div class="mfi-form-grid">${field("Code", "code", type?.code || "", "text", true)}${field("Name", "name", type?.name || "", "text", true)}${field("Category", "category", type?.category || "")}${field("Base score (0–100)", "base_score", type?.base_score ?? 50, "number", true, "", 'min="0" max="100" step="1')}
        ${selectField("Valuation required", "requires_valuation", [{ value: "true", label: "Yes" }, { value: "false", label: "No" }], String(type?.requires_valuation !== false))}
        ${selectField("Legal review required", "requires_legal", [{ value: "true", label: "Yes" }, { value: "false", label: "No" }], String(type?.requires_legal === true))}
      </div></form>`;
    putModal(modalMarkup(editing ? "Edit collateral type" : "Add collateral type", "Set the type's base score and required verification steps.", body, editing ? "Save type" : "Create type"));
  }

  async function submitCollateralType(form) {
    const id = form.dataset.id;
    const body = formBody(form);
    body.base_score = Number(body.base_score);
    body.requires_valuation = body.requires_valuation === "true";
    body.requires_legal = body.requires_legal === "true";
    await request(id ? `/api/mfi/collateral-types/${encodeURIComponent(id)}` : "/api/mfi/collateral-types", {
      method: id ? "PATCH" : "POST", body,
    });
    announce(id ? "Collateral type updated." : "Collateral type created.");
    closeModal();
    await loadSettings();
  }

  function openRegistryForm(kind, record = null) {
    const editing = Boolean(record);
    const isValuer = kind === "valuer";
    const body = `<form id="mfi-modal-form" class="mfi-modal-body" data-form="${isValuer ? "valuer" : "legal-officer"}" data-id="${esc(record?.id || "")}">
      <div class="mfi-form-grid">${field("Full name", "full_name", record?.full_name || "", "text", true)}${field("Phone", "phone", record?.phone || "", "tel")}${field("Email", "email", record?.email || "", "email")}
        ${field(isValuer ? "License number" : "License number", "license_number", record?.license_number || "")}
        ${isValuer ? field("Address", "address", record?.address || "") : field("Law firm", "law_firm", record?.law_firm || "")}
        ${isValuer ? `<div class="mfi-field mfi-span-2"><label for="mfi-specializations">Specializations</label><textarea id="mfi-specializations" name="specializations" class="mfi-control">${esc(Array.isArray(record?.specializations) ? record.specializations.join(", ") : "")}</textarea></div>` : ""}
      </div></form>`;
    putModal(modalMarkup(`${editing ? "Edit" : "Add"} ${isValuer ? "valuer" : "legal officer"}`, "Keep external verification contacts current.", body, editing ? "Save contact" : "Add contact"));
  }

  async function submitRegistry(form, kind) {
    const id = form.dataset.id;
    const body = formBody(form);
    const path = kind === "valuer" ? "valuers" : "legal-officers";
    await request(id ? `/api/mfi/${path}/${encodeURIComponent(id)}` : `/api/mfi/${path}`, {
      method: id ? "PATCH" : "POST", body,
    });
    announce(id ? "Contact updated." : "Contact added.");
    closeModal();
    await loadSettings();
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

  async function imageAsDataUrl(file, limit = IMAGE_LIMIT) {
    if (!file) return "";
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
    if (file.size <= limit) return readAsDataUrl(file);
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      throw new Error(`This image could not be compressed. Choose a JPEG, PNG, or WebP image under ${Math.round(limit / 1024)} KB.`);
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
      if (approxBase64Bytes(output) <= limit) break;
      width = Math.max(160, Math.round(width * .82));
      height = Math.max(160, Math.round(height * .82));
    }
    bitmap.close?.();
    if (approxBase64Bytes(output) > limit) throw new Error(`Image compression could not reach the ${Math.round(limit / 1024)} KB upload limit.`);
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
    const labels = {
      branch: "branch", officer: "officer", customer: "customer record", guarantor: "guarantor",
      collateral: "collateral record", "collateral-type": "collateral type",
      valuer: "valuer contact", "legal-officer": "legal officer contact",
    };
    const label = labels[type] || "record";
    const deactivates = ["officer", "collateral-type", "valuer", "legal-officer"].includes(type);
    state.pendingDelete = { type, id, customerId };
    const warning = deactivates
      ? "This record will be deactivated and will no longer be available for new assignments."
      : `This will permanently delete this ${label}${type === "customer" ? " and its linked guarantors" : ""}. This action cannot be undone.`;
    const verb = deactivates ? "Deactivate" : "Delete";
    putModal(`<div class="mfi-modal-backdrop" data-modal-backdrop><section class="mfi-modal" role="dialog" aria-modal="true"><header class="mfi-modal-head"><div><h2>${verb} ${esc(label)}?</h2><p>Review before continuing.</p></div><button type="button" class="mfi-close" data-close-modal>×</button></header><div class="mfi-modal-body"><div class="mfi-state"><div class="mfi-state-symbol">!</div><strong>Confirm ${verb.toLowerCase()}</strong><p>${esc(warning)}</p></div></div><footer class="mfi-modal-foot"><button type="button" class="mfi-btn mfi-btn--quiet" data-confirm-cancel>Cancel</button><button type="button" class="mfi-btn mfi-btn--danger" data-confirm-yes>${verb}</button></footer></section></div>`);
  }

  async function performDelete(type, id, customerId) {
    const routes = {
      branch: `/api/mfi/branches/${encodeURIComponent(id)}`,
      officer: `/api/mfi/officers/${encodeURIComponent(id)}`,
      customer: `/api/mfi/customers/${encodeURIComponent(id)}`,
      guarantor: `/api/mfi/guarantors/${encodeURIComponent(id)}`,
      collateral: `/api/mfi/collateral/${encodeURIComponent(id)}`,
      "collateral-type": `/api/mfi/collateral-types/${encodeURIComponent(id)}`,
      valuer: `/api/mfi/valuers/${encodeURIComponent(id)}`,
      "legal-officer": `/api/mfi/legal-officers/${encodeURIComponent(id)}`,
    };
    try {
      await request(routes[type], { method: "DELETE" });
      closeModal();
      const deactivated = ["officer", "collateral-type", "valuer", "legal-officer"].includes(type);
      announce(deactivated ? `${labels[type] || "Record"} deactivated.` : `${labels[type] || "Record"} deleted.`);
      if (type === "branch") await loadBranches();
      if (type === "officer") await loadOfficers();
      if (type === "customer") await loadCustomers();
      if (type === "guarantor") await renderCustomerDetails(customerId, "guarantors");
      if (type === "collateral") {
        state.collateralDetail = null;
        state.collateralDetailId = null;
        await loadCollateral();
      }
      if (["collateral-type", "valuer", "legal-officer"].includes(type)) await loadSettings();
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
    state.collateralRecords = [];
    state.collateralSummary = null;
    state.collateralTypes = [];
    state.collateralCustomers = [];
    state.valuers = [];
    state.legalOfficers = [];
    state.collateralDetail = null;
    state.collateralDetailId = null;
    state.collateralDetailLoading = false;
    state.collateralDetailError = null;
    state.collateralTimeline = [];
    state.collateralFilters = { customer_id: "", status: "", type_id: "" };
    state.settings = null;
    state.settingsSubtab = "profile";
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
      ["Collateral records", "collateral"],
    ].map(([label, key]) => `<div class="mfi-metric"><span>${esc(label)}</span><strong>${esc(value(stats, key, 0))}</strong></div>`).join("");
    const orgRows = state.organizations.length ? state.organizations.map((org) => `<tr>
      <td><div class="mfi-brand-preview"><div class="mfi-brand-mark" style="background:${esc(safeColor(org.brand_color))}">${safeImage(org.logo_base64) ? `<img src="${esc(safeImage(org.logo_base64))}" alt="">` : "A."}</div><div class="mfi-primary-cell"><strong>${text(org, "name")}</strong><span>${text(org, "city")}${org.district ? `, ${text(org, "district")}` : ""}</span></div></div></td>
      <td>${text(org, "registration_number")}</td><td>${text(org, "admin_name")}</td><td>${text(org, "admin_email")}</td><td>${esc(value(org, "branch_count", 0))}</td><td>${esc(value(org, "customer_count", 0))}</td><td>${esc(value(org, "collateral_count", 0))}</td>
     </tr>`).join("") : `<tr><td colspan="7"><div class="mfi-state"><div class="mfi-state-symbol">·</div><strong>No MFI organizations yet</strong><p>Create the first organization to start platform operations.</p></div></td></tr>`;
    return `<div class="mfi-page-intro"><div><p class="mfi-eyebrow">APSHULE · MFI OPERATIONS</p><h1>Microfinance organizations</h1><p>Organization coverage and customer records across the platform.</p></div><button type="button" class="mfi-btn" data-command-add>＋ Add organization</button></div>
      <div class="mfi-metrics">${metrics}</div>
      ${state.commandFormOpen ? commandOrganizationForm() : ""}
       <section class="mfi-panel"><div class="mfi-section-head"><div><h2>Organization directory</h2><p>${state.organizations.length} organizations · live platform records</p></div></div><div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Organization</th><th>Registration</th><th>Administrator</th><th>Login email</th><th>Branches</th><th>Customers</th><th>Collateral</th></tr></thead><tbody>${orgRows}</tbody></table></div></section>`;
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