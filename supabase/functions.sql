-- ============================================================
-- Postgres RPC Functions
-- ============================================================
-- Run these in the Supabase SQL editor AFTER schema.sql.
-- Why RPC instead of fetching rows: at 10k employees x 84 weeks
-- (~1.3M allocation rows), client-side aggregation is unworkable.
-- These functions push the math into Postgres — one round-trip,
-- indexes get used, network payload is tiny.
-- ============================================================

-- ─── 1. Utilization for an employee over a date range ────────
-- Returns one row per week with allocation_pct + status counts.
-- Used by the employee profile page.

CREATE OR REPLACE FUNCTION fn_employee_utilization(
  p_employee_id UUID,
  p_from        DATE,
  p_to          DATE
)
RETURNS TABLE (
  week_start         DATE,
  total_allocation   NUMERIC,
  confirmed_pct      NUMERIC,
  proposed_pct       NUMERIC,
  available_pct      NUMERIC,
  status_summary     TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    fa.week_start,
    SUM(fa.allocation_pct)                                            AS total_allocation,
    SUM(fa.allocation_pct) FILTER (WHERE fa.allocation_status = 'confirmed') AS confirmed_pct,
    SUM(fa.allocation_pct) FILTER (WHERE fa.allocation_status = 'proposed')  AS proposed_pct,
    SUM(fa.allocation_pct) FILTER (WHERE fa.allocation_status = 'available') AS available_pct,
    string_agg(DISTINCT fa.allocation_status, ', ' ORDER BY fa.allocation_status) AS status_summary
  FROM forecast_allocations fa
  WHERE fa.employee_id = p_employee_id
    AND fa.week_start BETWEEN p_from AND p_to
  GROUP BY fa.week_start
  ORDER BY fa.week_start;
$$;

-- ─── 2. Over-allocated employees for a week ──────────────────
-- Returns employees whose summed allocation > 100% in any week
-- of the given range. The frontend uses this for the "conflicts"
-- panel on the resource page.

CREATE OR REPLACE FUNCTION fn_over_allocated(
  p_from DATE,
  p_to   DATE
)
RETURNS TABLE (
  employee_id      UUID,
  employee_code    TEXT,
  employee_name    TEXT,
  week_start       DATE,
  total_allocation NUMERIC,
  project_count    INT
)
LANGUAGE sql STABLE AS $$
  SELECT
    e.id              AS employee_id,
    e.employee_id     AS employee_code,
    e.name            AS employee_name,
    fa.week_start,
    SUM(fa.allocation_pct) AS total_allocation,
    COUNT(DISTINCT fa.project_id)::int AS project_count
  FROM forecast_allocations fa
  JOIN employees e ON e.id = fa.employee_id
  WHERE fa.week_start BETWEEN p_from AND p_to
    AND fa.allocation_status IN ('confirmed', 'proposed')
  GROUP BY e.id, e.employee_id, e.name, fa.week_start
  HAVING SUM(fa.allocation_pct) > 100
  ORDER BY fa.week_start, total_allocation DESC;
$$;

-- ─── 3. Available capacity for a week ────────────────────────
-- Returns employees with < 100% allocated in the given week,
-- showing how much capacity they have left. Used for staffing
-- the "available bench" picker when creating a resource_request.

CREATE OR REPLACE FUNCTION fn_available_capacity(
  p_week        DATE,
  p_sub_team    TEXT DEFAULT NULL,    -- optional filter
  p_grade       TEXT DEFAULT NULL,
  p_min_pct     NUMERIC DEFAULT 25    -- min available % to include
)
RETURNS TABLE (
  employee_id    UUID,
  employee_code  TEXT,
  employee_name  TEXT,
  grade          TEXT,
  sub_team       TEXT,
  location       TEXT,
  allocated_pct  NUMERIC,
  available_pct  NUMERIC
)
LANGUAGE sql STABLE AS $$
  WITH weekly_load AS (
    SELECT
      fa.employee_id,
      COALESCE(SUM(fa.allocation_pct) FILTER (
        WHERE fa.allocation_status IN ('confirmed', 'proposed')
      ), 0) AS allocated
    FROM forecast_allocations fa
    WHERE fa.week_start = p_week
    GROUP BY fa.employee_id
  )
  SELECT
    e.id          AS employee_id,
    e.employee_id AS employee_code,
    e.name        AS employee_name,
    des.name      AS grade,
    sf.name       AS sub_team,
    l.name        AS location,
    COALESCE(wl.allocated, 0) AS allocated_pct,
    100 - COALESCE(wl.allocated, 0) AS available_pct
  FROM employees e
  LEFT JOIN weekly_load wl ON wl.employee_id = e.id
  LEFT JOIN designations des ON des.id = e.designation_id
  LEFT JOIN sub_functions sf ON sf.id = e.sub_function_id
  LEFT JOIN locations l ON l.id = e.location_id
  WHERE e.is_active = true
    AND (100 - COALESCE(wl.allocated, 0)) >= p_min_pct
    AND (p_sub_team IS NULL OR sf.name = p_sub_team)
    AND (p_grade IS NULL OR des.name = p_grade)
  ORDER BY available_pct DESC, e.name;
$$;

-- ─── 4. Project headcount over time ──────────────────────────
-- Used by the project detail page timeline chart.

CREATE OR REPLACE FUNCTION fn_project_headcount_timeline(
  p_project_id UUID,
  p_from       DATE,
  p_to         DATE
)
RETURNS TABLE (
  week_start    DATE,
  headcount     INT,
  total_pct     NUMERIC,
  fte_equivalent NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    fa.week_start,
    COUNT(DISTINCT fa.employee_id)::int AS headcount,
    SUM(fa.allocation_pct) AS total_pct,
    ROUND(SUM(fa.allocation_pct) / 100.0, 2) AS fte_equivalent
  FROM forecast_allocations fa
  WHERE fa.project_id = p_project_id
    AND fa.week_start BETWEEN p_from AND p_to
    AND fa.allocation_status IN ('confirmed', 'proposed')
  GROUP BY fa.week_start
  ORDER BY fa.week_start;
$$;
