export function createMfiReportsUI({ request, escapeHtml, money, formattedDate, announce, onRender, currentUser }) {
  const today = () => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const now = today();
  const currentYear = Number(now.slice(0, 4));
  const currentMonth = Number(now.slice(5, 7));
  const state = {
    section: "daily",
    umraSection: "monthly",
    dailyDate: now,
    agingDate: now,
    month: Number(now.slice(5, 7)),
    year: Number(now.slice(0, 4)),
    from: `${now.slice(0, 7)}-01`,
    to: now,
    loanId: "",
    reports: {},
    errors: {},
    loading: {},
    submissions: [],
    financialYearStart: "",
    financialYearEnd: "",
    chart: null,
  };
  const esc = (value) => {
    if (typeof escapeHtml === "function") return escapeHtml(value == null ? "" : String(value));
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  };
  const fmtMoney = (value) => {
    try {
      return typeof money === "function" ? money(Number(value || 0)) : `UGX ${new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(Number(value || 0))}`;
    } catch {
      return `UGX ${Number(value || 0).toLocaleString("en-UG")}`;
    }
  };
  const fmtDate = (value) => {
    if (!value) return "—";
    try {
      return typeof formattedDate === "function" ? formattedDate(value) : new Date(value).toLocaleDateString("en-UG");
    } catch {
      return String(value);
    }
  };
  const notifyRender = () => {
    if (typeof onRender === "function") onRender();
  };
  const announceMessage = (message, type = "success") => {
    if (typeof announce === "function") announce(message, type);
  };
  const query = (values) => new URLSearchParams(values).toString();
  const requestReport = async (key, path) => {
    state.loading[key] = true;
    state.errors[key] = "";
    notifyRender();
    try {
      state.reports[key] = await request(path);
    } catch (error) {
      state.errors[key] = error?.message || "This report could not be loaded.";
    } finally {
      state.loading[key] = false;
      notifyRender();
    }
  };
  const loadDaily = () => requestReport("daily", `/api/mfi/reports/daily-collection?${query({ date: state.dailyDate })}`);
  const loadAging = () => requestReport("aging", `/api/mfi/reports/portfolio-aging?${query({ as_of: state.agingDate })}`);
  const loadOfficers = () => requestReport("officers", `/api/mfi/reports/officer-performance?${query({ month: state.month, year: state.year })}`);
  const loadDisbursements = () => requestReport("disbursements", `/api/mfi/reports/disbursements?${query({ from: state.from, to: state.to })}`);
  const loadDirector = () => requestReport("director", "/api/mfi/director/dashboard");
  const loadMonthly = () => requestReport("monthly", `/api/mfi/umra/monthly-return?${query({ month: state.month, year: state.year })}`);
  const riskQuery = () => query({
    month: state.month, year: state.year,
    financial_year_start: state.financialYearStart,
    financial_year_end: state.financialYearEnd,
  });
  const loadRisk = () => requestReport("risk", `/api/mfi/umra/risk-classification?${riskQuery()}`);
  async function loadSubmissions() {
    state.loading.submissions = true;
    state.errors.submissions = "";
    notifyRender();
    try {
      const result = await request("/api/mfi/umra/submissions");
      state.submissions = Array.isArray(result?.submissions) ? result.submissions : [];
    } catch (error) {
      state.errors.submissions = error?.message || "Submission history could not be loaded.";
    } finally {
      state.loading.submissions = false;
      notifyRender();
    }
  }
  async function loadStatement() {
    const id = String(state.loanId || "").trim();
    if (!id) {
      state.errors.statement = "Enter a loan ID to view its statement.";
      notifyRender();
      return;
    }
    state.loading.statement = true;
    state.errors.statement = "";
    notifyRender();
    try {
      state.reports.statement = await request(`/api/mfi/reports/loans/${encodeURIComponent(id)}/statement`);
    } catch (error) {
      state.errors.statement = error?.message || "The loan statement could not be loaded.";
    } finally {
      state.loading.statement = false;
      notifyRender();
    }
  }
  async function load() {
    if (state.section === "daily") return loadDaily();
    if (state.section === "aging") return loadAging();
    if (state.section === "officers") return loadOfficers();
    if (state.section === "disbursements") return loadDisbursements();
    if (state.section === "statement") return loadStatement();
    if (state.section === "director") return loadDirector();
    if (state.umraSection === "monthly") return loadMonthly();
    if (state.umraSection === "risk") return loadRisk();
    return loadSubmissions();
  }

  const loadingMarkup = (label = "Loading report") => `
    <div class="mfi-state mfi-report-loading" role="status" aria-live="polite">
      <div class="mfi-report-skeleton"><span></span><span></span><span></span></div>
      <strong>${esc(label)}</strong><p>Gathering the latest account records.</p>
    </div>`;
  const errorMarkup = (key, label = "Try again") => state.errors[key]
    ? `<div class="mfi-state mfi-error-state"><div class="mfi-state-symbol">!</div><strong>Report unavailable</strong><p>${esc(state.errors[key])}</p><button type="button" class="mfi-btn mfi-btn--quiet" data-report-action="retry">${esc(label)}</button></div>`
    : "";
  const emptyMarkup = (message) => `<div class="mfi-report-empty"><span class="mfi-report-empty-mark">—</span><strong>No records in this period</strong><p>${esc(message)}</p></div>`;
  const table = (heads, rows, emptyMessage) => `
    <div class="mfi-table-wrap"><table class="mfi-table"><thead><tr>${heads.map((head) => `<th scope="col">${esc(head)}</th>`).join("")}</tr></thead>
      <tbody>${rows.length ? rows.join("") : `<tr><td class="mfi-report-empty-cell" colspan="${heads.length}">${esc(emptyMessage)}</td></tr>`}</tbody>
    </table></div>`;
  const pageHead = (eyebrow, title, description, extras = "") => `
    <div class="mfi-section-head mfi-report-heading">
      <div><p class="mfi-eyebrow">${esc(eyebrow)}</p><h2>${esc(title)}</h2><p>${esc(description)}</p></div>${extras}
    </div>`;
  const number = (value) => Number(value || 0).toLocaleString("en-UG");
  const dateForm = (name, label, value) => `<label class="mfi-field"><span>${esc(label)}</span><input class="mfi-control" type="date" name="${esc(name)}" value="${esc(value)}" required></label>`;
  const periodFields = () => `
    <label class="mfi-field"><span>Month</span><select class="mfi-control" name="month">${Array.from({ length: 12 }, (_, index) => index + 1).map((month) => `<option value="${month}" ${month === state.month ? "selected" : ""}>${new Date(2000, month - 1, 1).toLocaleString("en", { month: "long" })}</option>`).join("")}</select></label>
    <label class="mfi-field"><span>Year</span><input class="mfi-control" type="number" name="year" min="2000" max="2200" value="${esc(state.year)}" required></label>`;
  const role = () => String(currentUser?.()?.role || "").toLowerCase();
  const managementAccess = () => ["mfi_admin", "loan_manager", "loan_director", "superadmin"].includes(role());
  const tabs = [
    ["daily", "Daily collections"], ["aging", "Portfolio aging"], ["officers", "Officer performance"],
    ["disbursements", "Disbursements"], ["statement", "Loan statement"], ["director", "Director view"], ["umra", "UMRA returns"],
  ].filter(([key]) => managementAccess() || !["director", "umra"].includes(key));
  function dailyView() {
    const data = state.reports.daily;
    if (state.loading.daily) return loadingMarkup("Loading collections");
    if (state.errors.daily) return errorMarkup("daily");
    if (!data) return emptyMarkup("Choose a collection date to prepare the daily register.");
    const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => {
      const reversed = Boolean(row.reversed_at);
      return `<tr>
        <td>${esc(fmtDate(row.paid_at))}</td><td class="mfi-primary-cell"><strong>${esc(row.receipt_number || "—")}</strong><span>${esc(row.loan_number || "—")}</span></td>
        <td>${esc(`${row.first_name || ""} ${row.last_name || ""}`.trim() || "—")}<span class="mfi-report-cell-note">${esc(row.phone || "")}</span></td>
        <td>${esc(row.payment_method || "—")}</td><td>${esc(row.payment_reference || "—")}</td>
        <td class="mfi-report-number">${esc(fmtMoney(reversed ? 0 : row.amount))}</td><td>${esc(row.recorded_by_name || "—")}</td>
        <td><span class="mfi-status ${reversed ? "mfi-status--inactive" : ""}">${reversed ? "Reversed" : "Posted"}</span></td>
      </tr>`;
    });
    return `${pageHead("Collections · Daily register", "Daily collections", `${fmtDate(data.date)} · ${data.organization?.name || "Organization"}`,
      `<div class="mfi-action-row"><button type="button" class="mfi-btn mfi-btn--quiet" data-report-action="export-csv" ${rows.length ? "" : "disabled"}>Export CSV</button></div>`)}
      <div class="mfi-report-kpis">
        <div><span>Collected, excluding reversals</span><strong>${esc(fmtMoney(data.total_collected))}</strong></div>
        <div><span>Posted payments</span><strong>${esc(number(data.payment_count))}</strong></div>
        <div><span>Register entries</span><strong>${esc(number(data.rows?.length || 0))}</strong></div>
      </div>
      ${rows.length ? table(["Date / time", "Receipt / loan", "Borrower", "Method", "Reference", "Amount", "Recorded by", "Status"], rows, "") : emptyMarkup("No payments were recorded for this date.")}`;
  }
  function agingView() {
    const data = state.reports.aging;
    if (state.loading.aging) return loadingMarkup("Loading portfolio aging");
    if (state.errors.aging) return errorMarkup("aging");
    if (!data) return emptyMarkup("Request today's portfolio aging to see balances by days overdue.");
    const buckets = Array.isArray(data.buckets) ? data.buckets : [];
    const par = Array.isArray(data.par) ? data.par : [];
    const bucketRows = buckets.map((row) => `<tr><td><strong>${esc(row.label)}</strong></td><td>${esc(number(row.account_count))}</td><td class="mfi-report-number">${esc(fmtMoney(row.outstanding_balance))}</td><td>${esc((Number(row.portfolio_share || 0) * 100).toFixed(1))}%</td></tr>`);
    const loanRows = (Array.isArray(data.loans) ? data.loans : []).map((loan) => `<tr>
      <td class="mfi-primary-cell"><strong>${esc(loan.loan_number || "—")}</strong><span>${esc(loan.status || "")}</span></td>
      <td>${esc(`${loan.first_name || ""} ${loan.last_name || ""}`.trim() || "—")}</td><td>${esc(loan.branch_name || "—")}</td>
      <td>${esc(loan.officer_name || "—")}</td><td>${esc(number(loan.reported_days_overdue))} days</td><td class="mfi-report-number">${esc(fmtMoney(loan.outstanding_balance))}</td>
    </tr>`);
    return `${pageHead("Portfolio · Live snapshot", "Portfolio aging", `As of ${fmtDate(data.as_of)} · ${esc(data.organization?.name || "Organization")}`)}
      <div class="mfi-report-kpis"><div><span>Loan book</span><strong>${esc(fmtMoney(data.portfolio_balance))}</strong></div><div><span>Active accounts</span><strong>${esc(number(data.active_loan_count))}</strong></div></div>
      <div class="mfi-report-grid">
        <section class="mfi-report-inset"><div class="mfi-report-subhead"><h3>Ageing bands</h3><span>Balance share</span></div>${table(["Age band", "Accounts", "Outstanding", "Share"], bucketRows, "No aging buckets to show.")}</section>
        <section class="mfi-report-inset"><div class="mfi-report-subhead"><h3>Portfolio at risk</h3><span>Balance past threshold</span></div>${table(["Threshold", "At-risk amount", "Portfolio", "PAR"], par.map((item) => `<tr><td>PAR ${esc(item.threshold_days)} days</td><td>${esc(fmtMoney(item.at_risk_amount))}</td><td>${esc(fmtMoney(item.portfolio_amount))}</td><td>${esc((Number(item.ratio || 0) * 100).toFixed(2))}%</td></tr>`), "No PAR measures available.")}</section>
      </div>
      <section class="mfi-report-inset mfi-report-table-section"><div class="mfi-report-subhead"><h3>Accounts needing attention</h3><span>Ordered by days overdue</span></div>${table(["Loan", "Borrower", "Branch", "Officer", "Overdue", "Balance"], loanRows, "No overdue loans in this snapshot.")}</section>`;
  }
  function officersView() {
    const data = state.reports.officers;
    if (state.loading.officers) return loadingMarkup("Loading officer performance");
    if (state.errors.officers) return errorMarkup("officers");
    if (!data) return emptyMarkup("Select a reporting month to compare active officers.");
    const rows = (Array.isArray(data.officers) ? data.officers : []).map((officer) => {
      const quality = officer.portfolio_quality_ratio == null ? "—" : `${(Number(officer.portfolio_quality_ratio) * 100).toFixed(1)}%`;
      return `<tr><td class="mfi-primary-cell"><strong>${esc(officer.name || "—")}</strong><span>${esc(officer.role || "Officer")} · ${esc(officer.branch_name || "No branch")}</span></td>
        <td>${esc(number(officer.loans_disbursed))}</td><td>${esc(fmtMoney(officer.amount_disbursed))}</td><td>${esc(number(officer.active_loans))}</td>
        <td>${esc(fmtMoney(officer.managed_portfolio))}</td><td>${esc(fmtMoney(officer.par30_balance))}</td><td>${esc(quality)}</td><td>${esc(fmtMoney(officer.collections))}</td></tr>`;
    });
    return `${pageHead("People · Monthly performance", "Officer performance", `${new Date(Number(data.year), Number(data.month) - 1, 1).toLocaleString("en", { month: "long", year: "numeric" })} · ${esc(data.organization?.name || "Organization")}`)}
      ${rows.length ? table(["Officer", "Disbursed loans", "Amount disbursed", "Active loans", "Managed portfolio", "PAR 30 balance", "Portfolio quality", "Collections"], rows, "") : emptyMarkup("No active officers were reported for this period.")}`;
  }
  function disbursementsView() {
    const data = state.reports.disbursements;
    if (state.loading.disbursements) return loadingMarkup("Loading disbursements");
    if (state.errors.disbursements) return errorMarkup("disbursements");
    if (!data) return emptyMarkup("Choose a date range to review loan releases.");
    const rows = (Array.isArray(data.disbursements) ? data.disbursements : []).map((loan) => `<tr>
      <td>${esc(fmtDate(loan.disbursed_at))}</td><td class="mfi-primary-cell"><strong>${esc(loan.loan_number || "—")}</strong><span>${esc(loan.status || "")}</span></td>
      <td>${esc(`${loan.first_name || ""} ${loan.last_name || ""}`.trim() || "—")}<span class="mfi-report-cell-note">${esc(loan.phone || "")}</span></td>
      <td>${esc(loan.branch_name || "—")}</td><td>${esc(loan.officer_name || "—")}</td><td>${esc(loan.repayment_frequency || "—")}</td>
      <td class="mfi-report-number">${esc(fmtMoney(loan.principal))}</td><td>${esc(loan.disbursement_method || "—")}<span class="mfi-report-cell-note">${esc(loan.disbursement_reference || "")}</span></td>
    </tr>`);
    return `${pageHead("Lending · Release register", "Disbursements", `${fmtDate(data.from)} — ${fmtDate(data.to)} · ${esc(data.organization?.name || "Organization")}`)}
      <div class="mfi-report-kpis"><div><span>Principal released</span><strong>${esc(fmtMoney(data.total_disbursed))}</strong></div><div><span>Loans disbursed</span><strong>${esc(number(data.count))}</strong></div></div>
      ${rows.length ? table(["Date", "Loan", "Borrower", "Branch", "Officer", "Frequency", "Principal", "Method / reference"], rows, "") : emptyMarkup("No loans were disbursed in this date range.")}`;
  }
  function statementView() {
    const data = state.reports.statement;
    if (state.loading.statement) return loadingMarkup("Loading loan statement");
    if (state.errors.statement) return errorMarkup("statement");
    if (!data) return emptyMarkup("Enter the loan ID supplied by your MFI to open its account statement.");
    const loan = data.loan || {};
    const rows = (Array.isArray(data.transactions) ? data.transactions : []).map((event) => `<tr>
      <td>${esc(fmtDate(event.event_at))}</td><td><strong>${esc(event.description || event.event_type || "Account entry")}</strong><span class="mfi-report-cell-note">${esc(event.event_type || "")}</span></td>
      <td>${esc(event.reference || "—")}</td><td class="mfi-report-number">${esc(fmtMoney(event.signed_amount))}</td>
    </tr>`);
    return `${pageHead("Account record · Read only", "Loan statement", `Loan ${loan.loan_number || "—"} · ${loan.first_name || ""} ${loan.last_name || ""}`)}
      <div class="mfi-report-kpis"><div><span>Principal</span><strong>${esc(fmtMoney(loan.principal))}</strong></div><div><span>Outstanding balance</span><strong>${esc(fmtMoney(loan.outstanding_balance))}</strong></div><div><span>Loan status</span><strong class="mfi-report-kpi-status">${esc(loan.status || "—")}</strong></div></div>
      ${rows.length ? table(["Date", "Description", "Reference", "Signed amount"], rows, "") : emptyMarkup("No transactions are recorded on this statement.")}`;
  }
  function directorView() {
    const data = state.reports.director;
    if (state.loading.director) return loadingMarkup("Loading director dashboard");
    if (state.errors.director) return errorMarkup("director");
    if (!data) return emptyMarkup("The director snapshot will appear when account data is available.");
    const kpis = data.kpis || {};
    const trend = Array.isArray(data.six_month_trend) ? data.six_month_trend : [];
    const maxTrend = Math.max(1, ...trend.flatMap((entry) => [Number(entry.disbursed || 0), Number(entry.collections || 0)]));
    const chartBars = trend.length ? `<div class="mfi-report-bars" role="img" aria-label="Monthly disbursement and collection trend">${trend.map((entry) => `<div class="mfi-report-bar-group"><div class="mfi-report-bar-pair"><i style="--bar-height:${Math.max(3, Number(entry.disbursed || 0) / maxTrend * 100)}%" title="Disbursed ${esc(fmtMoney(entry.disbursed))}"></i><i class="mfi-report-bar--collection" style="--bar-height:${Math.max(3, Number(entry.collections || 0) / maxTrend * 100)}%" title="Collections ${esc(fmtMoney(entry.collections))}"></i></div><span>${esc(String(entry.month || "").slice(2))}</span></div>`).join("")}</div>` : emptyMarkup("No monthly trend data is available.") ;
    const riskRows = (Array.isArray(data.top_risks) ? data.top_risks : []).map((loan) => `<tr><td><strong>${esc(loan.loan_number || "—")}</strong></td><td>${esc(`${loan.first_name || ""} ${loan.last_name || ""}`.trim() || "—")}</td><td>${esc(loan.branch_name || "—")}</td><td>${esc(number(loan.reported_days_overdue || loan.days_overdue))} days</td><td>${esc(fmtMoney(loan.outstanding_balance))}</td></tr>`);
    const officerRows = (Array.isArray(data.top_officers) ? data.top_officers : []).map((officer, index) => `<tr><td><span class="mfi-report-rank">${String(index + 1).padStart(2, "0")}</span></td><td><strong>${esc(officer.name || "—")}</strong></td><td>${esc(fmtMoney(officer.collections))}</td></tr>`);
    return `${pageHead("Director's desk · Live snapshot", "Portfolio command", `${esc(data.organization?.name || "Organization")} · Current period ${esc(data.month || "")}`)}
      <div class="mfi-report-kpis mfi-report-kpis--director">
        <div><span>Active loans</span><strong>${esc(number(kpis.active_loans))}</strong></div><div><span>Loan book</span><strong>${esc(fmtMoney(kpis.loan_book))}</strong></div>
        <div><span>Collections this month</span><strong>${esc(fmtMoney(kpis.collections_this_month))}</strong></div><div><span>PAR 30</span><strong>${esc((Number(data.par30?.ratio || 0) * 100).toFixed(2))}%</strong></div>
        <div><span>Write-offs this month</span><strong>${esc(fmtMoney(kpis.write_offs_this_month))}</strong></div>
      </div>
      <div class="mfi-report-director-grid"><section class="mfi-report-inset"><div class="mfi-report-subhead"><h3>Six-month movement</h3><span><i class="mfi-report-legend-disbursed"></i>Disbursed <i class="mfi-report-legend-collected"></i>Collections</span></div>${chartBars}
        <div class="mfi-report-chart-wrap">${window.Chart ? '<canvas data-director-chart aria-label="Six month loan disbursement and collection chart"></canvas>' : ""}</div>
        ${table(["Month", "Disbursed", "Collections"], trend.map((item) => `<tr><td>${esc(item.month || "—")}</td><td>${esc(fmtMoney(item.disbursed))}</td><td>${esc(fmtMoney(item.collections))}</td></tr>`), "Trend data is not available.")}</section>
        <section class="mfi-report-inset"><div class="mfi-report-subhead"><h3>Highest collections</h3><span>This month</span></div>${table(["Rank", "Officer", "Collections"], officerRows, "No officer collection activity yet.")}</section></div>
      <section class="mfi-report-inset mfi-report-table-section"><div class="mfi-report-subhead"><h3>Accounts at risk</h3><span>Highest overdue first</span></div>${table(["Loan", "Borrower", "Branch", "Days overdue", "Outstanding"], riskRows, "No overdue accounts in the current snapshot.")}</section>`;
  }
  function umraControls() {
    return `<form class="mfi-report-period-form" data-report-form="umra-period"><div class="mfi-report-period-fields">${periodFields()}</div>
      ${state.umraSection === "risk" ? `<div class="mfi-report-period-fields mfi-report-financial-year">${dateForm("financial_year_start", "Financial year start", state.financialYearStart)}${dateForm("financial_year_end", "Financial year end", state.financialYearEnd)}</div>` : ""}
      <button class="mfi-btn mfi-btn--quiet" type="submit" data-report-submit="umra-load">Load period</button></form>`;
  }
  function scheduleSection(title, section) {
    const rows = Array.isArray(section?.rows) ? section.rows : [];
    return `<section class="mfi-report-inset mfi-report-schedule"><div class="mfi-report-subhead"><h3>${esc(title)}</h3><span>${esc(number(section?.account_count))} accounts</span></div>
      ${table(["Classification", "Accounts", "Outstanding", "Provision rate", "Required provision"], rows.map((row) => `<tr><td><strong>${esc(row.classification || "—")}</strong></td><td>${esc(number(row.account_count))}</td><td>${esc(fmtMoney(row.outstanding_portfolio))}</td><td>${esc((Number(row.required_provision_rate || 0) * 100).toFixed(0))}%</td><td>${esc(fmtMoney(row.required_provision_amount))}</td></tr>`), "No classifications are available.")}
      <div class="mfi-report-total-line"><span>Subtotal</span><strong>${esc(fmtMoney(section?.outstanding_portfolio))}</strong><span>Required</span><strong>${esc(fmtMoney(section?.required_provision_amount))}</strong></div></section>`;
  }
  function monthlyView() {
    const data = state.reports.monthly?.report;
    if (state.loading.monthly) return loadingMarkup("Preparing management summary");
    if (state.errors.monthly) return errorMarkup("monthly");
    if (!data) return emptyMarkup("Load a month to review its internal management summary.");
    const period = data.period_metrics || {};
    const portfolio = data.portfolio_snapshot || {};
    const parRows = (Array.isArray(portfolio.par) ? portfolio.par : []).map((item) => `<tr><td>PAR ${esc(item.threshold_days)} days</td><td>${esc(fmtMoney(item.at_risk_amount))}</td><td>${esc(fmtMoney(item.portfolio_amount))}</td><td>${esc((Number(item.ratio || 0) * 100).toFixed(2))}%</td></tr>`);
    const save = state.reports.monthly?.submission;
    return `${pageHead("UMRA workspace · Internal", "Monthly management summary", `${esc(data.organization?.name || "Organization")} · ${esc(data.period?.year)}-${String(data.period?.month || "").padStart(2, "0")}`,
      `<button type="button" class="mfi-btn" data-report-action="save-monthly">${save ? "Update saved summary" : "Save local summary"}</button>`)}
      <div class="mfi-report-notice"><strong>Internal management record</strong><span>This monthly summary is not a statutory filing. No return is automatically transmitted or filed with UMRA.</span></div>
      <div class="mfi-report-kpis"><div><span>Disbursed this month</span><strong>${esc(fmtMoney(period.amount_disbursed))}</strong></div><div><span>Collections</span><strong>${esc(fmtMoney(period.collections))}</strong></div><div><span>Active borrowers</span><strong>${esc(number(portfolio.active_borrowers))}</strong></div><div><span>Loan book</span><strong>${esc(fmtMoney(portfolio.loan_book))}</strong></div></div>
      <div class="mfi-report-grid"><section class="mfi-report-inset"><div class="mfi-report-subhead"><h3>Period activity</h3><span>${esc(data.period?.start)} to ${esc(data.period?.end_exclusive)}</span></div>
        ${table(["Measure", "Value"], [
          `<tr><td>Loans disbursed</td><td>${esc(number(period.loans_disbursed))}</td></tr>`,
          `<tr><td>Average loan size</td><td>${esc(fmtMoney(period.average_loan_size))}</td></tr>`,
          `<tr><td>Gross write-offs</td><td>${esc(fmtMoney(period.gross_write_offs))}</td></tr>`,
          `<tr><td>Reversed write-offs</td><td>${esc(fmtMoney(period.reversed_write_offs))}</td></tr>`,
          `<tr><td>Female borrowers</td><td>${esc(number(portfolio.female_borrowers))} · ${esc(portfolio.female_borrower_percentage)}%</td></tr>`,
          `<tr><td>Active branches</td><td>${esc(number(portfolio.active_branches))}</td></tr>`,
          `<tr><td>Required provisions</td><td>${esc(fmtMoney(portfolio.total_required_provisions))}</td></tr>`,
        ], "No summary metrics are available.")}</section>
        <section class="mfi-report-inset"><div class="mfi-report-subhead"><h3>Portfolio at risk</h3><span>Snapshot at ${esc(fmtDate(data.balance_as_of))}</span></div>${table(["Measure", "At risk", "Portfolio", "Ratio"], parRows, "No PAR records.")}<p class="mfi-report-footnote">${esc(data.operational_self_sufficiency?.note || "Operational self-sufficiency is unavailable.")}</p></section></div>`;
  }
  function riskView() {
    const data = state.reports.risk?.report;
    if (state.loading.risk) return loadingMarkup("Preparing Schedule 3 draft");
    if (state.errors.risk) return errorMarkup("risk");
    if (!data) return emptyMarkup("Select a quarter-end month and financial year to prepare Schedule 3.");
    const schedule = data.schedule_3 || {};
    const save = state.reports.risk?.submission;
    return `${pageHead("UMRA workspace · Quarterly", "Risk classification · Schedule 3", `${esc(data.organization?.name || "Organization")} · Quarter ${esc(data.period?.quarter || "")} ending ${esc(data.period?.quarter_end || "")}`,
      `<button type="button" class="mfi-btn" data-report-action="save-risk">${save ? "Update saved Schedule 3" : "Save local Schedule 3"}</button>`)}
      <div class="mfi-report-notice mfi-report-notice--statutory"><strong>Local statutory return draft</strong><span>Prepared for review only. APSHULE does not transmit or file this return with UMRA; submit it through the UMRA reporting portal.</span></div>
      <div class="mfi-report-meta-line"><span>Financial year</span><strong>${esc(data.financial_year?.start || "—")} — ${esc(data.financial_year?.end || "—")}</strong><span>Generated</span><strong>${esc(fmtDate(data.generated_at))}</strong></div>
      ${scheduleSection("Portfolio ageing report", schedule.portfolio_ageing)}
      ${scheduleSection("Rescheduling or reclassification of loans", schedule.rescheduled_or_reclassified)}
      <div class="mfi-report-grand-total"><span>Grand total · ${esc(number(schedule.account_count))} accounts</span><strong>${esc(fmtMoney(schedule.outstanding_portfolio))}</strong><span>Required provision</span><strong>${esc(fmtMoney(schedule.required_provision_amount))}</strong></div>`;
  }
  function submissionsView() {
    if (state.loading.submissions) return loadingMarkup("Loading saved returns");
    if (state.errors.submissions) return errorMarkup("submissions");
    if (!state.submissions.length) return emptyMarkup("Saved local return records will appear here. Saving does not submit them to UMRA.");
    const rows = state.submissions.map((item) => `<tr><td>${esc(item.period_year)}-${String(item.period_month || "").padStart(2, "0")}</td>
      <td>${esc(item.report_type === "monthly_summary" ? "Monthly management summary" : "Quarterly risk classification · Schedule 3")}</td>
      <td>${esc(fmtDate(item.submitted_at))}</td><td>${esc(item.submitted_by || "—")}</td>
      <td><button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-report-action="download-pdf" data-submission-id="${esc(item.id)}" ${state.loading.pdf ? "disabled" : ""}>${state.loading.pdf ? "Preparing…" : "Download PDF"}</button></td></tr>`);
    return `${state.errors.pdf ? `<p class="mfi-form-error" role="alert">${esc(state.errors.pdf)}</p>` : ""}
      ${table(["Period", "Return type", "Saved at", "Saved by", "Document"], rows, "No saved returns.")}`;
  }
  function umraView() {
    let body = state.umraSection === "monthly" ? monthlyView()
      : state.umraSection === "risk" ? riskView() : submissionsView();
    return `<section class="mfi-report-umra">${pageHead("Regulatory records · Local preparation", "UMRA returns", "Build and retain clear records for internal review and statutory preparation. No return is filed automatically.")}
      <nav class="mfi-subtabs mfi-report-inner-tabs" aria-label="UMRA return type">
        <button type="button" data-umra-tab="monthly" aria-selected="${state.umraSection === "monthly"}">Monthly summary</button>
        <button type="button" data-umra-tab="risk" aria-selected="${state.umraSection === "risk"}">Quarterly Schedule 3</button>
        <button type="button" data-umra-tab="history" aria-selected="${state.umraSection === "history"}">Saved returns</button>
      </nav>
      ${state.umraSection !== "history" ? umraControls() : ""}
      ${body}</section>`;
  }
  function drawChart(root) {
    if (state.chart) {
      try { state.chart.destroy(); } catch { /* Chart instance may already be detached. */ }
      state.chart = null;
    }
    if (typeof window === "undefined" || typeof window.Chart !== "function") return;
    const canvas = root?.querySelector("[data-director-chart]");
    const entries = state.reports.director?.six_month_trend;
    if (!canvas || !Array.isArray(entries) || !entries.length) return;
    try {
      state.chart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels: entries.map((entry) => entry.month),
          datasets: [
            { label: "Disbursed", data: entries.map((entry) => Number(entry.disbursed || 0)), borderColor: "#17645f", backgroundColor: "rgba(23,100,95,.08)", tension: .28 },
            { label: "Collections", data: entries.map((entry) => Number(entry.collections || 0)), borderColor: "#d39a40", backgroundColor: "rgba(211,154,64,.08)", tension: .28 },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
      });
    } catch {
      state.chart = null;
    }
  }
  function render() {
    const activeTab = tabs.map(([key, label]) => `<button type="button" data-report-tab="${key}" aria-selected="${state.section === key}">${esc(label)}</button>`).join("");
    let content;
    if (state.section === "daily") {
      content = `<form class="mfi-report-filter" data-report-form="daily">${dateForm("date", "Collection date", state.dailyDate)}<button class="mfi-btn" type="submit">Show collections</button></form>${dailyView()}`;
    } else if (state.section === "aging") {
      content = `<form class="mfi-report-filter" data-report-form="aging">${dateForm("as_of", "Snapshot date", state.agingDate)}<button class="mfi-btn" type="submit">Refresh snapshot</button></form>${agingView()}`;
    } else if (state.section === "officers") {
      content = `<form class="mfi-report-filter mfi-report-period-form" data-report-form="officers"><div class="mfi-report-period-fields">${periodFields()}</div><button class="mfi-btn" type="submit">Run performance report</button></form>${officersView()}`;
    } else if (state.section === "disbursements") {
      content = `<form class="mfi-report-filter mfi-report-period-form" data-report-form="disbursements">${dateForm("from", "From", state.from)}${dateForm("to", "To", state.to)}<button class="mfi-btn" type="submit">Run disbursements</button></form>${disbursementsView()}`;
    } else if (state.section === "statement") {
      const knownLoans = Array.isArray(state.reports.aging?.loans) ? state.reports.aging.loans : [];
      const loanChoices = knownLoans.map((loan) => `<option value="${esc(loan.id)}" label="${esc(`${loan.loan_number || "Loan"} · ${`${loan.first_name || ""} ${loan.last_name || ""}`.trim()}`)}"></option>`).join("");
      content = `<form class="mfi-report-filter" data-report-form="statement"><label class="mfi-field mfi-report-loan-input"><span>Loan account</span><input class="mfi-control" name="loan_id" list="mfi-report-loan-options" value="${esc(state.loanId)}" autocomplete="off" placeholder="Select or paste a loan ID" required><datalist id="mfi-report-loan-options">${loanChoices}</datalist></label><button class="mfi-btn" type="submit">Open statement</button></form>${statementView()}`;
    } else if (state.section === "director") {
      content = directorView();
    } else {
      content = umraView();
    }
    const markup = `<div class="mfi-reports-ui"><nav class="mfi-subtabs mfi-report-tabs" aria-label="Reports workspace">${activeTab}<button type="button" class="mfi-btn mfi-btn--quiet mfi-btn--small" data-report-action="print">Print report</button></nav><div class="mfi-report-content">${content}</div></div>`;
    const root = state.boundRoot;
    if (root) {
      window.requestAnimationFrame?.(() => drawChart(root));
    }
    return markup;
  }
  async function saveUmra(kind) {
    const isRisk = kind === "risk";
    const key = isRisk ? "risk" : "monthly";
    const path = isRisk ? "/api/mfi/umra/risk-classification" : "/api/mfi/umra/monthly-return";
    if (isRisk && ![3, 6, 9, 12].includes(Number(state.month))) {
      state.errors.risk = "Schedule 3 periods must end in March, June, September, or December.";
      notifyRender();
      return;
    }
    const body = { month: Number(state.month), year: Number(state.year) };
    if (isRisk) {
      body.financial_year_start = state.financialYearStart;
      body.financial_year_end = state.financialYearEnd;
    }
    state.loading[key] = true;
    state.errors[key] = "";
    notifyRender();
    try {
      const result = await request(path, { method: "POST", body });
      state.reports[key] = result || {};
      announceMessage(isRisk ? "Schedule 3 saved as a local APSHULE record. It was not filed with UMRA." : "Management summary saved locally. It was not filed with UMRA.");
      try {
        const list = await request("/api/mfi/umra/submissions");
        state.submissions = Array.isArray(list?.submissions) ? list.submissions : state.submissions;
      } catch {
        // The saved return is still successful; history can be refreshed separately.
      }
    } catch (error) {
      state.errors[key] = error?.message || "This return could not be saved.";
      announceMessage(state.errors[key], "error");
    } finally {
      state.loading[key] = false;
      notifyRender();
    }
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  function exportDailyCsv() {
    const data = state.reports.daily;
    if (!data || !Array.isArray(data.rows)) return;
    const headers = ["Date/time", "Receipt", "Loan number", "Borrower", "Phone", "Method", "Reference", "Amount UGX", "Recorded by", "Status", "Notes"];
    const rows = data.rows.map((row) => [
      row.paid_at, row.receipt_number, row.loan_number, `${row.first_name || ""} ${row.last_name || ""}`.trim(),
      row.phone, row.payment_method, row.payment_reference, row.reversed_at ? 0 : row.amount,
      row.recorded_by_name, row.reversed_at ? "reversed" : "posted", row.reversed_at ? row.reversal_reason : row.notes,
    ]);
    downloadBlob(new Blob(["\uFEFF", [headers, ...rows].map((line) => line.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }), `mfi-daily-collections-${data.date || state.dailyDate}.csv`);
  }
  async function downloadPdf(id) {
    state.loading.pdf = true;
    state.errors.pdf = "";
    notifyRender();
    try {
      const result = await request(`/api/mfi/umra/submissions/${encodeURIComponent(id)}/pdf`);
      const binary = atob(result.base64 || "");
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      downloadBlob(new Blob([bytes], { type: result.mime_type || "application/pdf" }), result.filename || "umra-return.pdf");
      announceMessage("PDF downloaded.");
    } catch (error) {
      state.errors.pdf = error?.message || "PDF could not be downloaded.";
      announceMessage(state.errors.pdf, "error");
    } finally {
      state.loading.pdf = false;
      notifyRender();
    }
  }
  function bind(root) {
    if (!root || root.dataset.mfiReportsBound === "true") return;
    root.dataset.mfiReportsBound = "true";
    state.boundRoot = root;
    root.addEventListener("click", (event) => {
      const target = event.target.closest("[data-report-tab], [data-umra-tab], [data-report-action]");
      if (!target || !root.contains(target)) return;
      if (target.hasAttribute("data-report-tab")) {
        state.section = target.dataset.reportTab;
        if (state.section === "umra") state.umraSection = "monthly";
        notifyRender();
        load();
      } else if (target.hasAttribute("data-umra-tab")) {
        state.umraSection = target.dataset.umraTab;
        notifyRender();
        load();
      } else {
        const action = target.dataset.reportAction;
        if (action === "retry") load();
        if (action === "export-csv") exportDailyCsv();
        if (action === "print") window.print();
        if (action === "save-monthly") saveUmra("monthly");
        if (action === "save-risk") saveUmra("risk");
        if (action === "download-pdf") downloadPdf(target.dataset.submissionId);
      }
    });
    root.addEventListener("submit", (event) => {
      const form = event.target.closest("[data-report-form]");
      if (!form || !root.contains(form)) return;
      event.preventDefault();
      const values = new FormData(form);
      const name = form.dataset.reportForm;
      if (name === "daily") {
        state.dailyDate = String(values.get("date") || state.dailyDate);
        loadDaily();
      } else if (name === "aging") {
        state.agingDate = String(values.get("as_of") || state.agingDate);
        loadAging();
      } else if (name === "officers") {
        state.month = Number(values.get("month") || state.month);
        state.year = Number(values.get("year") || state.year);
        loadOfficers();
      } else if (name === "disbursements") {
        state.from = String(values.get("from") || state.from);
        state.to = String(values.get("to") || state.to);
        loadDisbursements();
      } else if (name === "statement") {
        state.loanId = String(values.get("loan_id") || "").trim();
        loadStatement();
      } else if (name === "umra-period") {
        state.month = Number(values.get("month") || state.month);
        state.year = Number(values.get("year") || state.year);
        state.financialYearStart = String(values.get("financial_year_start") || state.financialYearStart);
        state.financialYearEnd = String(values.get("financial_year_end") || state.financialYearEnd);
        load();
      }
    });
  }
  function reset() {
    if (state.chart) {
      try { state.chart.destroy(); } catch { /* Ignore a detached chart instance. */ }
      state.chart = null;
    }
    state.section = "daily";
    state.umraSection = "monthly";
    state.loanId = "";
    state.reports = {};
    state.errors = {};
    state.loading = {};
    state.submissions = [];
  }
  return { render, load, bind, reset };
}
