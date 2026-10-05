import { estimateMonthlyPayment } from "./mfi-loans-domain.mjs";

const APPLICATION_STATUSES = [
  "draft",
  "submitted",
  "pending_director",
  "approved",
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
    customers: [],
    branches: [],
    stats: {},
    filters: { status: "", branch_id: "", search: "" },
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
      </nav>`;
    let content = "";
    if (state.detailId) {
      content = state.detailLoading
        ? loadingPanel("Loading application details…")
        : state.detailError
          ? `<section class="mfi-panel"><div class="mfi-state mfi-error-state"><div class="mfi-state-symbol">!</div><strong>Application detail unavailable</strong><p>${esc(errorText(state.detailError))}</p><button type="button" class="mfi-btn mfi-btn--quiet" data-loan-action="retry-detail">Try again</button></div></section>`
          : detailView();
    } else if (state.loading) {
      content = loadingPanel(state.subtab === "products" ? "Loading loan products…" : "Loading loan applications…");
    } else if (state.error) {
      content = errorPanel(state.error, "Try again");
    } else if (state.subtab === "products") {
      content = productView();
    } else if (state.subtab === "ready") {
      content = readyView();
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
            <div class="mfi-field"><label for="loan-repayment-frequency">Repayment frequency</label><select id="loan-repayment-frequency" class="mfi-control" name="repayment_frequency"><option value="monthly" ${!product.repayment_frequency || product.repayment_frequency === "monthly" ? "selected" : ""}>Monthly</option><option value="weekly" ${product.repayment_frequency === "weekly" ? "selected" : ""}>Weekly</option><option value="biweekly" ${product.repayment_frequency === "biweekly" ? "selected" : ""}>Biweekly</option><option value="daily" ${product.repayment_frequency === "daily" ? "selected" : ""}>Daily</option></select></div>
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
      <div class="mfi-loan-phase-note"><strong>Disbursement comes in Phase 3C-2.</strong><span>This view does not create disbursements or repayment schedules.</span></div>
      <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr><th>Reference</th><th>Customer</th><th>Product</th><th>Approved amount</th><th>Approved</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
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
      buttons.push(`<span class="mfi-loan-phase-note"><strong>Ready for disbursement</strong><span>Disbursement is part of Phase 3C-2.</span></span>`);
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
      state.applicationForm = null;
      await load();
      return;
    }
    const action = target.dataset.loanAction;
    if (!action) return;
    const id = target.dataset.id;
    if (action === "retry") await load();
    if (action === "retry-detail") await openApplication(state.detailId);
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
      } else if (type === "product") {
        await saveProduct(form);
      } else if (type === "application") {
        await saveApplication(form, String(activeSubmitter?.value || "draft") === "submit");
      } else if (type === "collateral-link") {
        await linkCollateral(form);
      } else if (type === "review") {
        await submitReview(form);
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
      customers: [],
      branches: [],
      stats: {},
      filters: { status: "", branch_id: "", search: "" },
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
    });
  }

  return {
    bind,
    render,
    load,
    reset,
  };
}
