-- ============================================================
-- Outliers RPC: Single query that returns all outlier types
-- ============================================================
-- Combines:
--   1. Missed timesheet defaulters (zero hours / low compliance)
--   2. Analyst-to-Manager utilization below 75%
--   3. Associate Director utilization below 65%
--   4. Over-allocated employees (>100%)
-- ============================================================

CREATE OR REPLACE FUNCTION fn_outliers(
  p_from DATE DEFAULT CURRENT_DATE,
  p_to   DATE DEFAULT (CURRENT_DATE + INTERVAL '4 weeks')::DATE
)
RETURNS TABLE (
  employee_id      UUID,
  employee_code    TEXT,
  employee_name    TEXT,
  designation      TEXT,
  department       TEXT,
  location         TEXT,
  outlier_type     TEXT,
  metric_value     NUMERIC,
  threshold        NUMERIC,
  detail           TEXT,
  week_start       DATE
)
LANGUAGE sql STABLE AS $$

  -- 1. MISSED TIMESHEET: zero hours in latest compliance period
  SELECT
    e.id              AS employee_id,
    e.employee_id     AS employee_code,
    e.name            AS employee_name,
    des.name          AS designation,
    d.name            AS department,
    l.name            AS location,
    'missed_timesheet' AS outlier_type,
    tc.total_hours    AS metric_value,
    1.0               AS threshold,
    'Total hours = ' || COALESCE(tc.total_hours::TEXT, '0') ||
      ' for period ' || tc.period_month AS detail,
    NULL::DATE        AS week_start
  FROM timesheet_compliance tc
  JOIN employees e ON e.id = tc.employee_id
  LEFT JOIN designations des ON des.id = e.designation_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN locations l ON l.id = e.location_id
  WHERE tc.period_month = (
    SELECT MAX(period_month) FROM timesheet_compliance
  )
  AND tc.compliance_pct = 0
  AND e.is_active = true

  UNION ALL

  -- 2. LOW UTILIZATION: Analyst to Manager below 75%
  SELECT
    e.id              AS employee_id,
    e.employee_id     AS employee_code,
    e.name            AS employee_name,
    des.name          AS designation,
    d.name            AS department,
    l.name            AS location,
    'low_utilization_am' AS outlier_type,
    ROUND(COALESCE(SUM(fa.allocation_pct) FILTER (
      WHERE fa.allocation_status IN ('confirmed', 'proposed')
    ), 0), 1)        AS metric_value,
    75.0              AS threshold,
    des.name || ' with avg utilization ' ||
      ROUND(COALESCE(SUM(fa.allocation_pct) FILTER (
        WHERE fa.allocation_status IN ('confirmed', 'proposed')
      ), 0), 1) || '% (threshold: 75%)' AS detail,
    fa.week_start
  FROM forecast_allocations fa
  JOIN employees e ON e.id = fa.employee_id
  LEFT JOIN designations des ON des.id = e.designation_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN locations l ON l.id = e.location_id
  WHERE fa.week_start BETWEEN p_from AND p_to
    AND e.is_active = true
    AND LOWER(des.name) IN (
      'analyst', 'associate consultant', 'consultant',
      'assistant manager', 'manager'
    )
  GROUP BY e.id, e.employee_id, e.name, des.name, d.name, l.name, fa.week_start
  HAVING COALESCE(SUM(fa.allocation_pct) FILTER (
    WHERE fa.allocation_status IN ('confirmed', 'proposed')
  ), 0) < 75

  UNION ALL

  -- 3. LOW UTILIZATION: Associate Director below 65%
  SELECT
    e.id              AS employee_id,
    e.employee_id     AS employee_code,
    e.name            AS employee_name,
    des.name          AS designation,
    d.name            AS department,
    l.name            AS location,
    'low_utilization_ad' AS outlier_type,
    ROUND(COALESCE(SUM(fa.allocation_pct) FILTER (
      WHERE fa.allocation_status IN ('confirmed', 'proposed')
    ), 0), 1)        AS metric_value,
    65.0              AS threshold,
    'Associate Director with avg utilization ' ||
      ROUND(COALESCE(SUM(fa.allocation_pct) FILTER (
        WHERE fa.allocation_status IN ('confirmed', 'proposed')
      ), 0), 1) || '% (threshold: 65%)' AS detail,
    fa.week_start
  FROM forecast_allocations fa
  JOIN employees e ON e.id = fa.employee_id
  LEFT JOIN designations des ON des.id = e.designation_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN locations l ON l.id = e.location_id
  WHERE fa.week_start BETWEEN p_from AND p_to
    AND e.is_active = true
    AND LOWER(des.name) LIKE '%director%'
  GROUP BY e.id, e.employee_id, e.name, des.name, d.name, l.name, fa.week_start
  HAVING COALESCE(SUM(fa.allocation_pct) FILTER (
    WHERE fa.allocation_status IN ('confirmed', 'proposed')
  ), 0) < 65

  UNION ALL

  -- 4. OVER-ALLOCATED: >100% in any week
  SELECT
    e.id              AS employee_id,
    e.employee_id     AS employee_code,
    e.name            AS employee_name,
    des.name          AS designation,
    d.name            AS department,
    l.name            AS location,
    'over_allocated'  AS outlier_type,
    SUM(fa.allocation_pct) AS metric_value,
    100.0             AS threshold,
    e.name || ' is at ' || ROUND(SUM(fa.allocation_pct), 0) ||
      '% allocation across ' || COUNT(DISTINCT fa.project_id) ||
      ' project(s)' AS detail,
    fa.week_start
  FROM forecast_allocations fa
  JOIN employees e ON e.id = fa.employee_id
  LEFT JOIN designations des ON des.id = e.designation_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN locations l ON l.id = e.location_id
  WHERE fa.week_start BETWEEN p_from AND p_to
    AND fa.allocation_status IN ('confirmed', 'proposed')
    AND e.is_active = true
  GROUP BY e.id, e.employee_id, e.name, des.name, d.name, l.name, fa.week_start
  HAVING SUM(fa.allocation_pct) > 100

  ORDER BY outlier_type, employee_name;
$$;
