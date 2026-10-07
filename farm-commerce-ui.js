const PAYMENT_CHANNELS = [
  ["mobile_money", "Mobile money"],
  ["paypal", "PayPal"],
  ["bank", "Bank transfer"],
  ["card", "Card"],
  ["cash_owner", "Cash received by owner"],
  ["other", "Other"],
];
const SALE_STATUSES = [
  ["pending_owner_review", "Pending owner review"],
  ["payment_confirmed", "Payment confirmed"],
  ["release_authorized", "Release authorized"],
  ["released", "Released"],
  ["closed", "Closed"],
  ["rejected", "Rejected"],
  ["cancelled", "Cancelled"],
];

export function initFarmCommerceUI({ request, escapeHtml, notify, rerender, getCoreState }) {
  const state = {
    user: null,
    userKey: "",
    version: 0,
    tab: "dashboard",
    produce: [],
    sales: [],
    expenses: [],
    cameras: [],
    dashboard: null,
    reports: {},
    reportKind: "sales",
    reportDates: { from: "", to: "" },
    statusFilter: "",
    search: "",
    modal: null,
    loading: {},
    errors: {},
    workerSalesLoaded: false,
    chart: null,
  };
  const core = () => typeof getCoreState === "function" ? getCoreState() || {} : {};
  const esc = (value) => typeof escapeHtml === "function"
    ? escapeHtml(value == null ? "" : String(value))
    : String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  const role = () => String(state.user?.role || "").toLowerCase();
  const isWorker = () => role() === "farm_worker";
  const isAdmin = () => role() === "farm_admin";
  const isManager = () => role() === "farm_manager";
  const canManage = () => isAdmin() || isManager();
  const money = (value) => `UGX ${Number(value || 0).toLocaleString("en-UG")}`;
  const today = () => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  };
  const notifyUser = (message, type = "success") => {
    if (typeof notify === "function") notify(message, type);
  };
  const labelStatus = (status) => SALE_STATUSES.find(([key]) => key === status)?.[1] || String(status || "Unknown").replaceAll("_", " ");
  const badge = (status) => `<span class="farm-commerce-status status-${esc(status)}">${esc(labelStatus(status))}</span>`;
  const base = "/api/farm";
  function rerenderUI() {
    rerender?.();
    afterRender();
  }
  function requestError(error) {
    return error?.message || "The request could not be completed.";
  }
  function reportError(key, error) {
    state.errors[key] = requestError(error);
  }
  async function loadResource(key, path, assign) {
    const version = state.version;
    state.loading[key] = true;
    state.errors[key] = "";
    rerenderUI();
    try {
      const payload = await request(path);
      if (version !== state.version) return;
      assign(payload || {});
    } catch (error) {
      if (version !== state.version) return;
      reportError(key, error);
    } finally {
      if (version !== state.version) return;
      state.loading[key] = false;
      rerenderUI();
    }
  }
  async function loadDashboard() {
    await loadResource("dashboard", `${base}/reports/dashboard`, (payload) => { state.dashboard = payload; });
  }
  async function loadProduce() {
    const query = new URLSearchParams();
    if (state.search) query.set("search", state.search);
    await loadResource("produce", `${base}/produce${query.size ? `?${query}` : ""}`, (payload) => {
      state.produce = Array.isArray(payload.produce) ? payload.produce : [];
    });
  }
  async function loadSales(workerMode = false) {
    const query = new URLSearchParams();
    if (state.statusFilter) query.set("status", state.statusFilter);
    await loadResource("sales", `${base}/sales${query.size ? `?${query}` : ""}`, (payload) => {
      state.sales = Array.isArray(payload.sales) ? payload.sales : [];
      if (workerMode) state.workerSalesLoaded = true;
    });
  }
  async function loadExpenses() {
    await loadResource("expenses", `${base}/expenses`, (payload) => {
      state.expenses = Array.isArray(payload.expenses) ? payload.expenses : [];
    });
  }
  async function loadCameras() {
    await loadResource("cameras", `${base}/cameras`, (payload) => {
      state.cameras = Array.isArray(payload.cameras) ? payload.cameras : [];
    });
  }
  async function loadReport(kind = state.reportKind) {
    state.reportKind = kind;
    const path = {
      production: "production",
      sales: "sales",
      expenses: "expenses",
      profit: "profit-loss",
    }[kind];
    if (!path) return;
    const query = new URLSearchParams();
    if (state.reportDates.from) query.set("from", state.reportDates.from);
    if (state.reportDates.to) query.set("to", state.reportDates.to);
    await loadResource(`report-${kind}`, `${base}/reports/${path}${query.size ? `?${query}` : ""}`, (payload) => {
      state.reports[kind] = payload;
    });
  }
  async function loadTab(tab) {
    state.tab = tab;
    if (tab === "dashboard") return loadDashboard();
    if (tab === "produce") return loadProduce();
    if (tab === "sales") return loadSales();
    if (tab === "expenses") return loadExpenses();
    if (tab === "cameras") return loadCameras();
    if (tab === "reports") return loadReport();
  }
  async function setUser(user) {
    const nextKey = user ? `${user.id || user.user_id || ""}:${user.role || ""}:${user.organization_id || ""}` : "";
    if (nextKey !== state.userKey) {
      state.version += 1;
      state.produce = [];
      state.sales = [];
      state.statusFilter = "";
      state.expenses = [];
      state.cameras = [];
      state.dashboard = null;
      state.reports = {};
      state.modal = null;
      state.loading = {};
      state.errors = {};
      state.workerSalesLoaded = false;
    }
    state.user = user || null;
    state.userKey = nextKey;
    if (isWorker()) {
      await Promise.all([loadSales(true), loadProduce()]);
    }
  }

  function resourceError(key) {
    const resource = state[key];
    if (state.loading[key] && (resource == null || (Array.isArray(resource) && !resource.length))) {
      return `<div class="farm-commerce-loading" role="status">Loading…</div>`;
    }
    if (state.errors[key]) return `<div class="farm-inline-error">${esc(state.errors[key])} <button type="button" data-farm-commerce-action="retry" data-resource="${esc(key)}">Try again</button></div>`;
    return "";
  }
  function tableEmpty(message, colspan = 5) {
    return `<tr><td colspan="${colspan}"><div class="farm-empty-note">${esc(message)}</div></td></tr>`;
  }
  function selected(value, expected) {
    return String(value ?? "") === String(expected ?? "") ? "selected" : "";
  }
  function locationOptions(value = "") {
    const locations = Array.isArray(core().locations) ? core().locations : [];
    return `<option value="">All locations</option>${locations.map((location) =>
      `<option value="${esc(location.id)}" ${selected(value, location.id)}>${esc(location.name)}</option>`).join("")}`;
  }
  function productOptions(value = "") {
    return `<option value="">Select produce</option>${state.produce.filter((product) => product.active !== false).map((product) =>
      `<option value="${esc(product.id)}" data-price="${esc(product.selling_price ?? "")}" ${selected(value, product.id)}>${esc(product.name)} · ${esc(product.unit || "unit")} (${money(product.current_stock)})</option>`).join("")}`;
  }
  function panelHeader(overline, title, description, button = "") {
    return `<div class="farm-panel-heading farm-panel-heading--actions"><div><p class="farm-overline">${esc(overline)}</p><h2>${esc(title)}</h2><p class="farm-panel-copy">${esc(description)}</p></div>${button}</div>`;
  }
  function actionButton(action, label, id = "", klass = "farm-btn farm-btn--quiet farm-btn--small") {
    return `<button type="button" class="${klass}" data-farm-commerce-action="${action}" ${id ? `data-id="${esc(id)}"` : ""}>${esc(label)}</button>`;
  }

  function renderDashboard() {
    const data = state.dashboard || {};
    const cards = [
      ["Sales this month", money(data.sales_this_month), "Released and closed sales"],
      ["Expenses this month", money(data.expenses_this_month), "Active expense records"],
      ["Profit this month", money(data.profit_this_month), `${Number(data.margin_pct || 0).toFixed(1)}% margin`],
      ["Pending review", Number(data.pending_review_count || 0), "Sales awaiting owner review"],
      ["Awaiting release", Number(data.release_authorized_count || 0), "Payment and release authorized"],
      ["Awaiting close", Number(data.released_awaiting_close_count || 0), "Goods released, not closed"],
      ["Eggs this week", Number(data.eggs_this_week || 0).toLocaleString(), `${Number(data.eggs_trend_pct || 0)}% vs previous week`],
      ["Produce inventory value", money(data.produce_value), "Current stock × cost price"],
    ];
    return `<section class="farm-commerce-dashboard">
      <div class="farm-section-line"><div><p class="farm-overline">PHASE 5C WORKFLOW</p><h2>Production and sales</h2></div>${actionButton("refresh-dashboard", "Refresh")}</div>
      ${resourceError("dashboard")}
      <div class="farm-commerce-metrics">${cards.map(([label, value, note]) => `<article class="farm-commerce-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`).join("")}</div>
      <div class="farm-commerce-dashboard-grid">
        <article class="farm-panel"><div class="farm-panel-heading"><div><p class="farm-overline">SALES CONTROL</p><h3>Items awaiting action</h3></div></div>
          <div class="farm-commerce-queue">${[
            ["pending_review_count", "Pending owner review", "sales"],
            ["payment_confirmed_count", "Payment confirmed", "sales"],
            ["release_authorized_count", "Awaiting release", "sales"],
            ["released_awaiting_close_count", "Awaiting close", "sales"],
          ].map(([key, label]) => `<button type="button" data-farm-commerce-action="open-queue" data-status="${key === "pending_review_count" ? "pending_owner_review" : key === "payment_confirmed_count" ? "payment_confirmed" : key === "release_authorized_count" ? "release_authorized" : "released"}"><span>${esc(label)}</span><strong>${Number(data[key] || 0)}</strong></button>`).join("")}</div>
        </article>
        <article class="farm-panel"><div class="farm-panel-heading"><div><p class="farm-overline">FIELD ATTENTION</p><h3>Farm reminders</h3></div></div>
          <div class="farm-commerce-reminders"><div><span>Low-stock produce</span><strong>${Number(data.low_stock?.length || 0)}</strong></div><div><span>Treatments due in 7 days</span><strong>${Number(data.treatments_due || 0)}</strong></div><div><span>Absent or unrecorded today</span><strong>${Number(data.absent_today || 0)}</strong></div></div>
        </article>
      </div>
      <div class="farm-commerce-low-stock"><h3>Low stock</h3>${data.low_stock?.length ? `<div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Produce</th><th>Category</th><th>On hand</th><th>Reorder at</th></tr></thead><tbody>${data.low_stock.map((product) => `<tr><td><strong>${esc(product.name)}</strong></td><td>${esc(product.category || "—")}</td><td>${esc(product.current_stock)} ${esc(product.unit || "")}</td><td>${esc(product.reorder_level)} ${esc(product.unit || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="farm-commerce-muted">No produce is at or below its reorder level.</p>`}</div>
    </section>`;
  }

  function renderProduce() {
    const canEdit = canManage();
    const actions = canEdit ? `<button type="button" class="farm-btn" data-farm-commerce-action="new-produce">＋ Add produce</button>` : "";
    return `<section class="farm-panel">
      ${panelHeader("PRODUCE INVENTORY", "Produce", "Track harvest, stock movements, unit costs, and selling prices.", actions)}
      <div class="farm-commerce-toolbar"><form data-farm-commerce-form="produce-filter"><label class="farm-field"><span>Search produce</span><input type="search" name="search" value="${esc(state.search)}" placeholder="Name or category"></label><button class="farm-btn farm-btn--quiet" type="submit">Search</button></form></div>
      ${resourceError("produce")}
      <div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Produce</th><th>Location</th><th>Stock</th><th>Reorder at</th><th>Unit cost</th><th>Selling price</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.produce.length ? state.produce.map((item) => `<tr><td><strong>${esc(item.name)}</strong><small>${esc(item.category || "Produce")} · ${esc(item.unit || "unit")}</small></td><td>${esc(item.location_name || "All locations")}</td><td>${esc(item.current_stock)} ${esc(item.unit || "")} ${item.low_stock ? '<span class="farm-commerce-low">Low</span>' : ""}</td><td>${esc(item.reorder_level || 0)} ${esc(item.unit || "")}</td><td>${item.cost_price == null ? "—" : money(item.cost_price)}</td><td>${item.selling_price == null ? "Not set" : money(item.selling_price)}</td><td>${item.active === false ? badge("inactive") : badge("active")}</td><td><div class="farm-row-actions">${canEdit ? `${actionButton("edit-produce", "Edit", item.id)}${actionButton("adjust-stock", "Adjust", item.id)}${isAdmin() ? actionButton("delete-produce", "Archive", item.id, "farm-btn farm-btn--danger-quiet farm-btn--small") : ""}` : ""}${actionButton("produce-movements", "Movements", item.id)}${isWorker() ? actionButton("record-harvest", "Record harvest", item.id, "farm-btn farm-btn--small") : ""}</div></td></tr>`).join("") : tableEmpty("No produce records match this search.", 8)}</tbody></table></div>
    </section>`;
  }

  function renderSales() {
    const canCreate = true;
    const actions = `<button type="button" class="farm-btn" data-farm-commerce-action="new-sale">＋ Record sale</button>`;
    return `<section class="farm-panel">
      ${panelHeader("THREE-STAGE RELEASE", isWorker() ? "My sales" : "Sales", "Review → confirm payment → authorize release → release goods → close.", actions)}
      <div class="farm-commerce-toolbar"><label class="farm-field"><span>Filter status</span><select data-farm-commerce-filter="sales-status"><option value="">All statuses</option>${SALE_STATUSES.map(([key, label]) => `<option value="${key}" ${selected(state.statusFilter, key)}>${esc(label)}</option>`).join("")}</select></label><div class="farm-commerce-inline-note">Workers can record and release only their own sales. They cannot handle money.</div></div>
      ${resourceError("sales")}
      <div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Sale</th><th>Date</th><th>Buyer</th><th>Location</th><th>Items</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Action</th></tr></thead><tbody>${state.sales.length ? state.sales.map((sale) => `<tr><td><strong>${esc(sale.sale_number)}</strong><small>${esc(sale.recorded_by_name || "Farm team")}</small></td><td>${esc(sale.sale_date)}</td><td>${esc(sale.buyer_name || "Walk-in buyer")}</td><td>${esc(sale.location_name || "—")}</td><td>${Number(sale.item_count || sale.items?.length || 0)}</td><td>${money(sale.total)}</td><td>${money(sale.amount_paid)}</td><td>${money(sale.balance_due)}</td><td>${badge(sale.status)}</td><td>${actionButton("view-sale", "Details", sale.id)}</td></tr>`).join("") : tableEmpty("No sales match this status filter.", 10)}</tbody></table></div>
    </section>`;
  }

  function renderExpenses() {
    const canCreate = canManage();
    return `<section class="farm-panel">
      ${panelHeader("FARM COSTS", "Expenses", "Record operating costs and review spending by date, category, and payment method.", canCreate ? `<button class="farm-btn" type="button" data-farm-commerce-action="new-expense">＋ Add expense</button>` : "")}
      ${resourceError("expenses")}
      <div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Location</th><th>Vendor</th><th>Method</th><th>Amount</th><th>Actions</th></tr></thead><tbody>${state.expenses.length ? state.expenses.map((expense) => `<tr><td>${esc(expense.expense_date)}</td><td><strong>${esc(expense.category)}</strong></td><td>${esc(expense.description || "—")}</td><td>${esc(expense.location_name || "All locations")}</td><td>${esc(expense.vendor || "—")}</td><td>${esc(expense.payment_method)}</td><td>${money(expense.amount)}</td><td><div class="farm-row-actions">${isAdmin() ? `${actionButton("edit-expense", "Edit", expense.id)}${actionButton("delete-expense", "Delete", expense.id, "farm-btn farm-btn--danger-quiet farm-btn--small")}` : ""}</div></td></tr>`).join("") : tableEmpty("No expenses have been recorded.", 8)}</tbody></table></div>
    </section>`;
  }

  function renderCameras() {
    return `<section class="farm-panel">
      ${panelHeader("CAMERA REGISTRY", "Cameras", "Keep camera metadata and heartbeat timestamps. Video streaming and inference are not enabled.", isAdmin() ? `<button class="farm-btn" type="button" data-farm-commerce-action="new-camera">＋ Register camera</button>` : "")}
      ${resourceError("cameras")}
      <div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Camera</th><th>Purpose</th><th>Location</th><th>Type</th><th>Heartbeat</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${state.cameras.length ? state.cameras.map((camera) => `<tr><td><strong>${esc(camera.name)}</strong></td><td>${esc(String(camera.purpose || "General").replaceAll("_", " "))}</td><td>${esc(camera.location_name || "All locations")}</td><td>${esc(camera.camera_type)}</td><td>${esc(camera.last_seen_at ? new Date(camera.last_seen_at).toLocaleString() : "Never")}</td><td>${badge(camera.status)}</td><td>${esc(camera.notes || "—")}</td><td><div class="farm-row-actions">${actionButton("camera-heartbeat", "Heartbeat", camera.id)}${isAdmin() ? `${actionButton("edit-camera", "Edit", camera.id)}${actionButton("delete-camera", "Archive", camera.id, "farm-btn farm-btn--danger-quiet farm-btn--small")}` : ""}</div></td></tr>`).join("") : tableEmpty("No camera metadata has been registered.", 8)}</tbody></table></div>
      <p class="farm-commerce-inline-note">Registry only: URLs are not opened, video is not streamed, and no camera inference runs.</p>
    </section>`;
  }

  function renderReports() {
    const report = state.reports[state.reportKind] || {};
    const kind = state.reportKind;
    const title = {
      production: "Production",
      sales: "Sales",
      expenses: "Expenses",
      profit: "Profit and loss",
    }[kind];
    const totals = kind === "production" ? [
      ["Eggs collected", report.totals?.eggs_collected],
      ["Good eggs", report.totals?.eggs_good],
      ["Broken eggs", report.totals?.eggs_broken],
      ["Harvest quantity", report.totals?.harvested_quantity],
    ] : kind === "sales" ? [
      ["Completed revenue", money(report.total_sales)],
      ["Paid amount", money(report.paid_amount)],
      ["Outstanding", money(report.outstanding)],
      ["Completed sales", report.completed_count],
    ] : kind === "expenses" ? [
      ["Expense total", money(report.total_expenses)],
      ["Records", report.expense_count],
    ] : [
      ["Revenue", money(report.revenue)],
      ["Expenses", money(report.expenses)],
      ["Profit / loss", money(report.gross_profit)],
      ["Margin", `${Number(report.margin_pct || 0).toFixed(2)}%`],
    ];
    const rows = kind === "production" ? (report.harvests || []) : kind === "sales"
      ? (report.daily_series || []) : kind === "expenses" ? (report.by_category || []) : [];
    return `<section class="farm-panel">
      ${panelHeader("FARM PERFORMANCE", "Reports", "Revenue includes released and closed sales only. Filter a period and download the detailed data.")}
      <div class="farm-report-tabs" role="tablist">${[
        ["sales", "Sales"], ["production", "Production"], ["expenses", "Expenses"], ["profit", "Profit & loss"],
      ].map(([key, label]) => `<button type="button" class="${kind === key ? "is-active" : ""}" role="tab" aria-selected="${kind === key}" data-farm-commerce-action="report-tab" data-kind="${key}">${esc(label)}</button>`).join("")}</div>
      <form class="farm-commerce-toolbar farm-report-filters" data-farm-commerce-form="report-filter">
        <label class="farm-field"><span>From</span><input type="date" name="from" value="${esc(state.reportDates.from)}"></label>
        <label class="farm-field"><span>To</span><input type="date" name="to" value="${esc(state.reportDates.to)}"></label>
        <button class="farm-btn farm-btn--quiet" type="submit">Apply dates</button>
        <button class="farm-btn farm-btn--quiet" type="button" data-farm-commerce-action="export-report" data-kind="${kind}">Download CSV</button>
      </form>
      ${resourceError(`report-${kind}`)}
      <div class="farm-commerce-metrics farm-commerce-report-metrics">${totals.map(([label, value]) => `<article class="farm-commerce-metric"><span>${esc(label)}</span><strong>${esc(value ?? 0)}</strong></article>`).join("")}</div>
      ${kind === "sales" ? `<div class="farm-commerce-split"><article class="farm-panel farm-chart-panel"><h3>Daily released revenue</h3><canvas data-farm-commerce-chart="sales" aria-label="Daily released sales revenue"></canvas></article><article class="farm-panel"><h3>Top products</h3><div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Product</th><th>Quantity</th><th>Revenue</th></tr></thead><tbody>${(report.top_products || []).length ? report.top_products.map((row) => `<tr><td>${esc(row.produce_name)}</td><td>${esc(row.quantity)}</td><td>${money(row.revenue)}</td></tr>`).join("") : tableEmpty("No released sales in this period.", 3)}</tbody></table></div></article></div>` : ""}
      ${kind === "expenses" ? `<div class="farm-commerce-split"><article class="farm-panel farm-chart-panel"><h3>Daily spending</h3><canvas data-farm-commerce-chart="expenses" aria-label="Daily farm expenses"></canvas></article><article class="farm-panel"><h3>By category</h3><div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Category</th><th>Records</th><th>Total</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td><strong>${esc(row.category)}</strong></td><td>${esc(row.count)}</td><td>${money(row.total)}</td></tr>`).join("") : tableEmpty("No expenses in this period.", 3)}</tbody></table></div></article></div>` : ""}
      ${kind === "production" ? `<div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Date</th><th>Produce</th><th>Location</th><th>Quantity</th><th>Records</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${esc(row.harvest_date)}</td><td><strong>${esc(row.produce_name)}</strong></td><td>${esc(row.location_name || "All locations")}</td><td>${esc(row.quantity)} ${esc(row.unit || "")}</td><td>${esc(row.records)}</td></tr>`).join("") : tableEmpty("No harvest records in this period.", 5)}</tbody></table></div><h3 class="farm-commerce-subhead">Egg collection by date and shift</h3><div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Date</th><th>Location</th><th>Shift</th><th>Collected</th><th>Good</th><th>Broken</th></tr></thead><tbody>${(report.eggs || []).length ? report.eggs.map((row) => `<tr><td>${esc(row.record_date)}</td><td>${esc(row.location_name)}</td><td>${esc(row.shift)}</td><td>${esc(row.eggs_collected)}</td><td>${esc(row.eggs_good)}</td><td>${esc(row.eggs_broken)}</td></tr>`).join("") : tableEmpty("No egg records in this period.", 6)}</tbody></table></div>` : ""}
      ${kind === "profit" ? `<p class="farm-commerce-inline-note">Formula: released and closed sale total − active expenses. Pending or unreleased sales are excluded from revenue.</p>` : ""}
    </section>`;
  }

  function render(tab) {
    if (tab === "produce") return renderProduce();
    if (tab === "sales") return renderSales();
    if (tab === "expenses") return renderExpenses();
    if (tab === "cameras") return renderCameras();
    if (tab === "reports") return renderReports();
    return "";
  }

  function saleLine(record = {}) {
    return `<div class="farm-commerce-sale-line" data-sale-line>
      <label class="farm-field"><span>Produce</span><select name="produce_id" required>${productOptions(record.produce_id)}</select></label>
      <label class="farm-field"><span>Quantity</span><input name="quantity" type="number" min="0.001" step="0.001" required value="${esc(record.quantity || 1)}"></label>
      ${canManage() ? `<label class="farm-field"><span>Unit price (UGX)</span><input name="unit_price" type="number" min="0" step="1" placeholder="Use catalog price" value="${esc(record.unit_price ?? "")}"></label>` : ""}
      <button class="farm-btn farm-btn--danger-quiet farm-btn--small" type="button" data-farm-commerce-action="remove-sale-line" aria-label="Remove sale item">Remove</button>
    </div>`;
  }
  function formField(label, name, value = "", type = "text", options = {}) {
    if (options.select) return `<label class="farm-field"><span>${esc(label)}</span><select name="${esc(name)}" ${options.required ? "required" : ""}>${options.select.map(([key, text]) => `<option value="${esc(key)}" ${selected(value, key)}>${esc(text)}</option>`).join("")}</select></label>`;
    return `<label class="farm-field ${options.wide ? "farm-span-2" : ""}"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(value ?? "")}" ${options.required ? "required" : ""} ${options.min != null ? `min="${options.min}"` : ""} ${options.step ? `step="${options.step}"` : ""} ${options.placeholder ? `placeholder="${esc(options.placeholder)}"` : ""}></label>`;
  }
  function modalFrame(title, body, wide = false) {
    return `<div class="farm-modal-backdrop" data-farm-commerce-action="dismiss-modal"><section class="farm-modal ${wide ? "farm-modal--wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="farm-modal-header"><div><p class="farm-overline">FARM OPERATIONS</p><h2>${esc(title)}</h2></div><button type="button" class="farm-modal-close" data-farm-commerce-action="close-modal" aria-label="Close">×</button></header>${body}</section></div>`;
  }
  function produceModal(record = {}) {
    return modalFrame(record.id ? "Edit produce" : "Add produce", `<form class="farm-form-grid" data-farm-commerce-form="produce" data-id="${esc(record.id || "")}">
      ${formField("Name", "name", record.name, "text", { required: true })}
      ${formField("Category", "category", record.category)}
      ${formField("Unit", "unit", record.unit || "kg", "text", { required: true })}
      <label class="farm-field"><span>Location</span><select name="location_id">${locationOptions(record.location_id || "")}</select></label>
      ${formField("Reorder level", "reorder_level", record.reorder_level ?? 0, "number", { min: 0, step: "0.001" })}
      ${formField("Cost price (UGX)", "cost_price", record.cost_price ?? "", "number", { min: 0, step: "1" })}
      ${formField("Selling price (UGX)", "selling_price", record.selling_price ?? "", "number", { min: 0, step: "1" })}
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Cancel</button><button type="submit" class="farm-btn">Save produce</button></div>
    </form>`);
  }
  function expenseModal(record = {}) {
    return modalFrame(record.id ? "Edit expense" : "Record expense", `<form class="farm-form-grid" data-farm-commerce-form="expense" data-id="${esc(record.id || "")}">
      ${formField("Date", "expense_date", record.expense_date || today(), "date", { required: true })}
      ${formField("Category", "category", record.category, "text", { required: true })}
      ${formField("Amount (UGX)", "amount", record.amount, "number", { required: true, min: 1, step: "1" })}
      ${formField("Payment method", "payment_method", record.payment_method || "cash", "text", { select: [["cash", "Cash"], ["momo", "Mobile money"], ["bank", "Bank"], ["credit", "Credit"]] })}
      ${formField("Vendor", "vendor", record.vendor)}
      ${formField("Reference", "reference", record.reference)}
      <label class="farm-field"><span>Location</span><select name="location_id">${locationOptions(record.location_id || "")}</select></label>
      <label class="farm-field farm-span-2"><span>Description</span><textarea name="description" rows="2">${esc(record.description || "")}</textarea></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Cancel</button><button type="submit" class="farm-btn">Save expense</button></div>
    </form>`);
  }
  function cameraModal(record = {}) {
    return modalFrame(record.id ? "Edit camera" : "Register camera", `<form class="farm-form-grid" data-farm-commerce-form="camera" data-id="${esc(record.id || "")}">
      ${formField("Camera name", "name", record.name, "text", { required: true })}
      ${formField("Camera type", "camera_type", record.camera_type || "ip", "text", { required: true })}
      <label class="farm-field"><span>Purpose</span><select name="purpose"><option value="">General</option>${[["egg_counting", "Egg counting"], ["animal_monitoring", "Animal monitoring"], ["security", "Security"], ["feed_check", "Feed check"]].map(([key, label]) => `<option value="${key}" ${selected(record.purpose, key)}>${label}</option>`).join("")}</select></label>
      <label class="farm-field"><span>Location</span><select name="location_id">${locationOptions(record.location_id || "")}</select></label>
      <label class="farm-field farm-span-2"><span>Stream URL (registry only; not opened)</span><input name="stream_url" type="url" value="${esc(record.stream_url || "")}" placeholder="https:// or rtsp://"></label>
      <label class="farm-field farm-span-2"><span>Notes</span><textarea name="notes" rows="2">${esc(record.notes || "")}</textarea></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Cancel</button><button type="submit" class="farm-btn">Save camera</button></div>
    </form>`);
  }
  function saleModal() {
    const buyer = `<form class="farm-form-grid farm-commerce-sale-form" data-farm-commerce-form="sale">
      ${formField("Sale date", "sale_date", today(), "date", { required: true })}
      ${formField("Buyer name", "buyer_name")}
      ${formField("Buyer phone", "buyer_phone", "", "tel")}
      ${canManage() ? `<label class="farm-field"><span>Location</span><select name="location_id">${locationOptions()}</select></label>` : ""}
      ${canManage() ? `<label class="farm-field"><span>Payment received via</span><select name="payment_channel" required>${PAYMENT_CHANNELS.map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label>` : ""}
      ${canManage() ? formField("Discount (UGX)", "discount", 0, "number", { min: 0, step: "1" }) : ""}
      <div class="farm-commerce-sale-lines farm-span-2" data-sale-lines>${saleLine()}</div>
      <button class="farm-btn farm-btn--quiet farm-btn--small" type="button" data-farm-commerce-action="add-sale-line">＋ Add another item</button>
      <label class="farm-field farm-span-2"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
      <div class="farm-commerce-inline-note farm-span-2">${isWorker() ? "This sale will be sent for owner review. Do not accept or record payment." : "This manager/admin sale starts with payment confirmed; the goods still need release authorization."}</div>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Cancel</button><button type="submit" class="farm-btn">Save sale</button></div>
    </form>`;
    return modalFrame("Record farm sale", buyer, true);
  }
  function saleDetailModal() {
    const sale = state.modal?.sale || {};
    const items = state.modal?.items || [];
    const available = [];
    if (sale.status === "pending_owner_review" && canManage()) available.push(actionButton("open-payment", "Confirm payment", sale.id, "farm-btn"));
    if (sale.status === "payment_confirmed" && canManage()) available.push(actionButton("open-authorization", "Authorize release", sale.id, "farm-btn"));
    if (sale.status === "release_authorized" && (canManage() || (isWorker() && String(sale.recorded_by) === String(state.user?.id || state.user?.user_id)))) {
      available.push(actionButton("mark-released", "Mark goods released", sale.id, "farm-btn"));
    }
    if (sale.status === "released" && canManage()) available.push(actionButton("close-sale", "Close sale", sale.id, "farm-btn"));
    if (canManage() && sale.status !== "closed" && sale.status !== "rejected" && sale.status !== "cancelled") {
      available.push(actionButton("open-rejection", "Reject sale", sale.id, "farm-btn farm-btn--danger-quiet"));
    }
    if (canManage() && ["pending_owner_review", "payment_confirmed", "release_authorized"].includes(sale.status)) {
      available.push(actionButton("cancel-sale", "Cancel sale", sale.id, "farm-btn farm-btn--danger-quiet"));
    }
    return modalFrame(`Sale ${sale.sale_number || ""}`, `<div class="farm-commerce-sale-detail">
      ${state.loading.saleDetail ? '<p>Loading sale details…</p>' : ""}
      <div class="farm-commerce-detail-grid"><div><small>Status</small>${badge(sale.status)}</div><div><small>Buyer</small><strong>${esc(sale.buyer_name || "Walk-in buyer")}</strong></div><div><small>Date</small><strong>${esc(sale.sale_date)}</strong></div><div><small>Location</small><strong>${esc(sale.location_name || "—")}</strong></div><div><small>Total</small><strong>${money(sale.total)}</strong></div><div><small>Paid</small><strong>${money(sale.amount_paid)}</strong></div><div><small>Balance</small><strong>${money(sale.balance_due)}</strong></div><div><small>Payment channel</small><strong>${esc(sale.payment_channel || "Not confirmed")}</strong></div></div>
      <h3>Items</h3><div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Produce</th><th>Quantity</th><th>Unit price</th><th>Total</th></tr></thead><tbody>${items.map((item) => `<tr><td>${esc(item.produce_name)}</td><td>${esc(item.quantity)}</td><td>${money(item.unit_price)}</td><td>${money(item.total)}</td></tr>`).join("")}</tbody></table></div>
      ${sale.external_payment_reference ? `<p><strong>Payment reference:</strong> ${esc(sale.external_payment_reference)}</p>` : ""}
      ${sale.payment_confirmation_notes ? `<p><strong>Payment notes:</strong> ${esc(sale.payment_confirmation_notes)}</p>` : ""}
      ${sale.release_authorization_notes ? `<p><strong>Release authorization:</strong> ${esc(sale.release_authorization_notes)}</p>` : ""}
      ${sale.verbal_authorization_audio ? `<audio controls preload="none" src="${esc(sale.verbal_authorization_audio)}">Audio playback is not supported.</audio>` : ""}
      ${sale.rejection_reason ? `<p class="farm-commerce-rejection"><strong>Rejection reason:</strong> ${esc(sale.rejection_reason)}</p>` : ""}
      ${sale.notes ? `<p><strong>Notes:</strong> ${esc(sale.notes)}</p>` : ""}
      <div class="farm-modal-footer farm-commerce-actions">${available.join("")}<button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Done</button></div>
    </div>`, true);
  }
  function workflowModal() {
    const kind = state.modal?.kind;
    const sale = state.modal?.sale || {};
    if (kind === "confirm-payment") return modalFrame("Confirm buyer payment", `<form class="farm-form-grid" data-farm-commerce-form="payment">
      <div class="farm-commerce-inline-note farm-span-2">This confirms the full sale amount. The sale remains on hold until release is authorized.</div>
      ${formField("Payment channel", "payment_channel", "mobile_money", "text", { select: PAYMENT_CHANNELS, required: true })}
      ${formField("External reference (optional)", "external_payment_reference", "")}
      <label class="farm-field farm-span-2"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Cancel</button><button class="farm-btn" type="submit">Confirm payment</button></div></form>`);
    if (kind === "authorize-release") return modalFrame("Authorize goods release", `<form class="farm-form-grid" data-farm-commerce-form="authorization">
      <div class="farm-commerce-inline-note farm-span-2">Optional verbal authorization recording, maximum 500 KB. This authorizes release; it does not deduct stock.</div>
      <label class="farm-field farm-span-2"><span>Audio authorization (optional)</span><input name="verbal_authorization_audio" type="file" accept="audio/*"></label>
      <label class="farm-field farm-span-2"><span>Release notes</span><textarea name="notes" rows="2"></textarea></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Cancel</button><button class="farm-btn" type="submit">Authorize release</button></div></form>`);
    if (kind === "reject-sale") return modalFrame(`Reject ${sale.sale_number || "sale"}`, `<form class="farm-form-grid" data-farm-commerce-form="rejection">
      <label class="farm-field farm-span-2"><span>Reason (required)</span><textarea name="reason" rows="3" maxlength="1000" required></textarea></label>
      <div class="farm-commerce-inline-note farm-span-2">Rejecting does not deduct or restore stock.</div>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Cancel</button><button class="farm-btn farm-btn--danger-quiet" type="submit">Reject sale</button></div></form>`);
    if (kind === "stock" || kind === "harvest") return modalFrame(kind === "harvest" ? "Record harvest" : "Adjust stock", `<form class="farm-form-grid" data-farm-commerce-form="${kind}" data-id="${esc(state.modal.produce?.id || "")}">
      <p class="farm-commerce-inline-note farm-span-2">${esc(state.modal.produce?.name || "")} · current stock ${esc(state.modal.produce?.current_stock ?? 0)} ${esc(state.modal.produce?.unit || "")}</p>
      ${kind === "harvest" && !state.modal.produce?.id ? `<label class="farm-field farm-span-2"><span>Produce to harvest</span><select name="produce_id" required>${productOptions()}</select></label>` : ""}
      ${kind === "stock" ? `<label class="farm-field"><span>Movement</span><select name="movement_type">${[["purchase", "Purchase"], ["adjustment", "Adjustment"], ["loss", "Loss"], ["return", "Return"]].map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label>` : ""}
      ${formField(kind === "harvest" ? "Quantity harvested" : "Quantity change (+ / −)", "quantity_change", "", "number", { required: true, step: "0.001" })}
      ${kind === "stock" ? formField("Unit cost (UGX)", "unit_cost", "", "number", { min: 0, step: "1" }) : ""}
      <label class="farm-field farm-span-2"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
      <div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Cancel</button><button type="submit" class="farm-btn">${kind === "harvest" ? "Save harvest" : "Save adjustment"}</button></div></form>`);
    if (kind === "produce-movements") {
      const rows = state.modal.movements || [];
      return modalFrame(`Movements · ${state.modal.produce?.name || "Produce"}`, `<div class="farm-table-wrap"><table class="farm-table"><thead><tr><th>Date</th><th>Type</th><th>Quantity</th><th>Balance</th><th>Notes</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${esc(row.created_at)}</td><td>${esc(row.movement_type)}</td><td>${esc(row.quantity)}</td><td>${esc(row.balance_after)}</td><td>${esc(row.notes || row.reference || "—")}</td></tr>`).join("") : tableEmpty("No stock movements found.", 5)}</tbody></table></div><div class="farm-modal-footer"><button type="button" class="farm-btn farm-btn--quiet" data-farm-commerce-action="close-modal">Close</button></div>`, true);
    }
    return "";
  }
  function modalMarkup() {
    const modal = state.modal;
    if (!modal) return "";
    if (modal.kind === "produce") return produceModal(modal.record || {});
    if (modal.kind === "expense") return expenseModal(modal.record || {});
    if (modal.kind === "camera") return cameraModal(modal.record || {});
    if (modal.kind === "sale") return saleModal();
    if (modal.kind === "sale-detail") return saleDetailModal();
    return workflowModal();
  }
  function renderWorkerActions() {
    if (!isWorker()) return "";
    return `<section class="farm-worker-commercial-actions"><div><p class="farm-overline">FIELD RECORDS</p><h3>Record today’s work</h3><p>Harvest updates stock; sales wait for review and payment confirmation.</p></div><div>${actionButton("worker-harvest", "Record harvest", "", "farm-btn farm-btn--quiet")}${actionButton("worker-sale", "Record sale", "", "farm-btn")}</div></section>`;
  }
  function hasWorkerSales() {
    return isWorker();
  }
  function renderWorkerSales() {
    if (state.loading.sales) return `<div class="farm-commerce-loading">Loading your sales…</div>`;
    if (state.errors.sales) return `<div class="farm-inline-error">${esc(state.errors.sales)} <button type="button" data-farm-commerce-action="retry" data-resource="sales">Try again</button></div>`;
    const stageText = {
      pending_owner_review: "⏳ Waiting for owner",
      payment_confirmed: "💰 Payment received",
      released: "📦 Released — waiting for close",
      closed: "✅ Completed",
      rejected: "Sale rejected",
      cancelled: "Sale cancelled",
    };
    return `<section class="farm-panel"><div class="farm-panel-heading"><div><p class="farm-overline">YOUR SALES</p><h2>My sales</h2><p class="farm-panel-copy">Only records entered by your account are shown.</p></div>${actionButton("worker-sale", "Record sale", "", "farm-btn")}</div><div class="farm-worker-sale-list">${state.sales.length ? state.sales.map((sale) => sale.status === "release_authorized" ? `<article class="farm-worker-sale-authorized"><div><span class="farm-overline">RELEASE APPROVED</span><h3>✅ Owner authorized — Release goods to ${esc(sale.buyer_name || "buyer")}</h3><p><strong>${esc(sale.release_authorized_by_name || "Farm owner")}</strong> · ${esc(sale.release_authorized_at ? new Date(sale.release_authorized_at).toLocaleString() : "Time not recorded")}</p><small>${esc(sale.sale_number)} · ${money(sale.total)} · Open details to play the recorded verbal note.</small></div><div class="farm-worker-authorized-actions">${actionButton("view-sale", "Play note / details", sale.id, "farm-btn farm-btn--quiet")}${actionButton("mark-released", "📦 Mark as Released", sale.id, "farm-btn")}</div></article>` : `<article><div><strong>${esc(sale.sale_number)}</strong><small>${esc(sale.sale_date)} · ${esc(sale.buyer_name || "Walk-in buyer")}</small><small>${esc(stageText[sale.status] || `Sale ${sale.status}`)}</small></div><div>${badge(sale.status)}<strong>${money(sale.total)}</strong></div>${actionButton("view-sale", "Details", sale.id)}</article>`).join("") : '<p class="farm-commerce-muted">You have not recorded a sale yet.</p>'}</div></section>`;
  }

  function readForm(form) {
    return Object.fromEntries(new FormData(form).entries());
  }
  function numberOrNull(value) {
    return value === "" || value == null ? null : Number(value);
  }
  async function audioData(file) {
    if (!file) return null;
    if (!file.type.startsWith("audio/")) throw new Error("Choose an audio file.");
    if (file.size > 500 * 1024) throw new Error("Audio must be 500 KB or smaller.");
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("The audio file could not be read."));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
  }
  async function submit(form) {
    const kind = form.dataset.farmCommerceForm;
    const id = form.dataset.id;
    try {
      if (kind === "produce-filter") {
        state.search = String(readForm(form).search || "").trim();
        await loadProduce();
        return;
      }
      if (kind === "report-filter") {
        const data = readForm(form);
        state.reportDates = { from: String(data.from || ""), to: String(data.to || "") };
        await loadReport();
        return;
      }
      if (kind === "produce") {
        const data = readForm(form);
        data.location_id = data.location_id || null;
        for (const field of ["cost_price", "selling_price"]) data[field] = numberOrNull(data[field]);
        data.reorder_level = Number(data.reorder_level || 0);
        await request(`${base}/produce${id ? `/${encodeURIComponent(id)}` : ""}`, { method: id ? "PATCH" : "POST", body: data });
        state.modal = null;
        notifyUser(id ? "Produce updated." : "Produce added.");
        await loadProduce();
      } else if (kind === "expense") {
        const data = readForm(form);
        data.amount = Number(data.amount);
        data.location_id = data.location_id || null;
        await request(`${base}/expenses${id ? `/${encodeURIComponent(id)}` : ""}`, { method: id ? "PATCH" : "POST", body: data });
        state.modal = null;
        notifyUser(id ? "Expense updated." : "Expense recorded.");
        await loadExpenses();
      } else if (kind === "camera") {
        const data = readForm(form);
        data.location_id = data.location_id || null;
        data.stream_url = data.stream_url || null;
        await request(`${base}/cameras${id ? `/${encodeURIComponent(id)}` : ""}`, { method: id ? "PATCH" : "POST", body: data });
        state.modal = null;
        notifyUser(id ? "Camera updated." : "Camera registered.");
        await loadCameras();
      } else if (kind === "sale") {
        const data = readForm(form);
        const lines = [...form.querySelectorAll("[data-sale-line]")];
        const items = lines.map((line) => {
          const productId = line.querySelector('[name="produce_id"]').value;
          const quantity = Number(line.querySelector('[name="quantity"]').value);
          const price = line.querySelector('[name="unit_price"]')?.value;
          return { produce_id: productId, quantity, ...(price !== undefined && price !== "" ? { unit_price: Number(price) } : {}) };
        });
        const body = {
          sale_date: data.sale_date,
          buyer_name: data.buyer_name || null,
          buyer_phone: data.buyer_phone || null,
          location_id: data.location_id || null,
          notes: data.notes || null,
          items,
        };
        if (canManage()) {
          body.payment_channel = data.payment_channel;
          body.discount = Number(data.discount || 0);
        }
        await request(`${base}/sales`, { method: "POST", body });
        state.modal = null;
        notifyUser(isWorker() ? "Sale sent for owner review." : "Sale recorded; payment is confirmed and release still needs authorization.");
        await Promise.all([loadSales(isWorker()), loadDashboard()]);
      } else if (kind === "payment") {
        await request(`${base}/sales/${encodeURIComponent(state.modal.sale.id)}/confirm-payment`, {
          method: "POST",
          body: readForm(form),
        });
        state.modal = { kind: "sale-detail", sale: state.modal.sale, items: [] };
        notifyUser("Payment confirmed. Authorize release when ready.");
        await openSale(state.modal.sale.id);
      } else if (kind === "authorization") {
        const data = readForm(form);
        const audio = await audioData(form.querySelector('[name="verbal_authorization_audio"]')?.files?.[0]);
        await request(`${base}/sales/${encodeURIComponent(state.modal.sale.id)}/authorize-release`, {
          method: "POST",
          body: { notes: data.notes || null, verbal_authorization_audio: audio },
        });
        const saleId = state.modal.sale.id;
        notifyUser("Release authorized. Stock will change only when goods are marked released.");
        await openSale(saleId);
      } else if (kind === "rejection") {
        const saleId = state.modal.sale.id;
        await request(`${base}/sales/${encodeURIComponent(saleId)}/reject`, { method: "POST", body: readForm(form) });
        notifyUser("Sale rejected. No stock movement was created.");
        await openSale(saleId);
      } else if (kind === "stock" || kind === "harvest") {
        const data = readForm(form);
        const produceId = form.dataset.id || data.produce_id;
        if (!produceId) throw new Error("Select the produce item first.");
        const action = kind === "harvest" ? "harvest" : "adjust";
        await request(`${base}/produce/${encodeURIComponent(produceId)}/${action}`, {
          method: "POST",
          body: {
            movement_type: data.movement_type || (kind === "harvest" ? "harvest" : undefined),
            quantity_change: Number(data.quantity_change),
            unit_cost: numberOrNull(data.unit_cost),
            notes: data.notes || null,
          },
        });
        state.modal = null;
        notifyUser(kind === "harvest" ? "Harvest recorded and stock updated." : "Stock adjustment saved.");
        await Promise.all([loadProduce(), loadDashboard()]);
      }
    } catch (error) {
      notifyUser(requestError(error), "error");
    }
  }
  async function openSale(id) {
    state.modal = { kind: "sale-detail", sale: {}, items: [] };
    state.loading.saleDetail = true;
    rerenderUI();
    try {
      const payload = await request(`${base}/sales/${encodeURIComponent(id)}`);
      state.modal = { kind: "sale-detail", sale: payload.sale || {}, items: payload.items || [] };
    } catch (error) {
      state.modal = null;
      notifyUser(requestError(error), "error");
    } finally {
      state.loading.saleDetail = false;
      rerenderUI();
    }
  }
  async function click(button, event) {
    const action = button.dataset.farmCommerceAction;
    const id = button.dataset.id;
    if (action === "close-modal" || action === "dismiss-modal") {
      if (action === "dismiss-modal" && event?.target !== button) return;
      state.modal = null;
      rerenderUI();
      return;
    }
    if (action === "retry") {
      const key = button.dataset.resource;
      if (key === "dashboard") await loadDashboard();
      else if (key === "produce") await loadProduce();
      else if (key === "sales") await loadSales(isWorker());
      else if (key === "expenses") await loadExpenses();
      else if (key === "cameras") await loadCameras();
      else if (key?.startsWith("report-")) await loadReport(key.slice(7));
      return;
    }
    if (action === "refresh-dashboard") return loadDashboard();
    if (action === "new-produce" && canManage()) {
      if (!core().locations?.length) await requestLocations();
      state.modal = { kind: "produce", record: {} };
    } else if (action === "edit-produce" && canManage()) {
      const record = state.produce.find((item) => item.id === id);
      if (!core().locations?.length) await requestLocations();
      state.modal = { kind: "produce", record: record || {} };
    } else if (action === "adjust-stock" && canManage()) {
      state.modal = { kind: "stock", produce: state.produce.find((item) => item.id === id) };
    } else if (action === "record-harvest" && isWorker()) {
      state.modal = { kind: "harvest", produce: state.produce.find((item) => item.id === id) };
    } else if (action === "worker-harvest" && isWorker()) {
      if (!state.produce.length) await loadProduce();
      state.modal = { kind: "harvest", produce: null };
    } else if (action === "delete-produce" && isAdmin()) {
      if (!window.confirm("Archive this produce item? Its historical movements will remain.")) return;
      await request(`${base}/produce/${encodeURIComponent(id)}`, { method: "DELETE" });
      notifyUser("Produce archived.");
      await loadProduce();
    } else if (action === "produce-movements") {
      const produce = state.produce.find((item) => item.id === id);
      const payload = await request(`${base}/produce/${encodeURIComponent(id)}/movements`);
      state.modal = { kind: "produce-movements", produce: produce || {}, movements: payload.movements || [] };
    } else if (action === "new-sale" || action === "worker-sale") {
      if (!state.produce.length) await loadProduce();
      if (!core().locations?.length && canManage()) await requestLocations();
      state.modal = { kind: "sale", record: {} };
    } else if (action === "view-sale") {
      await openSale(id);
      return;
    } else if (action === "open-payment") {
      state.modal = { kind: "confirm-payment", sale: { id } };
    } else if (action === "open-authorization") {
      state.modal = { kind: "authorize-release", sale: { id } };
    } else if (action === "open-rejection") {
      state.modal = { kind: "reject-sale", sale: { id, sale_number: state.modal?.sale?.sale_number } };
    } else if (action === "mark-released") {
      const saleId = id || state.modal?.sale?.id;
      if (!saleId) return;
      await request(`${base}/sales/${encodeURIComponent(saleId)}/mark-released`, { method: "POST", body: {} });
      notifyUser("Goods released and inventory deducted.");
      await openSale(saleId);
      await Promise.all([
        canManage() ? loadDashboard() : Promise.resolve(),
        loadSales(isWorker()),
      ]);
      return;
    } else if (action === "close-sale") {
      const saleId = state.modal.sale.id;
      await request(`${base}/sales/${encodeURIComponent(saleId)}/close`, { method: "POST", body: {} });
      notifyUser("Sale closed.");
      await openSale(saleId);
      await Promise.all([loadDashboard(), loadSales()]);
      return;
    } else if (action === "cancel-sale") {
      const saleId = state.modal.sale.id;
      if (!window.confirm("Cancel this sale before goods are released? Any payment already received still needs separate reconciliation.")) return;
      await request(`${base}/sales/${encodeURIComponent(saleId)}/cancel`, { method: "POST", body: {} });
      notifyUser("Sale cancelled.");
      await openSale(saleId);
      await Promise.all([loadDashboard(), loadSales()]);
      return;
    } else if (action === "new-expense" && canManage()) {
      if (!core().locations?.length) await requestLocations();
      state.modal = { kind: "expense", record: {} };
    } else if (action === "edit-expense" && isAdmin()) {
      if (!core().locations?.length) await requestLocations();
      state.modal = { kind: "expense", record: state.expenses.find((item) => item.id === id) || {} };
    } else if (action === "delete-expense" && isAdmin()) {
      if (!window.confirm("Archive this expense? It will no longer count in reports.")) return;
      await request(`${base}/expenses/${encodeURIComponent(id)}`, { method: "DELETE" });
      notifyUser("Expense archived.");
      await Promise.all([loadExpenses(), loadDashboard()]);
    } else if (action === "new-camera" && isAdmin()) {
      if (!core().locations?.length) await requestLocations();
      state.modal = { kind: "camera", record: {} };
    } else if (action === "edit-camera" && isAdmin()) {
      if (!core().locations?.length) await requestLocations();
      state.modal = { kind: "camera", record: state.cameras.find((camera) => camera.id === id) || {} };
    } else if (action === "delete-camera" && isAdmin()) {
      if (!window.confirm("Archive this camera registry entry?")) return;
      await request(`${base}/cameras/${encodeURIComponent(id)}`, { method: "DELETE" });
      notifyUser("Camera archived.");
      await loadCameras();
    } else if (action === "camera-heartbeat") {
      await request(`${base}/cameras/${encodeURIComponent(id)}/heartbeat`, { method: "POST", body: {} });
      notifyUser("Camera heartbeat recorded.");
      await loadCameras();
    } else if (action === "report-tab") {
      await loadReport(button.dataset.kind);
    } else if (action === "open-queue") {
      state.statusFilter = button.dataset.status || "";
      if (isWorker()) return;
      const host = document.getElementById("farmDashboard");
      const tabButton = host?.querySelector('[data-farm-action="tab"][data-tab="sales"]');
      tabButton?.click();
      return;
    } else if (action === "export-report") {
      exportReport(button.dataset.kind);
      return;
    } else if (action === "add-sale-line") {
      const lines = button.form?.querySelector("[data-sale-lines]");
      lines?.insertAdjacentHTML("beforeend", saleLine());
      return;
    } else if (action === "remove-sale-line") {
      const line = button.closest("[data-sale-line]");
      if (button.form?.querySelectorAll("[data-sale-line]").length > 1) line?.remove();
      return;
    } else if (action === "close-sale-detail") {
      state.modal = null;
    } else {
      return;
    }
    rerenderUI();
  }
  async function requestLocations() {
    if (Array.isArray(core().locations) && core().locations.length) return;
    try {
      const payload = await request(`${base}/locations`);
      core().locations = payload.locations || [];
    } catch (error) {
      notifyUser(requestError(error), "error");
    }
  }
  async function change(target) {
    if (target.matches('[data-farm-commerce-filter="sales-status"]')) {
      state.statusFilter = target.value;
      await loadSales(isWorker());
    }
    if (target.matches('[data-farm-commerce-form="sale"] [name="produce_id"]')) {
      const option = target.selectedOptions?.[0];
      const price = target.closest("[data-sale-line]")?.querySelector('[name="unit_price"]');
      if (price && option?.dataset.price) price.placeholder = `Catalog price: ${option.dataset.price}`;
    }
  }
  function exportReport(kind) {
    const report = state.reports[kind] || {};
    let rows = [];
    let headers = [];
    if (kind === "sales") {
      headers = ["sale_date", "revenue", "sales_count"];
      rows = (report.daily_series || []).map((row) => [row.sale_date, row.revenue, row.sales_count]);
    } else if (kind === "production") {
      headers = ["harvest_date", "produce", "location", "quantity", "unit", "records"];
      rows = (report.harvests || []).map((row) => [row.harvest_date, row.produce_name, row.location_name, row.quantity, row.unit, row.records]);
    } else if (kind === "expenses") {
      headers = ["category", "count", "total"];
      rows = (report.by_category || []).map((row) => [row.category, row.count, row.total]);
    } else {
      headers = ["metric", "amount"];
      rows = [["revenue", report.revenue], ["expenses", report.expenses], ["gross_profit", report.gross_profit], ["margin_pct", report.margin_pct]];
    }
    const csv = [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `farm-${kind}-${today()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
  function afterRender() {
    const chartCanvas = document.querySelector("[data-farm-commerce-chart]");
    if (!chartCanvas) {
      state.chart?.destroy?.();
      state.chart = null;
      return;
    }
    const ChartCtor = window.Chart;
    if (!ChartCtor) return;
    state.chart?.destroy?.();
    const report = state.reports[chartCanvas.dataset.farmCommerceChart] || {};
    const entries = report.daily_series || [];
    const isExpense = chartCanvas.dataset.farmCommerceChart === "expenses";
    state.chart = new ChartCtor(chartCanvas, {
      type: "line",
      data: {
        labels: entries.map((entry) => entry.sale_date || entry.expense_date),
        datasets: [{
          label: isExpense ? "Expenses (UGX)" : "Revenue (UGX)",
          data: entries.map((entry) => Number(isExpense ? entry.total : entry.revenue) || 0),
          borderColor: "#376b52",
          backgroundColor: "rgba(55,107,82,.12)",
          fill: true,
          tension: 0.28,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
  }
  async function workerQuickAction(action) {
    if (action === "worker-tab-sales") {
      await loadSales(true);
    }
  }
  async function safeClick(button, event) {
    try {
      await click(button, event);
    } catch (error) {
      notifyUser(requestError(error), "error");
    }
  }
  return {
    setUser,
    loadTab,
    render,
    renderDashboard,
    modalMarkup,
    renderWorkerActions,
    renderWorkerSales,
    hasWorkerSales,
    handleClick: safeClick,
    handleSubmit: submit,
    handleChange: change,
    workerQuickAction,
    afterRender,
  };
}
