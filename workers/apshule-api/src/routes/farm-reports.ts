import { Hono, type Context } from "hono";
import { getDb } from "../db.js";
import { requireRole } from "../auth.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";
import { calculateProfitLoss } from "../farm-commerce-domain.js";
import {
  assertLocationInOrganization,
  dateValue,
  fail,
  farmScope,
  pathUuid,
} from "../farm-commerce-shared.js";

const reports = new Hono<AppEnv>();
const ADMIN_MANAGER = ["farm_admin", "farm_manager"] as const;

function actor(c: { get(key: "user"): AuthenticatedUser }): AuthenticatedUser {
  return c.get("user");
}

function asNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

async function dateRange(sql: ReturnType<typeof getDb>, organizationId: string, c: Context<AppEnv>) {
  const requestedFrom = dateValue(c.req.query("from"), "from", true);
  const requestedTo = dateValue(c.req.query("to"), "to", true);
  const dates = await sql`
    SELECT to_char(local_today, 'YYYY-MM-DD') AS today,
      to_char(local_today - INTERVAL '29 days', 'YYYY-MM-DD') AS month_start
    FROM (
      SELECT (NOW() AT TIME ZONE COALESCE(
        (SELECT timezone FROM farm_settings WHERE organization_id = ${organizationId} LIMIT 1),
        'Africa/Kampala'
      ))::date AS local_today
    ) d
  `;
  const today = String((dates[0] as { today?: string } | undefined)?.today || new Date().toISOString().slice(0, 10));
  const monthStart = String((dates[0] as { month_start?: string } | undefined)?.month_start || today);
  const from = requestedFrom ?? monthStart;
  const to = requestedTo ?? today;
  if (from > to) fail(400, "VALIDATION_ERROR", "from must be on or before to.");
  return { from, to };
}

async function selectedLocation(sql: ReturnType<typeof getDb>, organizationId: string, c: Context<AppEnv>) {
  const requested = c.req.query("location_id");
  const locationId = requested ? pathUuid(requested, "location_id") : null;
  if (locationId) await assertLocationInOrganization(sql, organizationId, locationId);
  return locationId;
}

reports.get("/reports/production", requireRole(...ADMIN_MANAGER), async (c) => {
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor(c));
  const { from, to } = await dateRange(sql, scope.organizationId, c);
  const locationId = await selectedLocation(sql, scope.organizationId, c);
  const [eggRows, harvestRows] = await Promise.all([
    sql`
      SELECT e.record_date, l.name AS location_name, e.shift,
        SUM(e.eggs_collected)::int AS eggs_collected,
        SUM(e.eggs_broken)::int AS eggs_broken,
        SUM(e.eggs_good)::int AS eggs_good
      FROM farm_egg_records e
      JOIN farm_locations l ON l.id = e.location_id
      WHERE e.organization_id = ${scope.organizationId}
        AND e.record_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR e.location_id = ${locationId})
      GROUP BY e.record_date, l.name, e.shift
      ORDER BY e.record_date DESC, l.name, e.shift
      LIMIT 1000
    `,
    sql`
      SELECT m.created_at::date AS harvest_date, p.name AS produce_name,
        p.unit, l.name AS location_name, SUM(m.quantity)::numeric AS quantity,
        COUNT(*)::int AS records
      FROM farm_produce_movements m
      JOIN farm_produce p ON p.id = m.produce_id
      LEFT JOIN farm_locations l ON l.id = p.location_id
      WHERE m.organization_id = ${scope.organizationId}
        AND m.movement_type = 'harvest'
        AND m.created_at::date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR p.location_id = ${locationId})
      GROUP BY m.created_at::date, p.name, p.unit, l.name
      ORDER BY harvest_date DESC, p.name
      LIMIT 1000
    `,
  ]);
  const eggs = eggRows as Array<Record<string, unknown>>;
  const harvests = harvestRows as Array<Record<string, unknown>>;
  return c.json({
    from,
    to,
    eggs,
    harvests,
    totals: {
      eggs_collected: eggs.reduce((sum, row) => sum + asNumber(row.eggs_collected), 0),
      eggs_broken: eggs.reduce((sum, row) => sum + asNumber(row.eggs_broken), 0),
      eggs_good: eggs.reduce((sum, row) => sum + asNumber(row.eggs_good), 0),
      harvested_quantity: harvests.reduce((sum, row) => sum + asNumber(row.quantity), 0),
    },
  });
});

reports.get("/reports/sales", requireRole(...ADMIN_MANAGER), async (c) => {
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor(c));
  const { from, to } = await dateRange(sql, scope.organizationId, c);
  const locationId = await selectedLocation(sql, scope.organizationId, c);
  const [summaryRows, topRows, seriesRows] = await Promise.all([
    sql`
      SELECT COUNT(*) FILTER (WHERE status IN ('released', 'closed'))::int AS completed_count,
        COALESCE(SUM(total) FILTER (WHERE status IN ('released', 'closed')), 0)::numeric AS total_sales,
        COALESCE(SUM(amount_paid) FILTER (WHERE status IN ('released', 'closed')), 0)::numeric AS paid_amount,
        COALESCE(SUM(balance_due) FILTER (
          WHERE status NOT IN ('closed', 'rejected', 'cancelled')
        ), 0)::numeric AS outstanding,
        COUNT(*) FILTER (WHERE status = 'pending_owner_review')::int AS pending_review_count,
        COUNT(*) FILTER (WHERE status = 'payment_confirmed')::int AS payment_confirmed_count,
        COUNT(*) FILTER (WHERE status = 'release_authorized')::int AS release_authorized_count,
        COUNT(*) FILTER (WHERE status = 'released')::int AS released_count
      FROM farm_sales
      WHERE organization_id = ${scope.organizationId}
        AND sale_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR location_id = ${locationId})
    `,
    sql`
      SELECT i.produce_name, SUM(i.quantity)::numeric AS quantity,
        SUM(i.total) FILTER (WHERE s.status IN ('released', 'closed'))::numeric AS revenue
      FROM farm_sale_items i
      JOIN farm_sales s ON s.id = i.sale_id
      WHERE s.organization_id = ${scope.organizationId}
        AND s.sale_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR s.location_id = ${locationId})
      GROUP BY i.produce_name
      ORDER BY COALESCE(SUM(i.total) FILTER (WHERE s.status IN ('released', 'closed')), 0) DESC
      LIMIT 10
    `,
    sql`
      SELECT s.sale_date, SUM(s.total) FILTER (WHERE s.status IN ('released', 'closed'))::numeric AS revenue,
        COUNT(*) FILTER (WHERE s.status IN ('released', 'closed'))::int AS sales_count
      FROM farm_sales s
      WHERE s.organization_id = ${scope.organizationId}
        AND s.sale_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR s.location_id = ${locationId})
      GROUP BY s.sale_date
      ORDER BY s.sale_date
    `,
  ]);
  return c.json({
    from,
    to,
    ...summaryRows[0],
    top_products: topRows,
    daily_series: seriesRows,
  });
});

reports.get("/reports/expenses", requireRole(...ADMIN_MANAGER), async (c) => {
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor(c));
  const { from, to } = await dateRange(sql, scope.organizationId, c);
  const locationId = await selectedLocation(sql, scope.organizationId, c);
  const [summaryRows, categoryRows, seriesRows] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS expense_count, COALESCE(SUM(amount), 0)::numeric AS total_expenses
      FROM farm_expenses
      WHERE organization_id = ${scope.organizationId} AND active IS TRUE
        AND expense_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR location_id = ${locationId})
    `,
    sql`
      SELECT category, SUM(amount)::numeric AS total, COUNT(*)::int AS count
      FROM farm_expenses
      WHERE organization_id = ${scope.organizationId} AND active IS TRUE
        AND expense_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR location_id = ${locationId})
      GROUP BY category
      ORDER BY SUM(amount) DESC
      LIMIT 50
    `,
    sql`
      SELECT expense_date, SUM(amount)::numeric AS total
      FROM farm_expenses
      WHERE organization_id = ${scope.organizationId} AND active IS TRUE
        AND expense_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR location_id = ${locationId})
      GROUP BY expense_date
      ORDER BY expense_date
    `,
  ]);
  return c.json({
    from,
    to,
    ...summaryRows[0],
    by_category: categoryRows,
    daily_series: seriesRows,
  });
});

reports.get("/reports/profit-loss", requireRole(...ADMIN_MANAGER), async (c) => {
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor(c));
  const { from, to } = await dateRange(sql, scope.organizationId, c);
  const locationId = await selectedLocation(sql, scope.organizationId, c);
  const [revenueRows, expenseRows] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(total), 0)::numeric AS revenue
      FROM farm_sales
      WHERE organization_id = ${scope.organizationId}
        AND status IN ('released', 'closed')
        AND sale_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR location_id = ${locationId})
    `,
    sql`
      SELECT COALESCE(SUM(amount), 0)::numeric AS expenses
      FROM farm_expenses
      WHERE organization_id = ${scope.organizationId} AND active IS TRUE
        AND expense_date BETWEEN ${from}::date AND ${to}::date
        AND (${locationId}::uuid IS NULL OR location_id = ${locationId})
    `,
  ]);
  const result = calculateProfitLoss(
    asNumber((revenueRows[0] as Record<string, unknown> | undefined)?.revenue),
    asNumber((expenseRows[0] as Record<string, unknown> | undefined)?.expenses),
  );
  return c.json({ from, to, ...result });
});

reports.get("/reports/dashboard", requireRole(...ADMIN_MANAGER), async (c) => {
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor(c));
  const [metricRows, seriesRows, lowStockRows] = await Promise.all([
    sql`
      SELECT
        (SELECT COALESCE(SUM(a.quantity), 0)::int FROM farm_animals a
          WHERE a.organization_id = ${scope.organizationId} AND a.status <> 'deleted') AS animals_total,
        (SELECT COALESCE(SUM(e.eggs_collected), 0)::int FROM farm_egg_records e
          WHERE e.organization_id = ${scope.organizationId}
            AND e.record_date >= (NOW() AT TIME ZONE 'Africa/Kampala')::date - 6
            AND e.record_date <= (NOW() AT TIME ZONE 'Africa/Kampala')::date) AS eggs_this_week,
        (SELECT COALESCE(SUM(e.eggs_collected), 0)::int FROM farm_egg_records e
          WHERE e.organization_id = ${scope.organizationId}
            AND e.record_date >= (NOW() AT TIME ZONE 'Africa/Kampala')::date - 13
            AND e.record_date < (NOW() AT TIME ZONE 'Africa/Kampala')::date - 6) AS eggs_last_week,
        (SELECT COALESCE(SUM(p.current_stock * COALESCE(p.cost_price, 0)), 0)::numeric
          FROM farm_produce p WHERE p.organization_id = ${scope.organizationId} AND p.active IS TRUE) AS produce_value,
        (SELECT COALESCE(SUM(s.total), 0)::numeric FROM farm_sales s
          WHERE s.organization_id = ${scope.organizationId}
            AND s.status IN ('released', 'closed')
            AND date_trunc('month', s.sale_date) = date_trunc('month', (NOW() AT TIME ZONE 'Africa/Kampala')::date)) AS sales_this_month,
        (SELECT COALESCE(SUM(e.amount), 0)::numeric FROM farm_expenses e
          WHERE e.organization_id = ${scope.organizationId} AND e.active IS TRUE
            AND date_trunc('month', e.expense_date) = date_trunc('month', (NOW() AT TIME ZONE 'Africa/Kampala')::date)) AS expenses_this_month,
        (SELECT COUNT(*)::int FROM farm_sales s
          WHERE s.organization_id = ${scope.organizationId} AND s.status = 'pending_owner_review') AS pending_review_count,
        (SELECT COUNT(*)::int FROM farm_sales s
          WHERE s.organization_id = ${scope.organizationId} AND s.status = 'payment_confirmed') AS payment_confirmed_count,
        (SELECT COUNT(*)::int FROM farm_sales s
          WHERE s.organization_id = ${scope.organizationId} AND s.status = 'released') AS released_awaiting_close_count,
        (SELECT COUNT(*)::int FROM farm_health_logs h
          WHERE h.organization_id = ${scope.organizationId}
            AND h.next_due_date BETWEEN (NOW() AT TIME ZONE 'Africa/Kampala')::date
            AND (NOW() AT TIME ZONE 'Africa/Kampala')::date + 7) AS treatments_due,
        (SELECT COUNT(*)::int FROM farm_workers w
          LEFT JOIN farm_attendance a ON a.worker_id = w.id
            AND a.attendance_date = (NOW() AT TIME ZONE 'Africa/Kampala')::date
          WHERE w.organization_id = ${scope.organizationId} AND w.active IS TRUE
            AND (a.id IS NULL OR a.status = 'absent')) AS absent_today
    `,
    sql`
      WITH days AS (
        SELECT generate_series(
          (NOW() AT TIME ZONE 'Africa/Kampala')::date - 29,
          (NOW() AT TIME ZONE 'Africa/Kampala')::date,
          INTERVAL '1 day'
        )::date AS day
      ), eggs AS (
        SELECT record_date AS day, SUM(eggs_collected)::int AS eggs
        FROM farm_egg_records
        WHERE organization_id = ${scope.organizationId}
          AND record_date >= (NOW() AT TIME ZONE 'Africa/Kampala')::date - 29
        GROUP BY record_date
      ), sales AS (
        SELECT sale_date AS day, SUM(total)::numeric AS revenue
        FROM farm_sales
        WHERE organization_id = ${scope.organizationId}
          AND status IN ('released', 'closed')
          AND sale_date >= (NOW() AT TIME ZONE 'Africa/Kampala')::date - 29
        GROUP BY sale_date
      ), expenses AS (
        SELECT expense_date AS day, SUM(amount)::numeric AS total
        FROM farm_expenses
        WHERE organization_id = ${scope.organizationId} AND active IS TRUE
          AND expense_date >= (NOW() AT TIME ZONE 'Africa/Kampala')::date - 29
        GROUP BY expense_date
      )
      SELECT d.day, COALESCE(e.eggs, 0)::int AS eggs,
        COALESCE(s.revenue, 0)::numeric AS revenue,
        COALESCE(x.total, 0)::numeric AS expenses
      FROM days d LEFT JOIN eggs e ON e.day = d.day
        LEFT JOIN sales s ON s.day = d.day LEFT JOIN expenses x ON x.day = d.day
      ORDER BY d.day
    `,
    sql`
      SELECT id, name, category, unit, current_stock, reorder_level, location_id
      FROM farm_produce
      WHERE organization_id = ${scope.organizationId} AND active IS TRUE
        AND reorder_level > 0 AND current_stock <= reorder_level
      ORDER BY current_stock / NULLIF(reorder_level, 0), name
      LIMIT 10
    `,
  ]);
  const metrics = (metricRows[0] || {}) as Record<string, unknown>;
  const eggsThisWeek = asNumber(metrics.eggs_this_week);
  const eggsLastWeek = asNumber(metrics.eggs_last_week);
  const profit = calculateProfitLoss(
    asNumber(metrics.sales_this_month),
    asNumber(metrics.expenses_this_month),
  );
  return c.json({
    ...metrics,
    eggs_trend_pct: eggsLastWeek > 0
      ? Number((((eggsThisWeek - eggsLastWeek) / eggsLastWeek) * 100).toFixed(1))
      : (eggsThisWeek > 0 ? 100 : 0),
    profit_this_month: profit.gross_profit,
    margin_pct: profit.margin_pct,
    daily_series: seriesRows,
    low_stock: lowStockRows,
    period_days: 30,
  });
});

export default reports;
