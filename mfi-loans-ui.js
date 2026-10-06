import { estimateMonthlyPayment } from "./mfi-loans-domain.mjs";

const APPLICATION_STATUSES = [
  "draft",
  "submitted",
  "pending_director",
  "approved",
  "disbursed",
  "rejected",
  "changes_requested",
  "cancelled",
];

export function createMfiLoansUI({
  request,
  escapeHtml,
  currentUser,
  announce,
  onRender,
  money,
  formattedDate,
}) {
  const state = {
    subtab: "applications",
    loading: false,
    error: null,
    products: [],
    applications: [],
    loans: [],
    officerPortfolio: [],
    customers: [],
    branches: [],
    stats: {},
    filters: { status: "", branch_id: "", search: "" },
    loanFilters: { status: "", branch_id: "", search: "" },
    detailId: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    productForm: null,
    applicationForm: null,
    reviewForm: null,
    collateralPickerOpen: false,
    availableCollateral: [],
    availableCollateralCustomer: "",
    confirmProductDeactivate: "",
    confirmCancelApplication: false,
    loanDetailId: null,
    loanDetail: null,
    loanSchedule: [],
    loanPayments: [],
    loanHistory: [],
    loanDetailTab: "overview",
    loanDetailLoading: false,
    loanDetailError: null,
    disbursementFormOpen: false,
    paymentFormOpen: false,
    creditNoteFormOpen: false,
    restructureFormOpen: false,
    writeOffFormOpen: false,
    reverseWriteOffFormOpen: false,
    reversePaymentId: "",
    receiptPaymentId: "",
  };

  const esc = (value) => {
    if (typeof escapeHtml === "function") return escapeHtml(value == null ? "" : String(value));
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  };
  const role = () => String(currentUser()?.role || "").toLowerCase();
  const isAdmin = () => role() === "mfi_admin";
  const isProductEditor = () => isAdmin() || role() === "loan_director";
  const isApplicationCreator = () => ["loan_officer", "loan_manager", "mfi_admin"].includes(role());
  const isManager = () => ["loan_manager", "mfi_admin"].includes(role());
  const isDirector = () => ["loan_director", "mfi_admin"].includes(role());
  const canDisburse = () => ["loan_manager", "loan_director", "mfi_admin"].includes(role());
  const canRecordPayments = () => ["loan_officer", "loan_manager", "mfi_admin"].includes(role());
  const canRestructure = () => ["loan_manager", "loan_director", "mfi_admin"].includes(role());
  const canWriteOff = () => ["loan_director", "mfi_admin", "superadmin"].includes(role());
  const records = (payload, key) => Array.isArray(payload?.[key]) ? payload[key] : [];
  const date = (value) => typeof formattedDate === "function" ? formattedDate(value) : value || "—";
  const amount = (value) => typeof money === "function" ? money(value) : `UGX ${Number(value || 0).toLocaleString()}`;
  const customerName = (record) =>
    `${record?.customer_first_name || record?.first_name || ""} ${record?.customer_last_name || record?.last_name || ""}`.trim() || "Customer";
  const statusLabel = (value) => String(value || "draft").replaceAll("_", " ");
  const statusBadge = (value) => {
    const safeStatus = APPLICATION_STATUSES.includes(value) ? value : "draft";
    return `<span class="mfi-loan-status mfi-loan-status--${safeStatus}">${esc(statusLabel(safeStatus))}</span>`;
  };
  const loanStatusBadge = (value) => {
    const safeStatus = ["active", "past_due", "defaulted", "completed", "written_off"].includes(value)
      ? value
      : "active";
    return `<span class="mfi-loan-status mfi-loan-status--${safeStatus}">${esc(statusLabel(safeStatus))}</span>`;
  };
  const scheduleStatusBadge = (value) => {
    const safeStatus = ["pending", "partial", "overdue", "paid", "restructured"].includes(value) ? value : "pending";
    return `<span class="mfi-loan-status mfi-loan-status--${safeStatus}">${esc(statusLabel(safeStatus))}</span>`;
  };
  const errorText = (error) => error?.message || "Something went wrong. Please try again.";
  const canManageProduct = () => isProductEditor();
  const applicationOwner = (application) => application?.created_by === currentUser()?.id;
  const managerOrOwner = (application) => isManager() || applicationOwner(application);

  function render() {
    const nav = `
      <nav class="mfi-subtabs mfi-loans-tabs" role="tablist" aria-label="Loan workspace">
        <button type="button" data-loan-subtab="products" aria-selected="${state.subtab === "products"}">Products</button>
        <button type="button" data-loan-subtab="applications" aria-selected="${state.subtab === "applications"}">Applications</button>
        <button type="button" data-loan-subtab="ready" aria-selected="${state.subtab === "ready"}">Ready to Disburse</button>
        <button type="button" data-loan-subtab="portfolio" aria-selected="${state.subtab === "portfolio"}">Loans</button>
      </nav>`;
    let content = "";
    if (state.loanDetailId) {
      content = state.loanDetailLoading
        ? loadingPanel("Loading loan account…")
        : state.loanDetailError
          ? `<section class="mfi-panel"><div class="mfi-state mfi-error-state"><div class="mfi-state-symbol">!</div><strong>Loan account unavailable</strong><p>${esc(errorText(state.loanDetailError))}</p><button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="retry-loan-detail">Try again</button></div></section>`
          : loanDetailView();
    } else if (state.detailId) {
      content = state.detailLoading
        ? loadingPanel("Loading application details…")
        : state.detailError
          ? `<section class="mfi-panel"><div class="mfi-state mfi-error-state"><div class="mfi-state-symbol">!</div><strong>Application detail unavailable</strong><p>${esc(errorText(state.detailError))}</p><button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="retry-detail">Try again</button></div></section>`
          : detailView();
    } else if (state.loading) {
      content = loadingPanel(state.subtab === "products" ? "Loading loan products…" : state.subtab === "portfolio" ? "Loading loan portfolio…" : "Loading loan applications…");
    } else if (state.error) {
      content = errorPanel(state.error, "Try again");
    } else if (state.subtab === "products") {
      content = productView();
    } else if (state.subtab === "ready") {
      content = readyView();
    } else if (state.subtab === "portfolio") {
      content = portfolioView();
    } else {
      content = applicationView();
    }
    return `<div class="mfi-loans">${nav}${state.error && !state.loading ? "" : ""}${content}</div>`;
  }

  function loadingPanel(message) {
    return `<section class="mfi-panel"><div class="mfi-state"><div class="mfi-state-symbol">…</div><strong>${esc(message)}</strong><p>Fetching current records.</p></div></section>`;
  }

  function errorPanel(error, label) {
    return `<section class="mfi-panel"><div class="mfi-state mfi-error-state"><div class="mfi-state-symbol">!</div><strong>Loan records unavailable</strong><p>${esc(errorText(error))}</p><button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="retry">${esc(label)}</button></div></section>`;
  }

  function productView() {
    const productRows = state.products.length
      ? state.products.map((product) => `
          <tr>
            <td><strong>${esc(product.code)}</strong></td>
            <td><button type="button" class="mfi-link-button" data-loan-action="edit-product" data-id="${esc(product.id)}">${esc(product.name)}</button><small>${esc(product.description || "")}</small></td>
            <td>${amount(product.min_amount)} – ${amount(product.max_amount)}</td>
            <td>${esc(product.interest_rate)}% <small>${esc(String(product.interest_method || "").replaceAll("_", " "))}</small></td>
            <td>${esc(product.term_months)} months</td>
            <td><span class="mfi-status ${product.requires_collateral ? "mfi-status--attention" : ""}">${product.requires_collateral ? "Required" : "No"}</span></td>
            <td><span class="mfi-status ${product.active === false ? "mfi-status--inactive" : ""}">${product.active === false ? "Inactive" : "Active"}</span></td>
            <td><div class="mfi-row-actions">
              ${canManageProduct() ? `<button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="edit-product" data-id="${esc(product.id)}">Edit</button>` : "—"}
              ${isAdmin() && product.active !== false ? `<button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="confirm-product-deactivate" data-id="${esc(product.id)}">Deactivate</button>` : ""}
              ${isAdmin() && product.active === false ? `<button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="activate-product" data-id="${esc(product.id)}">Reactivate</button>` : ""}
            </div></td>
          </tr>`).join("")
      : `<tr><td colspan="8"><div class="mfi-state"><div class="mfi-state-symbol">·</div><strong>No loan products yet</strong><p>Create a product before starting an application.</p>${canManageProduct() ? `<button type="button" class="mfi-btn" data-loan-action="new-product">＋ Add product</button>` : ""}</div></td></tr>`;
    return `
      <section class="mfi-panel">
        <div class="mfi-section-head"><div><h2>Loan products</h2><p>Rates, terms, fees, and approval thresholds for this organization.</p></div>
          ${canManageProduct() ? `<button type="button" class="mfi-btn" data-loan-action="new-product">＋ Add Product</button>` : ""}
        </div>
        ${state.productForm ? productFormView() : ""}
        ${state.confirmProductDeactivate ? productDeactivateConfirmation() : ""}
        <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Code</th><th>Name</th><th>Amount range</th><th>Interest</th><th>Term</th><th>Collateral?</th><th>Status</th><th>Actions</th></tr></thead><tbody>${productRows}</tbody></table></div>
      </section>`;
  }

  function productFormView() {
    const product = state.productForm || {};
    const editing = Boolean(product.id);
    const statusControl = isAdmin() && product.id && product.active === false
      ? `<div class="mfi-field"><label for="loan-product-active">Status</label><select id="loan-product-active" class="mfi-control" name="active"><option value="false" selected>Inactive</option><option value="true">Active</option></select><small>Only an MFI admin can reactivate a product.</small></div>`
      : `<div class="mfi-field"><label>Status</label><div class="mfi-control mfi-loan-readonly">${product.active === false ? "Inactive — only an MFI admin can reactivate this product" : "Active — deactivate from the product list"}</div></div>`;
    return `
      <section class="mfi-inline-form mfi-loan-form-panel">
        <div class="mfi-section-head"><div><h3>${editing ? "Edit loan product" : "New loan product"}</h3><p>All percentage fields use percent values, for example 22 for 22%.</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-product-form">Close</button></div>
        <form data-loan-form="product" data-id="${esc(product.id || "")}">
          <div class="mfi-form-grid">
            ${inputField("Product code", "code", product.code || "", "text", true, 'maxlength="40"')}
            ${inputField("Product name", "name", product.name || "", "text", true, 'maxlength="120"')}
            ${inputField("Description", "description", product.description || "", "text", false, 'maxlength="2000"')}
            ${inputField("Minimum amount (UGX)", "min_amount", product.min_amount ?? 50000, "number", true, 'min="0" step="any"')}
            ${inputField("Maximum amount (UGX)", "max_amount", product.max_amount ?? 5000000, "number", true, 'min="0" step="any"')}
            ${inputField("Default amount (UGX)", "default_amount", product.default_amount ?? "", "number", false, 'min="0" step="any"')}
            ${inputField("Annual interest rate (%)", "interest_rate", product.interest_rate ?? 24, "number", true, 'min="0" max="1000" step="any"')}
            <div class="mfi-field"><label for="loan-interest-method">Interest method *</label><select id="loan-interest-method" class="mfi-control" name="interest_method" required><option value="reducing_balance" ${product.interest_method !== "flat" ? "selected" : ""}>Reducing balance</option><option value="flat" ${product.interest_method === "flat" ? "selected" : ""}>Flat</option></select></div>
            ${inputField("Term (months)", "term_months", product.term_months ?? 12, "number", true, 'min="1" max="360" step="1"')}
            <div class="mfi-field"><label for="loan-repayment-frequency">Repayment frequency</label><select id="loan-repayment-frequency" class="mfi-control" name="repayment_frequency"><option value="monthly" ${!product.repayment_frequency || product.repayment_frequency === "monthly" ? "selected" : ""}>Monthly</option><option value="weekly" ${product.repayment_frequency === "weekly" ? "selected" : ""}>Weekly</option><option value="biweekly" ${product.repayment_frequency === "biweekly" ? "selected" : ""}>Biweekly</option></select></div>
            ${inputField("Processing fee (%)", "processing_fee_percent", product.processing_fee_percent ?? 2, "number", false, 'min="0" max="100" step="any"')}
            ${inputField("Insurance fee (%)", "insurance_fee_percent", product.insurance_fee_percent ?? 1, "number", false, 'min="0" max="100" step="any"')}
            ${inputField("Late fee (%)", "late_fee_percent", product.late_fee_percent ?? 2, "number", false, 'min="0" max="100" step="any"')}
            ${inputField("Grace period (days)", "grace_period_days", product.grace_period_days ?? 7, "number", false, 'min="0" max="365" step="1"')}
            <div class="mfi-field mfi-loan-check"><label><input class="mfi-control" type="checkbox" name="requires_collateral" value="true" ${product.requires_collateral ? "checked" : ""}> Requires collateral</label></div>
            ${inputField("Minimum collateral value (UGX)", "min_collateral_value", product.min_collateral_value ?? "", "number", false, 'min="0" step="any"')}
            ${inputField("Required guarantors", "requires_guarantors", product.requires_guarantors ?? 0, "number", false, 'min="0" max="20" step="1"')}
            ${inputField("Director approval threshold (UGX)", "director_approval_threshold", product.director_approval_threshold ?? 2000000, "number", false, 'min="0" step="any"')}
            ${statusControl}
          </div>
          <div class="mfi-loan-preview" data-loan-preview>${previewMarkup(product)}</div>
          <div class="mfi-action-row" style="justify-content:flex-start;margin-top:16px">
            <button class="mfi-btn" type="submit">${editing ? "Save product" : "Create product"}</button>
            <button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="close-product-form">Cancel</button>
          </div>
          <div class="mfi-form-error" data-loan-form-error hidden></div>
        </form>
      </section>`;
  }

  function previewMarkup(product) {
    try {
      const sample = Number(product.default_amount || product.min_amount || 50_000);
      const estimate = estimateMonthlyPayment(
        sample,
        Number(product.interest_rate ?? 24),
        Number(product.term_months ?? 12),
        product.interest_method === "flat" ? "flat" : "reducing_balance",
      );
      return `<div><strong>Repayment estimate</strong><p>${amount(estimate.monthlyPayment)} per month on a ${amount(sample)} sample loan over ${esc(product.term_months ?? 12)} months. Estimated total repayment: ${amount(estimate.totalRepayment)}.</p><small>Estimate excludes fees and is not a repayment schedule.</small></div>`;
    } catch (error) {
      return `<div><strong>Repayment estimate</strong><p>${esc(error.message)}</p></div>`;
    }
  }

  function productDeactivateConfirmation() {
    const product = state.products.find((item) => item.id === state.confirmProductDeactivate);
    if (!product) return "";
    return `<div class="mfi-state mfi-loan-confirm"><strong>Deactivate ${esc(product.name)}?</strong><p>Existing applications remain unchanged. The product will no longer be available for new applications.</p><div class="mfi-action-row"><button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="cancel-product-deactivate">Keep active</button><button type="button" class="mfi-btn mfi-btn--danger" data-loan-action="deactivate-product" data-id="${esc(product.id)}">Deactivate product</button></div></div>`;
  }

  function applicationView() {
    const applicationRows = state.applications.length
      ? state.applications.map((application) => `
          <tr>
            <td><button type="button" class="mfi-link-button" data-loan-action="open-application" data-id="${esc(application.id)}">${esc(application.reference)}</button></td>
            <td><strong>${esc(customerName(application))}</strong><small>${esc(application.customer_phone || "")}</small></td>
            <td>${esc(application.product_name || "Product removed")}</td>
            <td>${amount(application.requested_amount)}</td>
            <td>${statusBadge(application.status)}</td>
            <td>${date(application.submitted_at || application.created_at)}</td>
            <td><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="open-application" data-id="${esc(application.id)}">Open</button></td>
          </tr>`).join("")
      : `<tr><td colspan="7"><div class="mfi-state"><div class="mfi-state-symbol">·</div><strong>No applications match these filters</strong><p>Clear a filter or start a new loan application.</p>${isApplicationCreator() ? `<button type="button" class="mfi-btn" data-loan-action="new-application">＋ New Application</button>` : ""}</div></td></tr>`;
    return `
      <div class="mfi-metrics mfi-loan-metrics">
        ${metric("Pending", state.stats.pending_applications)}
        ${metric("Approved this month", state.stats.approved_this_month)}
        ${metric("Pipeline value", amount(state.stats.total_pipeline_value))}
        ${metric("Average ticket", amount(state.stats.avg_ticket_size))}
      </div>
      <section class="mfi-panel">
        <div class="mfi-section-head"><div><h2>Applications</h2><p>Drafts, reviews, and final decisions for this organization.</p></div>
          ${isApplicationCreator() ? `<button type="button" class="mfi-btn" data-loan-action="new-application">＋ New Application</button>` : ""}
        </div>
        <form class="mfi-toolbar mfi-loan-filters" data-loan-form="filters">
          <div class="mfi-field"><label for="loan-filter-status">Status</label><select id="loan-filter-status" class="mfi-control" name="status"><option value="">All statuses</option>${APPLICATION_STATUSES.map((status) => `<option value="${status}" ${state.filters.status === status ? "selected" : ""}>${esc(statusLabel(status))}</option>`).join("")}</select></div>
          <div class="mfi-field"><label for="loan-filter-branch">Branch</label><select id="loan-filter-branch" class="mfi-control" name="branch_id"><option value="">All branches</option>${state.branches.map((branch) => `<option value="${esc(branch.id)}" ${state.filters.branch_id === branch.id ? "selected" : ""}>${esc(branch.name)}</option>`).join("")}</select></div>
          <div class="mfi-field"><label for="loan-filter-search">Customer search</label><input id="loan-filter-search" class="mfi-control" name="search" type="search" value="${esc(state.filters.search)}" placeholder="Name, phone, or reference"></div>
          <button class="mfi-btn mfi-btn--quiet" type="submit">Apply filters</button>
        </form>
        ${state.applicationForm ? applicationFormView() : ""}
        <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Reference</th><th>Customer</th><th>Product</th><th>Amount</th><th>Status</th><th>Submitted</th><th>Actions</th></tr></thead><tbody>${applicationRows}</tbody></table></div>
      </section>`;
  }

  function readyView() {
    const rows = state.applications.length
      ? state.applications.map((application) => `
          <tr>
            <td><button type="button" class="mfi-link-button" data-loan-action="open-application" data-id="${esc(application.id)}">${esc(application.reference)}</button></td>
            <td>${esc(customerName(application))}<small>${esc(application.customer_phone || "")}</small></td>
            <td>${esc(application.product_name || "Product removed")}</td>
            <td>${amount(application.approved_amount ?? application.requested_amount)}</td>
            <td>${date(application.approved_at || application.updated_at)}</td>
            <td><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="open-application" data-id="${esc(application.id)}">View</button></td>
          </tr>`).join("")
      : `<tr><td colspan="6"><div class="mfi-state"><div class="mfi-state-symbol">·</div><strong>No approved applications yet</strong><p>Applications appear here after final approval.</p></div></td></tr>`;
    return `<section class="mfi-panel">
      <div class="mfi-section-head"><div><h2>Ready to disburse</h2><p>Approved applications awaiting the next phase.</p></div></div>
      <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Reference</th><th>Customer</th><th>Product</th><th>Approved amount</th><th>Approved</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  }

  function portfolioView() {
    const stats = state.stats || {};
    const loans = state.loans || [];
    const loanStatusOptions = ["active", "past_due", "defaulted", "completed", "written_off"];
    const rows = loans.length
      ? loans.map((loan) => `
          <tr>
            <td><button type="button" class="mfi-link-button" data-loan-action="open-loan" data-id="${esc(loan.id)}">${esc(loan.loan_number)}</button><small>${esc(loan.product_name || "Loan")}</small></td>
            <td><strong>${esc(customerName(loan))}</strong><small>${esc(loan.customer_phone || "")}</small></td>
            <td>${amount(loan.principal)}</td>
            <td>${amount(loan.outstanding_balance)}</td>
            <td>${loan.next_due_date ? date(loan.next_due_date) : "—"}${loan.next_due_balance != null ? `<small>${amount(loan.next_due_balance)}</small>` : ""}</td>
            <td>${loanStatusBadge(loan.status)}</td>
            <td>${esc(loan.days_overdue || 0)}</td>
            <td><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="open-loan" data-id="${esc(loan.id)}">Open</button></td>
          </tr>`).join("")
      : `<tr><td colspan="8"><div class="mfi-state"><div class="mfi-state-symbol">·</div><strong>No loans match these filters</strong><p>Approved applications appear here after disbursement.</p></div></td></tr>`;
    const officerRows = state.officerPortfolio.length
      ? state.officerPortfolio.map((officer) => `<tr><td>${esc(officer.officer_name || "Unassigned")}</td><td>${esc(officer.open_loans ?? 0)}</td><td>${amount(officer.total_disbursed)}</td><td>${amount(officer.outstanding_balance)}</td><td>${esc(officer.past_due_loans ?? 0)}</td><td>${esc(officer.defaulted_loans ?? 0)}</td></tr>`).join("")
      : `<tr><td colspan="6"><div class="mfi-state"><strong>No officer portfolio data</strong></div></td></tr>`;
    return `
      <section class="mfi-metrics mfi-loan-metrics mfi-portfolio-metrics">
        ${metric("Active loans", stats.active_loans)}
        ${metric("Total disbursed", amount(stats.total_disbursed))}
        ${metric("Outstanding", amount(stats.total_outstanding))}
        ${metric("Overdue", stats.overdue_count)}
        ${metric("Defaulted", stats.defaulted_count)}
      </section>
      <section class="mfi-panel">
        <div class="mfi-section-head"><div><h2>Loan portfolio</h2><p>Disbursed accounts, upcoming installments, and current arrears.</p></div></div>
        <form class="mfi-toolbar mfi-loan-filters" data-loan-form="loan-filters">
          <div class="mfi-field"><label for="servicing-status">Status</label><select id="servicing-status" class="mfi-control" name="status"><option value="">All statuses</option>${loanStatusOptions.map((status) => `<option value="${status}" ${state.loanFilters.status === status ? "selected" : ""}>${esc(statusLabel(status))}</option>`).join("")}</select></div>
          <div class="mfi-field"><label for="servicing-branch">Branch</label><select id="servicing-branch" class="mfi-control" name="branch_id"><option value="">All branches</option>${state.branches.map((branch) => `<option value="${esc(branch.id)}" ${state.loanFilters.branch_id === branch.id ? "selected" : ""}>${esc(branch.name)}</option>`).join("")}</select></div>
          <div class="mfi-field"><label for="servicing-officer">Officer</label><select id="servicing-officer" class="mfi-control" name="officer_id"><option value="">All officers</option>${state.officerPortfolio.filter((officer) => officer.officer_id).map((officer) => `<option value="${esc(officer.officer_id)}" ${state.loanFilters.officer_id === officer.officer_id ? "selected" : ""}>${esc(officer.officer_name)}</option>`).join("")}</select></div>
          <div class="mfi-field"><label for="servicing-customer">Customer</label><select id="servicing-customer" class="mfi-control" name="customer_id"><option value="">All customers</option>${state.customers.map((customer) => `<option value="${esc(customer.id)}" ${state.loanFilters.customer_id === customer.id ? "selected" : ""}>${esc(`${customer.first_name || ""} ${customer.last_name || ""}`.trim())} · ${esc(customer.phone || "No phone")}</option>`).join("")}</select></div>
          <div class="mfi-field"><label for="servicing-search">Search loan or customer</label><input id="servicing-search" class="mfi-control" type="search" name="search" value="${esc(state.loanFilters.search)}" placeholder="Loan number, name, or phone"></div>
          <button class="mfi-btn mfi-btn--quiet" type="submit">Apply filters</button>
        </form>
        <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Loan #</th><th>Customer</th><th>Principal</th><th>Outstanding</th><th>Next due</th><th>Status</th><th>Days overdue</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      </section>
      <section class="mfi-panel">
        <div class="mfi-section-head"><div><h2>Portfolio by officer</h2><p>Open balance and delinquency by assigned loan officer.</p></div></div>
        <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Officer</th><th>Open loans</th><th>Total disbursed</th><th>Outstanding</th><th>Past due</th><th>Defaulted</th></tr></thead><tbody>${officerRows}</tbody></table></div>
      </section>`;
  }

  function loanDetailView() {
    const payload = state.loanDetail || {};
    const loan = payload.loan || {};
    const total = Number(loan.total_repayable || 0);
    const paid = Number(loan.total_paid || 0);
    const progress = total > 0 ? Math.min(100, Math.max(0, Math.round((paid / total) * 100))) : 0;
    const nextSchedule = state.loanSchedule.find((schedule) => schedule.status !== "paid");
    const tabs = [
      ["overview", "Overview"],
      ["schedule", "Schedule"],
      ["payments", "Payments"],
      ["history", "History"],
    ];
    const actionButtons = [
      canRecordPayments() && ["active", "past_due", "defaulted"].includes(loan.status)
        ? `<button type="button" class="mfi-btn" data-loan-action="open-payment-form">Record payment</button>`
        : "",
      `<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="print-schedule">Print schedule</button>`,
      isManager() && ["active", "past_due", "defaulted"].includes(loan.status)
        ? `<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="open-credit-form">Issue credit note</button>`
        : "",
      canRestructure() && ["active", "past_due", "defaulted"].includes(loan.status)
        ? `<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="open-restructure-form">Restructure loan</button>`
        : "",
      canWriteOff() && ["active", "past_due", "defaulted"].includes(loan.status)
        ? `<button type="button" class="mfi-btn mfi-btn--danger" data-loan-action="open-writeoff-form">Write off</button>`
        : "",
      canWriteOff() && loan.status === "written_off"
        ? `<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="open-reverse-writeoff-form">Reverse write-off</button>`
        : "",
    ].filter(Boolean).join("");
    return `<section class="mfi-panel mfi-loan-detail">
      <div class="mfi-section-head">
        <div><button type="button" class="mfi-link-button" data-loan-action="back-to-portfolio">← Loans</button><h2>${esc(loan.loan_number || "Loan account")}</h2><p>${esc(customerName(loan))} · ${esc(loan.product_name || "Loan product")} · ${esc(loan.branch_name || "No branch")}</p></div>
        <div>${loanStatusBadge(loan.status)}${Number(loan.days_overdue) > 0 ? `<small class="mfi-loan-overdue">${esc(loan.days_overdue)} days overdue</small>` : ""}</div>
      </div>
      <div class="mfi-metrics mfi-loan-metrics">
        ${metric("Principal", amount(loan.principal))}
        ${metric("Total repayable", amount(loan.total_repayable))}
        ${metric("Paid", amount(loan.total_paid))}
        ${metric("Outstanding", amount(loan.outstanding_balance))}
      </div>
      <div class="mfi-loan-progress" aria-label="${progress}% repaid"><div class="mfi-loan-progress-track"><span style="width:${progress}%"></span></div><small>${progress}% repaid</small></div>
      <div class="mfi-action-row mfi-loan-detail-actions">${actionButtons}</div>
      <nav class="mfi-subtabs mfi-loan-detail-tabs" role="tablist" aria-label="Loan detail">
        ${tabs.map(([id, label]) => `<button type="button" data-loan-action="loan-detail-tab" data-tab="${id}" aria-selected="${state.loanDetailTab === id}">${esc(label)}</button>`).join("")}
      </nav>
      ${state.loanDetailTab === "overview" ? loanOverviewView(loan, nextSchedule)
        : state.loanDetailTab === "schedule" ? loanScheduleView()
          : state.loanDetailTab === "payments" ? loanPaymentsView()
            : loanHistoryView()}
      ${state.receiptPaymentId ? `<div class="mfi-loan-receipt-success" role="status"><div><strong>Payment recorded</strong><span>Receipt ${esc(state.loanPayments.find((item) => item.id === state.receiptPaymentId)?.receipt_number || "")}</span></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="print-receipt" data-id="${esc(state.receiptPaymentId)}">Open receipt</button><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="dismiss-receipt">Dismiss</button></div>` : ""}
      ${state.paymentFormOpen ? paymentFormView(loan, nextSchedule) : ""}
      ${state.creditNoteFormOpen ? creditNoteFormView() : ""}
      ${state.restructureFormOpen ? restructureFormView(loan) : ""}
      ${state.writeOffFormOpen ? writeOffFormView(loan) : ""}
      ${state.reverseWriteOffFormOpen ? reverseWriteOffFormView() : ""}
    </section>`;
  }

  function restructureFormView(loan) {
    return `<section class="mfi-inline-form mfi-loan-form-panel">
      <div class="mfi-section-head"><div><h3>Restructure loan</h3><p>The unpaid principal will be rescheduled. Unpaid interest and fees are added to the first new installment; repayment frequency stays unchanged.</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-restructure-form">Close</button></div>
      <form data-loan-form="restructure">
        <div class="mfi-form-grid">
          <div class="mfi-field"><label for="mfi-restructure-rate">New annual interest rate (%)</label><input id="mfi-restructure-rate" class="mfi-control" name="new_annual_rate" type="number" min="0" max="1000" step="any" value="${esc(loan.interest_rate ?? "")}"></div>
          <div class="mfi-field"><label for="mfi-restructure-term">New term (months)</label><input id="mfi-restructure-term" class="mfi-control" name="new_term_months" type="number" min="1" max="360" step="1" value="${esc(loan.term_months ?? "")}"></div>
          <div class="mfi-field"><label for="mfi-restructure-payment">Target installment (UGX, optional)</label><input id="mfi-restructure-payment" class="mfi-control" name="new_repayment_amount" type="number" min="1" step="1" placeholder="Leave blank to calculate from rate and term"></div>
          <div class="mfi-field mfi-span-2"><label for="mfi-restructure-reason">Reason for restructure *</label><textarea id="mfi-restructure-reason" class="mfi-control" name="reason" rows="3" minlength="5" maxlength="1000" required></textarea></div>
        </div>
        <div class="mfi-action-row" style="justify-content:flex-start;margin-top:14px"><button class="mfi-btn" type="submit">Save restructure</button><button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="close-restructure-form">Cancel</button></div>
        <div class="mfi-form-error" data-loan-form-error hidden></div>
      </form>
    </section>`;
  }

  function writeOffFormView(loan) {
    return `<section class="mfi-inline-form mfi-loan-form-panel">
      <div class="mfi-section-head"><div><h3>Write off loan</h3><p>Current outstanding balance: ${amount(loan.outstanding_balance)}. The write-off is recorded in the audit history and can be reversed by an authorised director or MFI administrator.</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-writeoff-form">Close</button></div>
      <form data-loan-form="write-off">
        <div class="mfi-form-grid">
          <div class="mfi-field"><label for="mfi-writeoff-amount">Write-off amount (UGX) *</label><input id="mfi-writeoff-amount" class="mfi-control" name="amount" type="number" min="1" max="${esc(loan.outstanding_balance || 0)}" step="1" required></div>
          <div class="mfi-field"><label for="mfi-writeoff-date">Write-off date *</label><input id="mfi-writeoff-date" class="mfi-control" name="write_off_date" type="date" max="${todayInKampala()}" value="${todayInKampala()}" required></div>
          <div class="mfi-field mfi-span-2"><label for="mfi-writeoff-reason">Reason *</label><textarea id="mfi-writeoff-reason" class="mfi-control" name="reason" rows="3" minlength="5" maxlength="1000" required></textarea></div>
        </div>
        <div class="mfi-action-row" style="justify-content:flex-start;margin-top:14px"><button class="mfi-btn mfi-btn--danger" type="submit">Confirm write-off</button><button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="close-writeoff-form">Cancel</button></div>
        <div class="mfi-form-error" data-loan-form-error hidden></div>
      </form>
    </section>`;
  }

  function reverseWriteOffFormView() {
    return `<section class="mfi-inline-form mfi-loan-form-panel">
      <div class="mfi-section-head"><div><h3>Reverse write-off</h3><p>This restores the loan's status and outstanding balance as they were immediately before the write-off. Add a reason for the audit trail.</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-reverse-writeoff-form">Close</button></div>
      <form data-loan-form="reverse-write-off">
        <div class="mfi-field"><label for="mfi-reverse-writeoff-reason">Reversal reason *</label><textarea id="mfi-reverse-writeoff-reason" class="mfi-control" name="reason" rows="3" minlength="5" maxlength="1000" required></textarea></div>
        <div class="mfi-action-row" style="justify-content:flex-start;margin-top:14px"><button class="mfi-btn" type="submit">Confirm reversal</button><button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="close-reverse-writeoff-form">Cancel</button></div>
        <div class="mfi-form-error" data-loan-form-error hidden></div>
      </form>
    </section>`;
  }

  function loanOverviewView(loan, nextSchedule) {
    const rate = `${esc(loan.interest_rate ?? 0)}% · ${esc(String(loan.interest_method || "").replaceAll("_", " "))}`;
    const nextBalance = nextSchedule
      ? Math.max(0, Number(nextSchedule.total_due || 0) - Number(nextSchedule.total_paid || 0)) +
        Math.max(0, Number(nextSchedule.late_fee_due || 0) - Number(nextSchedule.late_fee_paid || 0))
      : 0;
    return `<div class="mfi-loan-overview">
      <article class="mfi-subpanel"><h3>Loan terms</h3><div class="mfi-info-grid">
        <div class="mfi-info-item"><span>Customer</span><strong>${esc(customerName(loan))}</strong></div>
        <div class="mfi-info-item"><span>Phone</span><strong>${esc(loan.customer_phone || "—")}</strong></div>
        <div class="mfi-info-item"><span>Product</span><strong>${esc(loan.product_name || "—")}</strong></div>
        <div class="mfi-info-item"><span>Interest</span><strong>${rate}</strong></div>
        <div class="mfi-info-item"><span>Term</span><strong>${esc(loan.term_months || "—")} months · ${esc(loan.repayment_frequency || "monthly")}</strong></div>
        <div class="mfi-info-item"><span>Disbursed</span><strong>${date(loan.disbursed_at)}</strong></div>
        <div class="mfi-info-item"><span>Disbursed by</span><strong>${esc(loan.disbursed_by_name || "—")}</strong></div>
        <div class="mfi-info-item"><span>Disbursement reference</span><strong>${esc(loan.disbursement_reference || "—")}</strong></div>
      </div></article>
      <article class="mfi-subpanel mfi-next-installment"><h3>Next installment</h3>${nextSchedule
        ? `<strong>${amount(nextBalance)}</strong><span>Installment ${esc(nextSchedule.installment_number)} · due ${date(nextSchedule.due_date)}</span><small>${esc(statusLabel(nextSchedule.status))}</small>`
        : `<strong>No balance due</strong><span>There are no unpaid schedule rows.</span>`}</article>
    </div>`;
  }

  function loanScheduleView() {
    const rows = state.loanSchedule.length
      ? state.loanSchedule.map((schedule) => {
        const balance = Math.max(0, Number(schedule.principal_due) - Number(schedule.principal_paid)) +
          Math.max(0, Number(schedule.interest_due) - Number(schedule.interest_paid)) +
          Math.max(0, Number(schedule.fees_due) - Number(schedule.fees_paid)) +
          Math.max(0, Number(schedule.late_fee_due) - Number(schedule.late_fee_paid));
        return `<tr class="mfi-schedule-row mfi-schedule-row--${esc(schedule.status)}">
          <td>${esc(schedule.installment_number)}</td><td>${date(schedule.due_date)}</td>
          <td>${amount(schedule.principal_due)}</td><td>${amount(schedule.interest_due)}</td>
          <td>${amount(Number(schedule.fees_due || 0) + Number(schedule.late_fee_due || 0))}</td>
          <td>${amount(schedule.total_due)}</td><td>${amount(schedule.total_paid)}</td>
          <td>${amount(balance)}</td><td>${scheduleStatusBadge(schedule.status)}</td>
        </tr>`;
      }).join("")
      : `<tr><td colspan="9"><div class="mfi-state"><strong>No repayment schedule</strong></div></td></tr>`;
    return `<div class="mfi-table-wrap mfi-loan-schedule-print" id="mfi-loan-schedule"><table class="mfi-table"><thead><tr><th>#</th><th>Due date</th><th>Principal</th><th>Interest</th><th>Fees</th><th>Total due</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function loanPaymentsView() {
    const rows = state.loanPayments.length
      ? state.loanPayments.map((payment) => {
        const reversed = Boolean(payment.reversed_at);
        const reverseForm = state.reversePaymentId === payment.id
          ? `<form class="mfi-inline-form mfi-payment-reversal-form" data-loan-form="reverse-payment" data-id="${esc(payment.id)}"><div class="mfi-field"><label>Reversal reason *</label><textarea class="mfi-control" name="reason" rows="2" minlength="5" maxlength="500" required placeholder="Explain why this payment is being reversed"></textarea></div><div class="mfi-action-row"><button class="mfi-btn mfi-btn--danger" type="submit">Confirm reversal</button><button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="cancel-reverse-payment">Cancel</button></div><div class="mfi-form-error" data-loan-form-error hidden></div></form>`
          : "";
        return `<tr>
          <td><strong>${esc(payment.receipt_number)}</strong>${reversed ? `<small>Reversed ${date(payment.reversed_at)}</small>` : ""}</td>
          <td>${date(payment.paid_at)}</td><td>${amount(payment.amount)}</td><td>${esc(String(payment.payment_method || "").replaceAll("_", " "))}</td>
          <td>${amount(Number(payment.principal_applied || 0) + Number(payment.interest_applied || 0) + Number(payment.fees_applied || 0) + Number(payment.late_fees_applied || 0))}${Number(payment.overpayment) > 0 ? `<small>${amount(payment.overpayment)} overpayment</small>` : ""}</td>
          <td>${esc(payment.recorded_by_name || "—")}</td>
          <td><div class="mfi-row-actions"><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="print-receipt" data-id="${esc(payment.id)}">Receipt</button>${isManager() && !reversed ? `<button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="reverse-payment" data-id="${esc(payment.id)}">Reverse</button>` : ""}</div>${reversed && payment.reversal_reason ? `<small>${esc(payment.reversal_reason)}</small>` : ""}</td>
        </tr>${reverseForm ? `<tr><td colspan="7">${reverseForm}</td></tr>` : ""}`;
      }).join("")
      : `<tr><td colspan="7"><div class="mfi-state"><strong>No payments recorded</strong><p>Receipts appear here after a payment is saved.</p></div></td></tr>`;
    return `<div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Receipt #</th><th>Date</th><th>Amount</th><th>Method</th><th>Applied</th><th>By</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function loanHistoryView() {
    const entries = state.loanHistory.length
      ? state.loanHistory.map((entry) => `<article class="mfi-timeline-item"><div class="mfi-timeline-dot"></div><div><strong>${esc(statusLabel(entry.action))}</strong><p>${esc(historySummary(entry))}</p><small>${esc(entry.actor_name || "System")} · ${date(entry.created_at)}</small></div></article>`).join("")
      : `<div class="mfi-timeline-empty">No loan history is available.</div>`;
    return `<div class="mfi-timeline">${entries}</div>`;
  }

  function historySummary(entry) {
    const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
    if (metadata.applied_amount != null) {
      return `Credit note ${amount(metadata.applied_amount)}${metadata.reason ? ` · ${String(metadata.reason)}` : ""}`;
    }
    if (metadata.amount != null) {
      const receipt = metadata.receipt_number && metadata.receipt_number !== "assigned_at_payment"
        ? ` · ${String(metadata.receipt_number)}`
        : "";
      return `Payment ${amount(metadata.amount)}${receipt}${metadata.reason ? ` · ${String(metadata.reason)}` : ""}`;
    }
    if (metadata.principal != null) {
      return `Principal ${amount(metadata.principal)}${metadata.total_repayable != null ? ` · Total repayable ${amount(metadata.total_repayable)}` : ""}`;
    }
    if (metadata.reason) return String(metadata.reason);
    return "Loan record updated.";
  }

  function paymentFormView(loan, nextSchedule) {
    const initialAmount = nextSchedule
      ? Math.max(0, Number(nextSchedule.total_due || 0) - Number(nextSchedule.total_paid || 0)) +
        Math.max(0, Number(nextSchedule.late_fee_due || 0) - Number(nextSchedule.late_fee_paid || 0))
      : 0;
    return `<div class="mfi-loan-modal-backdrop"><section class="mfi-loan-modal" role="dialog" aria-modal="true" aria-labelledby="payment-modal-title">
      <div class="mfi-section-head"><div><h3 id="payment-modal-title">Record payment</h3><p>${esc(loan.loan_number)} · ${esc(customerName(loan))}</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-payment-form">Close</button></div>
      <form data-loan-form="payment">
        <div class="mfi-form-grid">
          ${inputField("Amount (UGX)", "amount", initialAmount, "number", true, 'min="1" step="1"')}
          <div class="mfi-field"><label for="payment-method">Method *</label><select id="payment-method" class="mfi-control" name="payment_method" required><option value="cash">Cash</option><option value="mobile_money">Mobile money</option><option value="bank">Bank</option></select></div>
          ${inputField("Payment date", "payment_date", todayInKampala(), "date", true, "")}
          ${inputField("Reference", "payment_reference", "", "text", false, 'maxlength="160"')}
          <div class="mfi-field mfi-span-2"><label for="payment-notes">Notes</label><textarea id="payment-notes" class="mfi-control" name="notes" maxlength="1000" rows="2"></textarea></div>
        </div>
        <div class="mfi-loan-allocation-preview" data-payment-preview>${paymentPreviewMarkup(initialAmount, todayInKampala())}</div>
        <div class="mfi-action-row"><button class="mfi-btn" type="submit">Save payment</button><button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="close-payment-form">Cancel</button></div>
        <div class="mfi-form-error" data-loan-form-error hidden></div>
      </form>
    </section></div>`;
  }

  function creditNoteFormView() {
    return `<div class="mfi-loan-modal-backdrop"><section class="mfi-loan-modal" role="dialog" aria-modal="true" aria-labelledby="credit-modal-title">
      <div class="mfi-section-head"><div><h3 id="credit-modal-title">Issue credit note</h3><p>Reduces eligible future principal only. Overdue, paid, and partially paid installments are excluded.</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-credit-form">Close</button></div>
      <form data-loan-form="credit-note"><div class="mfi-form-grid">
        ${inputField("Credit amount (UGX)", "amount", "", "number", true, 'min="1" step="1"')}
        <div class="mfi-field mfi-span-2"><label for="credit-note-reason">Reason *</label><textarea id="credit-note-reason" class="mfi-control" name="reason" rows="3" minlength="5" maxlength="1000" required></textarea></div>
      </div><div class="mfi-action-row"><button class="mfi-btn" type="submit">Apply credit note</button><button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="close-credit-form">Cancel</button></div><div class="mfi-form-error" data-loan-form-error hidden></div></form>
    </section></div>`;
  }

  function paymentPreviewMarkup(rawAmount, paymentDate) {
    const amountValue = Math.max(0, Math.floor(Number(rawAmount) || 0));
    const allocations = previewPaymentAllocation(amountValue, paymentDate);
    return `<strong>Estimated allocation</strong><div class="mfi-info-grid">
      <div class="mfi-info-item"><span>Late fees</span><strong>${amount(allocations.late_fees)}</strong></div>
      <div class="mfi-info-item"><span>Fees</span><strong>${amount(allocations.fees)}</strong></div>
      <div class="mfi-info-item"><span>Interest</span><strong>${amount(allocations.interest)}</strong></div>
      <div class="mfi-info-item"><span>Principal</span><strong>${amount(allocations.principal)}</strong></div>
      <div class="mfi-info-item"><span>Overpayment</span><strong>${amount(allocations.overpayment)}</strong></div>
    </div><small>Allocation is a preview; the server verifies current balances before saving.</small>`;
  }

  function previewPaymentAllocation(rawAmount, paymentDate = todayInKampala()) {
    let remaining = Math.max(0, Math.floor(Number(rawAmount) || 0));
    const totals = { late_fees: 0, fees: 0, interest: 0, principal: 0, overpayment: 0 };
    const schedules = [...state.loanSchedule].sort((left, right) =>
      String(left.due_date).slice(0, 10).localeCompare(String(right.due_date).slice(0, 10)) ||
      Number(left.installment_number) - Number(right.installment_number),
    ).map((schedule) => {
      const daysLate = Math.max(0, Math.floor(
        (Date.parse(`${paymentDate}T00:00:00Z`) - Date.parse(`${String(schedule.due_date).slice(0, 10)}T00:00:00Z`)) / 86_400_000,
      ));
      const grace = Number(state.loanDetail?.loan?.grace_period_days || 0);
      const calculatedLateFee = Math.round(
        Number(schedule.total_due || 0) * Number(state.loanDetail?.loan?.late_fee_percent || 0) / 100 *
        Math.max(0, daysLate - grace) / 30,
      );
      return { ...schedule, late_fee_due: Math.max(Number(schedule.late_fee_due || 0), calculatedLateFee, Number(schedule.late_fee_paid || 0)) };
    });
    const components = [
      ["late_fees", "late_fee_due", "late_fee_paid"],
      ["fees", "fees_due", "fees_paid"],
      ["interest", "interest_due", "interest_paid"],
      ["principal", "principal_due", "principal_paid"],
    ];
    for (const schedule of schedules) {
      for (const [name, dueKey, paidKey] of components) {
        if (remaining <= 0) break;
        const due = Math.max(0, Math.round(Number(schedule[dueKey] || 0) - Number(schedule[paidKey] || 0)));
        const applied = Math.min(remaining, due);
        totals[name] += applied;
        remaining -= applied;
      }
      if (remaining <= 0) break;
    }
    totals.overpayment = remaining;
    return totals;
  }

  function splitPreviewAmount(total, count) {
    if (count <= 0) return [];
    const base = Math.floor(total / count);
    const remainder = total - base * count;
    return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
  }

  function scheduleDate(start, index, frequency) {
    const value = /^\d{4}-\d{2}-\d{2}$/u.test(String(start || "")) ? start : todayInKampala();
    if (frequency === "monthly") {
      const [year, month, day] = value.split("-").map(Number);
      const monthIndex = month - 1 + index;
      const targetYear = year + Math.floor(monthIndex / 12);
      const targetMonth = ((monthIndex % 12) + 12) % 12;
      const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
      return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
    }
    const dateValue = new Date(`${value}T00:00:00.000Z`);
    dateValue.setUTCDate(dateValue.getUTCDate() + (frequency === "weekly" ? 7 : 14) * index);
    return dateValue.toISOString().slice(0, 10);
  }

  function disbursementPreview(application, product, firstInstallmentDate) {
    const principal = Math.round(Number(application.approved_amount || 0));
    const termMonths = Number(application.term_months || product.term_months || 0);
    const frequency = application.repayment_frequency || product.repayment_frequency || "monthly";
    const periodsPerMonth = frequency === "weekly" ? 4 : frequency === "biweekly" ? 2 : 1;
    const periods = Math.max(0, Math.round(termMonths * periodsPerMonth));
    const method = application.interest_method || product.interest_method || "reducing_balance";
    const annualRate = Number(application.interest_rate ?? product.interest_rate ?? 0);
    let principalParts = [];
    let interestParts = [];
    if (method === "flat") {
      const totalInterest = Math.round(principal * (annualRate / 100) * (termMonths / 12));
      principalParts = splitPreviewAmount(principal, periods);
      interestParts = splitPreviewAmount(totalInterest, periods);
    } else if (periods > 0) {
      const periodsPerYear = frequency === "weekly" ? 52 : frequency === "biweekly" ? 26 : 12;
      const periodRate = annualRate / 100 / periodsPerYear;
      const payment = periodRate === 0
        ? principal / periods
        : principal * periodRate / (1 - Math.pow(1 + periodRate, -periods));
      let balance = principal;
      for (let index = 0; index < periods; index += 1) {
        const interest = Math.round(balance * periodRate);
        const principalPart = index === periods - 1
          ? balance
          : Math.min(balance, Math.max(0, Math.round(payment - interest)));
        principalParts.push(principalPart);
        interestParts.push(interest);
        balance -= principalPart;
      }
      if (balance !== 0 && principalParts.length) principalParts[principalParts.length - 1] += balance;
    }
    const totalFees = Math.round(principal * (
      Number(application.processing_fee_percent ?? product.processing_fee_percent ?? 0) +
      Number(application.insurance_fee_percent ?? product.insurance_fee_percent ?? 0)
    ) / 100);
    const feeParts = splitPreviewAmount(totalFees, periods);
    const schedules = principalParts.map((principalDue, index) => ({
      installment_number: index + 1,
      due_date: scheduleDate(firstInstallmentDate, index, frequency),
      principal_due: principalDue,
      interest_due: interestParts[index] || 0,
      fees_due: feeParts[index] || 0,
      total_due: principalDue + (interestParts[index] || 0) + (feeParts[index] || 0),
    }));
    const totalInterest = interestParts.reduce((sum, value) => sum + value, 0);
    return {
      periods,
      totalInterest,
      totalFees,
      totalRepayable: principal + totalInterest + totalFees,
      schedules,
    };
  }

  function disbursementPreviewMarkup(application, product, firstInstallmentDate) {
    const preview = disbursementPreview(application, product, firstInstallmentDate);
    const rows = preview.schedules.slice(0, 5).map((schedule) => `<tr>
      <td>${esc(schedule.installment_number)}</td><td>${esc(date(schedule.due_date))}</td>
      <td>${amount(schedule.principal_due)}</td><td>${amount(schedule.interest_due)}</td>
      <td>${amount(schedule.fees_due)}</td><td>${amount(schedule.total_due)}</td>
    </tr>`).join("");
    const scheduleTable = rows
      ? `<div class="mfi-table-wrap mfi-disbursement-preview-table"><table class="mfi-table"><thead><tr><th>#</th><th>Due date</th><th>Principal</th><th>Interest</th><th>Fees</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p>Approved loan terms are needed to preview the schedule.</p>`;
    return `<section class="mfi-loan-preview"><strong>${preview.periods}-installment schedule · ${amount(preview.totalRepayable)} total repayable</strong>
      <p>${amount(application.approved_amount)} principal · ${amount(preview.totalInterest)} interest · ${amount(preview.totalFees)} fees</p>
      ${scheduleTable}${preview.periods > 5 ? `<small>Showing the first 5 of ${preview.periods} installments.</small>` : ""}
      <small>The server recalculates and validates every schedule row before disbursing.</small>
    </section>`;
  }

  function updateDisbursementPreview(form) {
    const previewNode = form.querySelector("[data-disbursement-preview]");
    if (!previewNode) return;
    previewNode.innerHTML = disbursementPreviewMarkup(
      state.detail?.application || {},
      state.detail?.product || {},
      form.elements.namedItem("first_installment_date")?.value,
    );
  }

  function todayInKampala() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Kampala",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type)?.value || "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function oneMonthAfter(value) {
    const [year, month, day] = value.split("-").map(Number);
    const target = new Date(Date.UTC(year, month, 1));
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.toISOString().slice(0, 10);
  }

  function disbursementFormView() {
    const application = state.detail?.application || {};
    const product = state.detail?.product || {};
    const today = todayInKampala();
    return `<div class="mfi-loan-modal-backdrop"><section class="mfi-loan-modal" role="dialog" aria-modal="true" aria-labelledby="disburse-modal-title">
      <div class="mfi-section-head"><div><h3 id="disburse-modal-title">Disburse loan</h3><p>${esc(application.reference || "")} · Approved amount ${amount(application.approved_amount)}</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-disbursement-form">Close</button></div>
      <form data-loan-form="disbursement">
        <div class="mfi-form-grid">
          ${inputField("Disbursement date", "disbursement_date", today, "date", true, "")}
          ${inputField("First installment date", "first_installment_date", oneMonthAfter(today), "date", true, "")}
          <div class="mfi-field"><label for="disbursement-method">Method *</label><select id="disbursement-method" class="mfi-control" name="disbursement_method" required><option value="cash">Cash</option><option value="mobile_money">Mobile money</option><option value="bank">Bank</option></select></div>
          ${inputField("Reference", "disbursement_reference", "", "text", false, 'maxlength="160"')}
        </div>
        <div data-disbursement-preview>${disbursementPreviewMarkup(application, product, oneMonthAfter(today))}</div>
        <div class="mfi-action-row"><button class="mfi-btn" type="submit">Confirm disbursement</button><button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="close-disbursement-form">Cancel</button></div>
        <div class="mfi-form-error" data-loan-form-error hidden></div>
      </form>
    </section></div>`;
  }

  function applicationFormView() {
    const record = state.applicationForm || {};
    const application = record.application || null;
    const editing = Boolean(application?.id);
    const customerId = application?.customer_id || "";
    const productId = application?.product_id || "";
    const selectedProduct = state.products.find((product) => product.id === productId) || {};
    const formProducts = [...state.products];
    if (
      editing &&
      state.detail?.product?.id === productId &&
      !formProducts.some((product) => product.id === productId)
    ) {
      formProducts.unshift({ ...state.detail.product, active: false });
    }
    const alreadyLinked = new Set(records(state.detail, "collateral").map((item) => item.id));
    const availableForApplication = state.availableCollateral.filter((item) => !alreadyLinked.has(item.id));
    const collateralOptions = availableForApplication.length
      ? availableForApplication.map((item) => `<option value="${esc(item.id)}">${esc(item.title)} · ${amount(item.estimated_value)} · score ${esc(item.score ?? "—")}</option>`).join("")
      : `<option value="">No approved collateral available for this customer</option>`;
    return `<section class="mfi-inline-form mfi-loan-form-panel">
      <div class="mfi-section-head"><div><h3>${editing ? "Edit draft application" : "New loan application"}</h3><p>Choose the customer and product, then save the draft or submit it for review.</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-application-form">Close</button></div>
      <form data-loan-form="application" data-id="${esc(application?.id || "")}">
        <div class="mfi-form-grid">
          <div class="mfi-field"><label for="loan-customer">Customer *</label><select id="loan-customer" class="mfi-control" name="customer_id" required><option value="">Select a customer</option>${state.customers.map((customer) => `<option value="${esc(customer.id)}" ${customer.id === customerId ? "selected" : ""}>${esc(`${customer.first_name || ""} ${customer.last_name || ""}`.trim())} · ${esc(customer.phone || "No phone")}</option>`).join("")}</select></div>
          <div class="mfi-field"><label for="loan-product">Loan product *</label><select id="loan-product" class="mfi-control" name="product_id" required><option value="">Select a product</option>${formProducts.filter((product) => product.active !== false || product.id === productId).map((product) => `<option value="${esc(product.id)}" ${product.id === productId ? "selected" : ""}>${esc(product.name)} · ${esc(product.code)}${product.active === false ? " (inactive; existing draft)" : ""}</option>`).join("")}</select></div>
          ${inputField("Requested amount (UGX)", "requested_amount", application?.requested_amount ?? selectedProduct.default_amount ?? selectedProduct.min_amount ?? "", "number", true, 'min="1" step="any"')}
          ${inputField("Term (months)", "term_months", application?.term_months ?? selectedProduct.term_months ?? "", "number", true, 'min="1" max="360" step="1"')}
          <div class="mfi-field mfi-span-2"><label for="loan-purpose">Purpose</label><textarea id="loan-purpose" class="mfi-control" name="purpose" maxlength="2000" rows="3">${esc(application?.purpose || "")}</textarea></div>
          <div class="mfi-field mfi-span-2"><label for="loan-collateral">Approved collateral (optional at draft save)</label><select id="loan-collateral" class="mfi-control" name="collateral_id"><option value="">Do not link collateral now</option>${collateralOptions}</select><small>Only this customer's approved collateral is available. Required products are checked before submission.</small></div>
        </div>
        ${application?.debt_to_income != null ? `<p class="mfi-muted-copy">Current estimated payment-to-income: ${esc(application.debt_to_income)}% (uses the recorded monthly income and excludes other loans).</p>` : ""}
        <div class="mfi-action-row" style="justify-content:flex-start;margin-top:16px">
          <button class="mfi-btn mfi-btn--quiet" type="submit" name="save_mode" value="draft">Save as draft</button>
          <button class="mfi-btn" type="submit" name="save_mode" value="submit">Save and submit</button>
        </div>
        <div class="mfi-form-error" data-loan-form-error hidden></div>
      </form>
    </section>`;
  }

  function detailView() {
    const payload = state.detail || {};
    const application = payload.application || {};
    const customer = payload.customer || {};
    const product = payload.product || {};
    const collateral = records(payload, "collateral");
    const history = records(payload, "history");
    const status = application.status || "draft";
    const photo = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(String(customer.photo_base64 || ""))
      ? customer.photo_base64
      : "";
    const customerCard = `<article class="mfi-subpanel"><h3>Customer</h3>${photo ? `<img class="mfi-loan-customer-photo" src="${esc(photo)}" alt="">` : ""}<div class="mfi-info-grid"><div class="mfi-info-item"><span>Name</span><strong>${esc(`${customer.first_name || ""} ${customer.last_name || ""}`.trim() || "—")}</strong></div><div class="mfi-info-item"><span>Phone</span><strong>${esc(customer.phone || "—")}</strong></div><div class="mfi-info-item"><span>Monthly income</span><strong>${customer.monthly_income == null ? "—" : amount(customer.monthly_income)}</strong></div></div></article>`;
    const productCard = `<article class="mfi-subpanel"><h3>Loan product</h3><div class="mfi-info-grid"><div class="mfi-info-item"><span>Product</span><strong>${esc(product.name || "Product removed")}</strong></div><div class="mfi-info-item"><span>Rate and method</span><strong>${esc(application.interest_rate ?? "—")}% ${esc(String(application.interest_method || "").replaceAll("_", " "))}</strong></div><div class="mfi-info-item"><span>Term</span><strong>${esc(application.term_months ?? "—")} months</strong></div><div class="mfi-info-item"><span>Purpose</span><strong>${esc(application.purpose || "—")}</strong></div></div></article>`;
    const collateralRows = collateral.length
      ? collateral.map((item) => `<tr><td><strong>${esc(item.title)}</strong><small>${esc(item.collateral_type_name || "")} · ${esc(item.condition || "")}</small></td><td>${amount(item.estimated_value, item.currency || "UGX")}</td><td>${esc(item.score ?? "—")}</td><td>${esc(statusLabel(item.status))}</td><td>${["draft", "submitted"].includes(status) ? `<button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="unlink-collateral" data-id="${esc(item.id)}">Unlink</button>` : "—"}</td></tr>`).join("")
      : `<tr><td colspan="5"><div class="mfi-state"><strong>No collateral linked</strong><p>Link approved collateral before submission when required by the product.</p></div></td></tr>`;
    const timeline = history.length
      ? history.map((entry) => `<article class="mfi-timeline-item"><div class="mfi-timeline-dot"></div><div><strong>${esc(statusLabel(entry.to_status))}</strong><p>${esc(entry.notes || "Status updated")}</p><small>${esc(entry.actor_name || "System")} · ${date(entry.created_at)}</small></div></article>`).join("")
      : `<div class="mfi-timeline-empty">No history is available.</div>`;
    const actions = detailActions(application);
    return `<section class="mfi-panel mfi-loan-detail">
      <div class="mfi-section-head"><div><button type="button" class="mfi-link-button" data-loan-action="back-to-applications">← Applications</button><h2>${esc(application.reference || "Loan application")}</h2><p>${amount(application.approved_amount ?? application.requested_amount)} requested · ${date(application.submitted_at || application.created_at)}</p></div><div>${statusBadge(status)}</div></div>
      <div class="mfi-action-row mfi-loan-detail-actions">${actions}</div>
      ${state.disbursementFormOpen ? disbursementFormView() : ""}
      ${state.applicationForm ? applicationFormView() : ""}
      ${state.reviewForm ? reviewFormView() : ""}
      ${state.collateralPickerOpen ? collateralPickerView() : ""}
      ${state.confirmCancelApplication ? cancelConfirmation() : ""}
      <div class="mfi-collateral-detail-grid">${customerCard}${productCard}</div>
      <section class="mfi-subpanel mfi-loan-collateral"><div class="mfi-section-head"><div><h3>Linked collateral</h3><p>${amount(application.total_collateral_value)} total value · ${esc(application.total_collateral_score ?? 0)} total score</p></div>${["draft", "submitted"].includes(status) ? `<button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="open-collateral-picker">＋ Link approved collateral</button>` : ""}</div>
        <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Collateral</th><th>Value</th><th>Score</th><th>Status</th><th>Actions</th></tr></thead><tbody>${collateralRows}</tbody></table></div>
      </section>
      ${application.debt_to_income != null ? `<section class="mfi-subpanel"><h3>Affordability snapshot</h3><p>Estimated new monthly payment is ${esc(application.debt_to_income)}% of recorded monthly income. Existing loan payments are not included.</p></section>` : ""}
      <section class="mfi-subpanel mfi-loan-timeline"><h3>Application history</h3><div class="mfi-timeline">${timeline}</div></section>
    </section>`;
  }

  function detailActions(application) {
    const status = application.status;
    const buttons = [];
    if (status === "draft") {
      if (isApplicationCreator() || isManager()) {
        buttons.push(`<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="edit-application">Edit draft</button>`);
        buttons.push(`<button type="button" class="mfi-btn" data-loan-action="submit-application">Submit for review</button>`);
      }
      if (managerOrOwner(application)) buttons.push(`<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="ask-cancel">Cancel application</button>`);
    } else if (status === "submitted") {
      if (isManager()) {
        buttons.push(`<button type="button" class="mfi-btn" data-loan-action="open-review" data-decision="approve">Approve</button>`);
        buttons.push(`<button type="button" class="mfi-btn mfi-btn--danger" data-loan-action="open-review" data-decision="reject">Reject</button>`);
        buttons.push(`<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="open-review" data-decision="request_changes">Request Changes</button>`);
      }
      if (managerOrOwner(application)) buttons.push(`<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="ask-cancel">Cancel application</button>`);
    } else if (status === "pending_director") {
      if (isDirector()) {
        buttons.push(`<button type="button" class="mfi-btn" data-loan-action="open-director-review" data-decision="approve">Approve</button>`);
        buttons.push(`<button type="button" class="mfi-btn mfi-btn--danger" data-loan-action="open-director-review" data-decision="reject">Reject</button>`);
      }
      if (managerOrOwner(application)) buttons.push(`<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="ask-cancel">Cancel application</button>`);
    } else if (status === "approved") {
      if (canDisburse()) buttons.push(`<button type="button" class="mfi-btn" data-loan-action="open-disbursement-form">Disburse loan</button>`);
    } else if (status === "rejected" && isManager()) {
      buttons.push(`<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="reopen-application">Reopen as draft</button>`);
    } else if (status === "changes_requested" && managerOrOwner(application)) {
      buttons.push(`<button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="reopen-application">Return to draft</button>`);
    }
    return buttons.join("");
  }

  function reviewFormView() {
    const review = state.reviewForm;
    if (!review) return "";
    const director = review.kind === "director";
    const decision = review.decision;
    const app = state.detail?.application || {};
    const title = decision === "approve"
      ? (director ? "Director approval" : "Manager approval")
      : decision === "reject" ? "Reject application" : "Request changes";
    return `<section class="mfi-inline-form mfi-loan-form-panel"><div class="mfi-section-head"><div><h3>${title}</h3><p>${decision === "approve" ? "Review the proposed amount before saving the decision." : "Add any useful context to the application history."}</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-review-form">Close</button></div>
      <form data-loan-form="review" data-kind="${director ? "director" : "manager"}" data-decision="${esc(decision)}">
        ${decision === "approve" ? `<div class="mfi-form-grid">${inputField("Approved amount (UGX)", "approved_amount", app.approved_amount ?? app.requested_amount ?? "", "number", true, 'min="1" step="any"')}</div>` : ""}
        <div class="mfi-field"><label for="loan-review-notes">Notes</label><textarea id="loan-review-notes" class="mfi-control" name="notes" rows="3" maxlength="2000"></textarea></div>
        <div class="mfi-action-row" style="justify-content:flex-start;margin-top:14px"><button class="mfi-btn ${decision === "reject" ? "mfi-btn--danger" : ""}" type="submit">Confirm ${esc(decision.replaceAll("_", " "))}</button><button class="mfi-btn mfi-btn--quiet" type="button" data-loan-action="close-review-form">Cancel</button></div><div class="mfi-form-error" data-loan-form-error hidden></div>
      </form>
    </section>`;
  }

  function collateralPickerView() {
    const existingIds = new Set(records(state.detail, "collateral").map((item) => item.id));
    const options = state.availableCollateral.filter((item) => !existingIds.has(item.id));
    return `<section class="mfi-inline-form mfi-loan-form-panel"><div class="mfi-section-head"><div><h3>Link approved collateral</h3><p>Only collateral for this customer with approved status can be attached.</p></div><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-loan-action="close-collateral-picker">Close</button></div>
      <form data-loan-form="collateral-link"><div class="mfi-form-grid"><div class="mfi-field mfi-span-2"><label for="loan-detail-collateral">Collateral *</label><select id="loan-detail-collateral" name="collateral_id" class="mfi-control" required><option value="">Select collateral</option>${options.map((item) => `<option value="${esc(item.id)}">${esc(item.title)} · ${amount(item.estimated_value)} · score ${esc(item.score ?? "—")}</option>`).join("")}</select></div></div>
      ${options.length ? `<div class="mfi-action-row" style="justify-content:flex-start;margin-top:12px"><button type="submit" class="mfi-btn">Link collateral</button></div>` : `<p class="mfi-muted-copy">There are no additional approved collateral items available.</p>`}
      <div class="mfi-form-error" data-loan-form-error hidden></div></form>
    </section>`;
  }

  function cancelConfirmation() {
    return `<div class="mfi-state mfi-loan-confirm"><strong>Cancel this application?</strong><p>It will be marked cancelled and kept in the application history.</p><div class="mfi-action-row"><button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="dismiss-cancel">Keep application</button><button type="button" class="mfi-btn mfi-btn--danger" data-loan-action="confirm-cancel">Confirm cancellation</button></div></div>`;
  }

  function inputField(label, name, value, type = "text", required = false, extra = "") {
    const id = `loan-${name.replaceAll("_", "-")}`;
    return `<div class="mfi-field"><label for="${esc(id)}">${esc(label)}${required ? " *" : ""}</label><input id="${esc(id)}" class="mfi-control" name="${esc(name)}" type="${esc(type)}" value="${esc(value ?? "")}" ${required ? "required" : ""} ${extra}></div>`;
  }

  function metric(label, value) {
    return `<div class="mfi-metric"><span>${esc(label)}</span><strong>${esc(value ?? 0)}</strong></div>`;
  }

  async function load() {
    state.loading = true;
    state.error = null;
    renderParent();
    try {
      if (state.subtab === "products") {
        const query = canManageProduct() ? "?include_inactive=true" : "";
        state.products = records(await request(`/api/mfi/loan-products${query}`), "products");
      } else if (state.subtab === "portfolio") {
        const params = new URLSearchParams();
        for (const key of ["status", "branch_id", "officer_id", "customer_id", "search"]) {
          const value = state.loanFilters[key];
          if (value) params.set(key, value);
        }
        const query = params.toString();
        const [loanPayload, statsPayload, officerPayload] = await Promise.all([
          request(`/api/mfi/loans${query ? `?${query}` : ""}`),
          request("/api/mfi/loans/stats"),
          request("/api/mfi/loans/portfolio-by-officer"),
        ]);
        state.loans = records(loanPayload, "loans");
        state.stats = statsPayload?.stats || {};
        state.officerPortfolio = records(officerPayload, "officers");
        if (!state.customers.length) {
          state.customers = records(await request("/api/mfi/customers"), "customers");
        }
        if (!state.branches.length) {
          state.branches = records(await request("/api/mfi/loans/branches"), "branches");
        }
      } else {
        const params = new URLSearchParams();
        if (state.subtab === "ready") params.set("status", "approved");
        else if (state.filters.status) params.set("status", state.filters.status);
        if (state.filters.branch_id && state.subtab !== "ready") params.set("branch_id", state.filters.branch_id);
        if (state.filters.search && state.subtab !== "ready") params.set("search", state.filters.search);
        const query = params.toString();
        const [applicationPayload, statsPayload] = await Promise.all([
          request(`/api/mfi/loan-applications${query ? `?${query}` : ""}`),
          request("/api/mfi/loans/stats"),
        ]);
        state.applications = records(applicationPayload, "applications");
        state.stats = statsPayload?.stats || {};
        if (!state.customers.length) {
          const customerPayload = await request("/api/mfi/customers");
          state.customers = records(customerPayload, "customers");
        }
        if (!state.branches.length) {
          const branchPayload = await request("/api/mfi/loans/branches");
          state.branches = records(branchPayload, "branches");
        }
        if (!state.products.length) {
          const productPayload = await request("/api/mfi/loan-products");
          state.products = records(productPayload, "products");
        }
      }
    } catch (error) {
      state.error = error;
    } finally {
      state.loading = false;
      renderParent();
    }
  }

  async function openApplication(id) {
    state.loanDetailId = null;
    state.loanDetail = null;
    state.detailId = id;
    state.detail = null;
    state.detailLoading = true;
    state.detailError = null;
    state.applicationForm = null;
    state.reviewForm = null;
    state.collateralPickerOpen = false;
    renderParent();
    try {
      state.detail = await request(`/api/mfi/loan-applications/${encodeURIComponent(id)}`);
    } catch (error) {
      state.detailError = error;
    } finally {
      state.detailLoading = false;
      renderParent();
    }
  }

  async function openLoan(id) {
    state.detailId = null;
    state.detail = null;
    state.loanDetailId = id;
    state.loanDetail = null;
    state.loanSchedule = [];
    state.loanPayments = [];
    state.loanHistory = [];
    state.loanDetailTab = "overview";
    state.loanDetailLoading = true;
    state.loanDetailError = null;
    state.paymentFormOpen = false;
    state.creditNoteFormOpen = false;
    state.disbursementFormOpen = false;
    state.restructureFormOpen = false;
    state.writeOffFormOpen = false;
    state.reverseWriteOffFormOpen = false;
    state.reversePaymentId = "";
    renderParent();
    try {
      const payload = await request(`/api/mfi/loans/${encodeURIComponent(id)}`);
      state.loanDetail = payload;
      state.loanSchedule = records(payload, "schedules");
      state.loanPayments = records(payload, "payments");
      state.loanHistory = records(payload, "history");
    } catch (error) {
      state.loanDetailError = error;
    } finally {
      state.loanDetailLoading = false;
      renderParent();
    }
  }

  async function submitDisbursement(form) {
    const application = state.detail?.application || {};
    const body = bodyFromForm(form);
    body.application_id = application.id;
    const result = await request("/api/mfi/loans/disburse", { method: "POST", body });
    const loan = result?.loan || {};
    state.disbursementFormOpen = false;
    state.subtab = "portfolio";
    state.detailId = null;
    state.detail = null;
    announce(`Loan ${result?.loan_number || loan.loan_number || ""} disbursed.`, "success");
    if (loan.id) await openLoan(loan.id);
    else await load();
  }

  async function recordPayment(form) {
    const loanId = state.loanDetailId;
    const result = await request(`/api/mfi/loans/${encodeURIComponent(loanId)}/payments`, {
      method: "POST",
      body: bodyFromForm(form),
    });
    const payment = result?.payment || {};
    state.paymentFormOpen = false;
    state.loanDetailTab = "payments";
    state.receiptPaymentId = payment.id || "";
    announce(`Payment recorded. Receipt ${payment.receipt_number || ""}.`, "success");
    await openLoan(loanId);
  }

  async function submitCreditNote(form) {
    const loanId = state.loanDetailId;
    const result = await request(`/api/mfi/loans/${encodeURIComponent(loanId)}/credit-note`, {
      method: "POST",
      body: bodyFromForm(form),
    });
    state.creditNoteFormOpen = false;
    const applied = Number(result?.applied_amount || 0);
    announce(`Credit note applied: ${amount(applied)} to future principal.`, "success");
    await openLoan(loanId);
  }

  async function reversePayment(form) {
    const loanId = state.loanDetailId;
    const paymentId = form.dataset.id;
    await request(`/api/mfi/loans/${encodeURIComponent(loanId)}/payments/${encodeURIComponent(paymentId)}/reverse`, {
      method: "POST",
      body: bodyFromForm(form),
    });
    state.reversePaymentId = "";
    announce("Payment reversed and loan balances recalculated.", "success");
    await openLoan(loanId);
  }

  async function submitRestructure(form) {
    const loanId = state.loanDetailId;
    const data = new FormData(form);
    const body = { reason: String(data.get("reason") || "").trim() };
    for (const [field, source] of [
      ["new_annual_rate", "new_annual_rate"],
      ["new_term_months", "new_term_months"],
      ["new_repayment_amount", "new_repayment_amount"],
    ]) {
      const value = String(data.get(source) || "").trim();
      if (value) body[field] = Number(value);
    }
    const result = await request(`/api/mfi/loans/${encodeURIComponent(loanId)}/restructure`, {
      method: "POST",
      body,
    });
    state.restructureFormOpen = false;
    const count = Number(result?.schedules_created || 0);
    announce(`Loan terms updated. ${count} new installments created.`, "success");
    await openLoan(loanId);
  }

  async function submitWriteOff(form) {
    const loanId = state.loanDetailId;
    const data = new FormData(form);
    await request(`/api/mfi/loans/${encodeURIComponent(loanId)}/write-off`, {
      method: "POST",
      body: {
        amount: Number(data.get("amount")),
        write_off_date: String(data.get("write_off_date") || ""),
        reason: String(data.get("reason") || "").trim(),
      },
    });
    state.writeOffFormOpen = false;
    announce("Loan write-off recorded.", "success");
    await openLoan(loanId);
  }

  async function submitReverseWriteOff(form) {
    const loanId = state.loanDetailId;
    await request(`/api/mfi/loans/${encodeURIComponent(loanId)}/write-off/reverse`, {
      method: "POST",
      body: { reason: String(new FormData(form).get("reason") || "").trim() },
    });
    state.reverseWriteOffFormOpen = false;
    announce("Write-off reversed and the prior loan balance restored.", "success");
    await openLoan(loanId);
  }

  function printSchedule() {
    const popup = window.open("", "_blank");
    if (!popup) {
      announce("Allow pop-ups to print the loan schedule.", "error");
      return;
    }
    const loan = state.loanDetail?.loan || {};
    const rows = state.loanSchedule.map((schedule) => {
      const balance = Math.max(0, Number(schedule.principal_due) - Number(schedule.principal_paid)) +
        Math.max(0, Number(schedule.interest_due) - Number(schedule.interest_paid)) +
        Math.max(0, Number(schedule.fees_due) - Number(schedule.fees_paid)) +
        Math.max(0, Number(schedule.late_fee_due) - Number(schedule.late_fee_paid));
      return `<tr><td>${esc(schedule.installment_number)}</td><td>${esc(date(schedule.due_date))}</td><td>${esc(amount(schedule.principal_due))}</td><td>${esc(amount(schedule.interest_due))}</td><td>${esc(amount(Number(schedule.fees_due || 0) + Number(schedule.late_fee_due || 0)))}</td><td>${esc(amount(schedule.total_due))}</td><td>${esc(amount(schedule.total_paid))}</td><td>${esc(amount(balance))}</td><td>${esc(statusLabel(schedule.status))}</td></tr>`;
    }).join("");
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Loan schedule ${esc(loan.loan_number)}</title><style>body{font:14px Arial,sans-serif;margin:32px;color:#173b43}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:9px;border:1px solid #dce7e3;text-align:left}th{background:#f5f7f2}small{color:#697e80}@media print{body{margin:12px}}</style></head><body><h1>Repayment schedule · ${esc(loan.loan_number)}</h1><p>${esc(customerName(loan))} · Principal ${esc(amount(loan.principal))} · Total repayable ${esc(amount(loan.total_repayable))}</p><table><thead><tr><th>#</th><th>Due date</th><th>Principal</th><th>Interest</th><th>Fees</th><th>Total due</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  async function printReceipt(paymentId) {
    const popup = window.open("", "_blank");
    if (!popup) {
      announce("Allow pop-ups to open the payment receipt.", "error");
      return;
    }
    try {
      const payload = await request(`/api/mfi/loans/${encodeURIComponent(state.loanDetailId)}/receipt/${encodeURIComponent(paymentId)}`);
      const receipt = payload?.receipt || {};
      const applied = [
        ["Principal", receipt.principal_applied],
        ["Interest", receipt.interest_applied],
        ["Fees", receipt.fees_applied],
        ["Late fees", receipt.late_fees_applied],
        ["Overpayment", receipt.overpayment],
      ].map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(amount(value))}</td></tr>`).join("");
      popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(receipt.receipt_number)}</title><style>body{font:15px Arial,sans-serif;max-width:620px;margin:48px auto;padding:28px;color:#173b43;border:1px solid #dce7e3}h1{font-size:23px;margin:0 0 8px}.muted{color:#697e80}strong{font-size:20px}table{width:100%;border-collapse:collapse;margin:22px 0}th,td{padding:10px;border-bottom:1px solid #dce7e3;text-align:left}td{text-align:right}.stamp{color:#a0443e;font-weight:bold;border:2px solid #a0443e;display:inline-block;padding:6px 10px;margin-top:12px}@media print{body{margin:0 auto;border:0}}</style></head><body><h1>Payment receipt</h1><p class="muted">${esc(receipt.loan_number)} · ${esc(receipt.first_name || "")} ${esc(receipt.last_name || "")}</p><p>Receipt number<br><strong>${esc(receipt.receipt_number)}</strong></p><p>Date: ${esc(date(receipt.paid_at))} · Method: ${esc(String(receipt.payment_method || "").replaceAll("_", " "))}</p><p>Amount received<br><strong>${esc(amount(receipt.amount))}</strong></p><table>${applied}</table>${receipt.payment_reference ? `<p>Reference: ${esc(receipt.payment_reference)}</p>` : ""}${receipt.reversed_at ? `<div class="stamp">REVERSED · ${esc(receipt.reversal_reason || "")}</div>` : ""}<p class="muted">Recorded by ${esc(receipt.recorded_by_name || "—")}</p></body></html>`);
      popup.document.close();
      popup.focus();
      popup.print();
    } catch (error) {
      popup.close();
      announce(errorText(error), "error");
    }
  }

  async function loadApprovedCollateral(customerId) {
    if (!customerId) {
      state.availableCollateral = [];
      state.availableCollateralCustomer = "";
      return;
    }
    state.availableCollateralCustomer = customerId;
    const query = new URLSearchParams({ customer_id: customerId, status: "approved" });
    const payload = await request(`/api/mfi/collateral?${query.toString()}`);
    state.availableCollateral = records(payload, "collateral");
  }

  function renderParent() {
    if (typeof onRender === "function") onRender();
  }

  function bind(root) {
    if (!root || root.dataset.loansBound) return;
    root.dataset.loansBound = "true";
    root.addEventListener("click", handleClick);
    root.addEventListener("submit", handleSubmit);
    root.addEventListener("change", handleChange);
    root.addEventListener("input", handleInput);
  }

  async function handleClick(event) {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.loanSubtab) {
      state.subtab = target.dataset.loanSubtab;
      state.detailId = null;
      state.detail = null;
      state.loanDetailId = null;
      state.loanDetail = null;
      state.applicationForm = null;
      state.disbursementFormOpen = false;
      await load();
      return;
    }
    const action = target.dataset.loanAction;
    if (!action) return;
    const id = target.dataset.id;
    if (action === "retry") await load();
    if (action === "retry-detail") await openApplication(state.detailId);
    if (action === "retry-loan-detail") await openLoan(state.loanDetailId);
    if (action === "open-loan") await openLoan(id);
    if (action === "back-to-portfolio") {
      state.loanDetailId = null;
      state.loanDetail = null;
      state.receiptPaymentId = "";
      state.subtab = "portfolio";
      await load();
    }
    if (action === "loan-detail-tab") {
      state.loanDetailTab = target.dataset.tab || "overview";
      state.reversePaymentId = "";
      renderParent();
    }
    if (action === "open-disbursement-form") {
      state.disbursementFormOpen = true;
      renderParent();
    }
    if (action === "close-disbursement-form") {
      state.disbursementFormOpen = false;
      renderParent();
    }
    if (action === "open-payment-form") {
      state.paymentFormOpen = true;
      renderParent();
    }
    if (action === "close-payment-form") {
      state.paymentFormOpen = false;
      renderParent();
    }
    if (action === "open-credit-form") {
      state.creditNoteFormOpen = true;
      renderParent();
    }
    if (action === "close-credit-form") {
      state.creditNoteFormOpen = false;
      renderParent();
    }
    if (action === "open-restructure-form") {
      state.restructureFormOpen = true;
      state.writeOffFormOpen = false;
      state.reverseWriteOffFormOpen = false;
      renderParent();
    }
    if (action === "close-restructure-form") {
      state.restructureFormOpen = false;
      renderParent();
    }
    if (action === "open-writeoff-form") {
      state.writeOffFormOpen = true;
      state.restructureFormOpen = false;
      state.reverseWriteOffFormOpen = false;
      renderParent();
    }
    if (action === "close-writeoff-form") {
      state.writeOffFormOpen = false;
      renderParent();
    }
    if (action === "open-reverse-writeoff-form") {
      state.reverseWriteOffFormOpen = true;
      state.restructureFormOpen = false;
      state.writeOffFormOpen = false;
      renderParent();
    }
    if (action === "close-reverse-writeoff-form") {
      state.reverseWriteOffFormOpen = false;
      renderParent();
    }
    if (action === "reverse-payment") {
      state.reversePaymentId = id || "";
      renderParent();
    }
    if (action === "cancel-reverse-payment") {
      state.reversePaymentId = "";
      renderParent();
    }
    if (action === "print-schedule") printSchedule();
    if (action === "print-receipt") await printReceipt(id);
    if (action === "dismiss-receipt") {
      state.receiptPaymentId = "";
      renderParent();
    }
    if (action === "new-product") {
      state.productForm = {};
      renderParent();
    }
    if (action === "edit-product") {
      state.productForm = state.products.find((product) => product.id === id) || null;
      renderParent();
    }
    if (action === "close-product-form") {
      state.productForm = null;
      renderParent();
    }
    if (action === "confirm-product-deactivate") {
      state.confirmProductDeactivate = id;
      renderParent();
    }
    if (action === "cancel-product-deactivate") {
      state.confirmProductDeactivate = "";
      renderParent();
    }
    if (action === "deactivate-product") await deactivateProduct(id);
    if (action === "activate-product") await activateProduct(id);
    if (action === "open-application") await openApplication(id);
    if (action === "new-application") {
      if (!state.products.length) await load();
      if (!state.products.some((product) => product.active !== false)) {
        announce("Add an active loan product before creating an application.", "error");
        return;
      }
      state.applicationForm = { application: null };
      state.availableCollateral = [];
      state.availableCollateralCustomer = "";
      renderParent();
    }
    if (action === "close-application-form") {
      state.applicationForm = null;
      renderParent();
    }
    if (action === "edit-application") {
      state.applicationForm = { application: state.detail?.application || null };
      try {
        await loadApprovedCollateral(String(state.detail?.customer?.id || ""));
      } catch (error) {
        announce(errorText(error), "error");
      }
      renderParent();
    }
    if (action === "back-to-applications") {
      state.detailId = null;
      state.detail = null;
      state.applicationForm = null;
      state.disbursementFormOpen = false;
      await load();
    }
    if (action === "submit-application") await submitApplicationDirectly();
    if (action === "open-review" || action === "open-director-review") {
      state.reviewForm = {
        kind: action === "open-director-review" ? "director" : "manager",
        decision: target.dataset.decision || "approve",
      };
      renderParent();
    }
    if (action === "close-review-form") {
      state.reviewForm = null;
      renderParent();
    }
    if (action === "open-collateral-picker") {
      try {
        await loadApprovedCollateral(String(state.detail?.customer?.id || ""));
        state.collateralPickerOpen = true;
      } catch (error) {
        announce(errorText(error), "error");
      }
      renderParent();
    }
    if (action === "close-collateral-picker") {
      state.collateralPickerOpen = false;
      renderParent();
    }
    if (action === "unlink-collateral") await unlinkCollateral(id);
    if (action === "ask-cancel") {
      state.confirmCancelApplication = true;
      renderParent();
    }
    if (action === "dismiss-cancel") {
      state.confirmCancelApplication = false;
      renderParent();
    }
    if (action === "confirm-cancel") await cancelApplication();
    if (action === "reopen-application") await reopenApplication();
  }

  async function handleSubmit(event) {
    const form = event.target.closest("form[data-loan-form]");
    if (!form) return;
    event.preventDefault();
    const type = form.dataset.loanForm;
    const submitter = event.submitter;
    const submitButtons = [...form.querySelectorAll('[type="submit"]')];
    const activeSubmitter = submitter || submitButtons[0];
    if (activeSubmitter) {
      activeSubmitter.disabled = true;
      activeSubmitter.dataset.originalText = activeSubmitter.textContent || "";
      activeSubmitter.textContent = "Saving…";
    }
    const errorNode = form.querySelector("[data-loan-form-error]");
    if (errorNode) {
      errorNode.hidden = true;
      errorNode.textContent = "";
    }
    try {
      if (type === "filters") {
        const data = new FormData(form);
        state.filters = {
          status: String(data.get("status") || ""),
          branch_id: String(data.get("branch_id") || ""),
          search: String(data.get("search") || "").trim(),
        };
        await load();
      } else if (type === "loan-filters") {
        const data = new FormData(form);
        state.loanFilters = {
          status: String(data.get("status") || ""),
          branch_id: String(data.get("branch_id") || ""),
          officer_id: String(data.get("officer_id") || ""),
          customer_id: String(data.get("customer_id") || ""),
          search: String(data.get("search") || "").trim(),
        };
        await load();
      } else if (type === "product") {
        await saveProduct(form);
      } else if (type === "application") {
        await saveApplication(form, String(activeSubmitter?.value || "draft") === "submit");
      } else if (type === "collateral-link") {
        await linkCollateral(form);
      } else if (type === "review") {
        await submitReview(form);
      } else if (type === "disbursement") {
        await submitDisbursement(form);
      } else if (type === "payment") {
        await recordPayment(form);
      } else if (type === "credit-note") {
        await submitCreditNote(form);
      } else if (type === "reverse-payment") {
        await reversePayment(form);
      } else if (type === "restructure") {
        await submitRestructure(form);
      } else if (type === "write-off") {
        await submitWriteOff(form);
      } else if (type === "reverse-write-off") {
        await submitReverseWriteOff(form);
      }
    } catch (error) {
      if (errorNode) {
        errorNode.textContent = errorText(error);
        errorNode.hidden = false;
      }
      announce(errorText(error), "error");
    } finally {
      if (activeSubmitter?.isConnected) {
        activeSubmitter.disabled = false;
        activeSubmitter.textContent = activeSubmitter.dataset.originalText || "Save";
      }
    }
  }

  async function handleChange(event) {
    const control = event.target;
    const form = control.closest("form[data-loan-form]");
    if (!form) return;
    if (form.dataset.loanForm === "disbursement" && control.name === "first_installment_date") {
      updateDisbursementPreview(form);
    }
    if (form.dataset.loanForm === "payment" && control.name === "payment_date") {
      const preview = form.querySelector("[data-payment-preview]");
      const amountInput = form.elements.namedItem("amount");
      if (preview && amountInput) preview.innerHTML = paymentPreviewMarkup(amountInput.value, control.value || todayInKampala());
    }
    if (form.dataset.loanForm === "application" && control.name === "customer_id") {
      try {
        await loadApprovedCollateral(control.value);
        const select = form.elements.namedItem("collateral_id");
        if (select) {
          const currentValue = select.value;
          select.innerHTML = `<option value="">Do not link collateral now</option>${state.availableCollateral.map((item) => `<option value="${esc(item.id)}">${esc(item.title)} · ${amount(item.estimated_value)} · score ${esc(item.score ?? "—")}</option>`).join("")}`;
          if ([...select.options].some((option) => option.value === currentValue)) select.value = currentValue;
        }
      } catch (error) {
        announce(errorText(error), "error");
      }
    }
    if (form.dataset.loanForm === "application" && control.name === "product_id") {
      const selected = state.products.find((product) => product.id === control.value);
      const amountField = form.elements.namedItem("requested_amount");
      const termField = form.elements.namedItem("term_months");
      if (selected && amountField) {
        amountField.value = selected.default_amount ?? selected.min_amount ?? "";
      }
      if (selected && termField) {
        termField.value = selected.term_months ?? "";
      }
    }
    if (form.dataset.loanForm === "product") updateProductPreview(form);
  }

  function handleInput(event) {
    const disbursementForm = event.target.closest('form[data-loan-form="disbursement"]');
    if (disbursementForm && event.target.name === "first_installment_date") {
      updateDisbursementPreview(disbursementForm);
    }
    const paymentForm = event.target.closest('form[data-loan-form="payment"]');
    if (paymentForm && event.target.name === "amount") {
      const preview = paymentForm.querySelector("[data-payment-preview]");
      const paymentDate = paymentForm.elements.namedItem("payment_date")?.value || todayInKampala();
      if (preview) preview.innerHTML = paymentPreviewMarkup(event.target.value, paymentDate);
    }
    const form = event.target.closest('form[data-loan-form="product"]');
    if (form) updateProductPreview(form);
  }

  function updateProductPreview(form) {
    const value = (name, fallback) => {
      const input = form.elements.namedItem(name);
      return input && input.value !== "" ? input.value : fallback;
    };
    const product = {
      default_amount: value("default_amount", ""),
      min_amount: value("min_amount", 50_000),
      interest_rate: value("interest_rate", 24),
      term_months: value("term_months", 12),
      interest_method: value("interest_method", "reducing_balance"),
    };
    const preview = form.querySelector("[data-loan-preview]");
    if (preview) preview.innerHTML = previewMarkup(product);
  }

  function bodyFromForm(form) {
    const data = new FormData(form);
    const body = Object.fromEntries(data.entries());
    for (const key of [
      "min_amount", "max_amount", "default_amount", "interest_rate", "term_months",
      "processing_fee_percent", "insurance_fee_percent", "late_fee_percent",
      "grace_period_days", "min_collateral_value", "requires_guarantors",
      "director_approval_threshold", "requested_amount", "approved_amount",
    ]) {
      if (key in body && body[key] !== "") body[key] = Number(body[key]);
      else if (key in body) body[key] = null;
    }
    if (form.dataset.loanForm === "product") {
      body.requires_collateral = data.has("requires_collateral");
      if (data.has("active")) body.active = data.get("active") === "true";
    }
    return body;
  }

  async function saveProduct(form) {
    const body = bodyFromForm(form);
    const id = form.dataset.id;
    const current = state.products.find((product) => product.id === id);
    const requestedActive = body.active;
    delete body.active;
    if (id) {
      await request(`/api/mfi/loan-products/${encodeURIComponent(id)}`, { method: "PATCH", body });
      if (requestedActive === true && current?.active === false) {
        await request(`/api/mfi/loan-products/${encodeURIComponent(id)}`, { method: "PATCH", body: { active: true } });
      }
      announce("Loan product updated.");
    } else {
      await request("/api/mfi/loan-products", { method: "POST", body });
      announce("Loan product created.");
    }
    state.productForm = null;
    await load();
  }

  async function deactivateProduct(id) {
    try {
      await request(`/api/mfi/loan-products/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.confirmProductDeactivate = "";
      announce("Loan product deactivated.");
      await load();
    } catch (error) {
      announce(errorText(error), "error");
    }
  }

  async function activateProduct(id) {
    try {
      await request(`/api/mfi/loan-products/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { active: true },
      });
      announce("Loan product reactivated.");
      await load();
    } catch (error) {
      announce(errorText(error), "error");
    }
  }

  async function saveApplication(form, submitAfterSave) {
    const body = bodyFromForm(form);
    const collateralId = String(body.collateral_id || "");
    delete body.collateral_id;
    const id = form.dataset.id;
    let payload;
    if (id) {
      payload = await request(`/api/mfi/loan-applications/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
      });
      announce("Draft application updated.");
    } else {
      payload = await request("/api/mfi/loan-applications", { method: "POST", body });
      announce("Application draft created.");
    }
    const application = payload?.application || {};
    state.applicationForm = null;
    try {
      if (collateralId) {
        await request(`/api/mfi/loan-applications/${encodeURIComponent(application.id)}/link-collateral`, {
          method: "POST",
          body: { collateral_id: collateralId },
        });
      }
      if (submitAfterSave) {
        await request(`/api/mfi/loan-applications/${encodeURIComponent(application.id)}/submit`, { method: "POST", body: {} });
        announce("Application submitted for manager review.");
      }
    } catch (error) {
      await openApplication(application.id);
      throw error;
    }
    await openApplication(application.id);
  }

  async function linkCollateral(form) {
    const data = new FormData(form);
    await request(`/api/mfi/loan-applications/${encodeURIComponent(state.detailId)}/link-collateral`, {
      method: "POST",
      body: { collateral_id: String(data.get("collateral_id") || "") },
    });
    state.collateralPickerOpen = false;
    announce("Collateral linked to the application.");
    await openApplication(state.detailId);
  }

  async function unlinkCollateral(collateralId) {
    try {
      await request(`/api/mfi/loan-applications/${encodeURIComponent(state.detailId)}/unlink-collateral/${encodeURIComponent(collateralId)}`, {
        method: "DELETE",
      });
      announce("Collateral unlinked.");
      await openApplication(state.detailId);
    } catch (error) {
      announce(errorText(error), "error");
    }
  }

  async function submitApplicationDirectly() {
    try {
      await request(`/api/mfi/loan-applications/${encodeURIComponent(state.detailId)}/submit`, {
        method: "POST",
        body: {},
      });
      announce("Application submitted for manager review.");
      await openApplication(state.detailId);
    } catch (error) {
      announce(errorText(error), "error");
    }
  }

  async function submitReview(form) {
    const body = bodyFromForm(form);
    body.decision = form.dataset.decision;
    const endpoint = form.dataset.kind === "director"
      ? "director-approve"
      : "review";
    await request(`/api/mfi/loan-applications/${encodeURIComponent(state.detailId)}/${endpoint}`, {
      method: "POST",
      body,
    });
    state.reviewForm = null;
    announce("Application decision recorded.");
    await openApplication(state.detailId);
  }

  async function cancelApplication() {
    try {
      await request(`/api/mfi/loan-applications/${encodeURIComponent(state.detailId)}/cancel`, {
        method: "POST",
        body: {},
      });
      state.confirmCancelApplication = false;
      announce("Application cancelled.");
      await openApplication(state.detailId);
    } catch (error) {
      announce(errorText(error), "error");
    }
  }

  async function reopenApplication() {
    try {
      await request(`/api/mfi/loan-applications/${encodeURIComponent(state.detailId)}/reopen`, {
        method: "POST",
        body: {},
      });
      announce("Application returned to draft.");
      await openApplication(state.detailId);
    } catch (error) {
      announce(errorText(error), "error");
    }
  }

  function reset() {
    Object.assign(state, {
      subtab: "applications",
      loading: false,
      error: null,
      products: [],
      applications: [],
      loans: [],
      officerPortfolio: [],
      customers: [],
      branches: [],
      stats: {},
      filters: { status: "", branch_id: "", search: "" },
      loanFilters: { status: "", branch_id: "", officer_id: "", customer_id: "", search: "" },
      detailId: null,
      detail: null,
      detailLoading: false,
      detailError: null,
      productForm: null,
      applicationForm: null,
      reviewForm: null,
      collateralPickerOpen: false,
      availableCollateral: [],
      availableCollateralCustomer: "",
      confirmProductDeactivate: "",
      confirmCancelApplication: false,
      loanDetailId: null,
      loanDetail: null,
      loanSchedule: [],
      loanPayments: [],
      loanHistory: [],
      loanDetailTab: "overview",
      loanDetailLoading: false,
      loanDetailError: null,
      disbursementFormOpen: false,
      paymentFormOpen: false,
      creditNoteFormOpen: false,
      reversePaymentId: "",
      receiptPaymentId: "",
    });
  }

  return {
    bind,
    render,
    load,
    reset,
  };
}
