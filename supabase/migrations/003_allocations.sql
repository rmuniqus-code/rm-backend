-- ============================================================
-- Migration 003 — allocations table + view update
-- ============================================================

-- 1. Drop and recreate cleanly (CASCADE removes any dependent views)
DROP TABLE IF EXISTS public.allocations CASCADE;

CREATE TABLE public.allocations (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id           UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  type                  TEXT        NOT NULL,   -- leave, available, jip, maternity, leaver, confirmed, proposed
  start_date            DATE        NOT NULL,   -- first Monday of range
  end_date              DATE        NOT NULL,   -- last  Monday of range
  allocation_percentage INT         NOT NULL DEFAULT 100,
  source_file           TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT allocations_dates_ok CHECK (end_date >= start_date),
  -- Named UNIQUE constraint (required for PostgREST onConflict upsert)
  CONSTRAINT allocations_uniq UNIQUE (employee_id, type, start_date)
);

CREATE INDEX idx_allocations_emp   ON public.allocations(employee_id);
CREATE INDEX idx_allocations_range ON public.allocations(start_date, end_date);

-- 2. RLS + policies
ALTER TABLE public.allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_allocations"
  ON public.allocations FOR SELECT TO authenticated USING (true);

-- service_role bypasses RLS by default — no policy needed for ingestion
GRANT ALL                              ON public.allocations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.allocations TO authenticated;
GRANT SELECT                           ON public.allocations TO anon;

-- 3. Recreate v_resource_allocation_grid
--    Drop explicitly — CASCADE on the table only removes views that depend on
--    allocations; the existing view may still reference only forecast_allocations.
DROP VIEW IF EXISTS public.v_resource_allocation_grid;
CREATE OR REPLACE VIEW public.v_resource_allocation_grid AS

-- Existing: per-week forecast allocations (project assignments only).
-- Non-project status rows (available, leave, jip, etc.) are stored in
-- the allocations table and expanded below — exclude them here to
-- prevent duplicates.
SELECT
  e.employee_id    AS emp_code,
  e.name           AS employee_name,
  des.name         AS designation,
  d.name           AS department,
  sf.name          AS sub_function,
  l.name           AS location,
  e.work_mode,
  e.ft_core,
  fa.week_start,
  fa.allocation_pct,
  fa.allocation_status,
  p.name           AS project_name,
  p.client         AS project_client,
  p.engagement_manager,
  p.engagement_partner,
  p.project_type,
  fa.raw_text
FROM public.forecast_allocations fa
JOIN      public.employees      e   ON e.id   = fa.employee_id
LEFT JOIN public.projects       p   ON p.id   = fa.project_id
LEFT JOIN public.designations   des ON des.id = e.designation_id
LEFT JOIN public.departments    d   ON d.id   = e.department_id
LEFT JOIN public.sub_functions  sf  ON sf.id  = e.sub_function_id
LEFT JOIN public.locations      l   ON l.id   = e.location_id

UNION ALL

-- New: date-range allocations expanded to weekly Monday rows via generate_series
SELECT
  e.employee_id                   AS emp_code,
  e.name                          AS employee_name,
  des.name                        AS designation,
  d.name                          AS department,
  sf.name                         AS sub_function,
  l.name                          AS location,
  e.work_mode,
  e.ft_core,
  gs.week_start::date             AS week_start,
  a.allocation_percentage         AS allocation_pct,
  a.type                          AS allocation_status,
  NULL::text                      AS project_name,
  NULL::text                      AS project_client,
  NULL::text                      AS engagement_manager,
  NULL::text                      AS engagement_partner,
  NULL::text                      AS project_type,
  NULL::text                      AS raw_text
FROM public.allocations     a
JOIN      public.employees      e   ON e.id   = a.employee_id
LEFT JOIN public.designations   des ON des.id = e.designation_id
LEFT JOIN public.departments    d   ON d.id   = e.department_id
LEFT JOIN public.sub_functions  sf  ON sf.id  = e.sub_function_id
LEFT JOIN public.locations      l   ON l.id   = e.location_id
-- Expand each range to every Monday from start_date through end_date
CROSS JOIN LATERAL (
  SELECT gs_date::date AS week_start
  FROM generate_series(
    -- First Monday on or after start_date
    -- PostgreSQL DOW: Sun=0, Mon=1 … Sat=6
    a.start_date + ((1 - EXTRACT(DOW FROM a.start_date)::int + 7) % 7) * INTERVAL '1 day',
    a.end_date,
    INTERVAL '7 days'
  ) AS gs_date
  WHERE gs_date::date <= a.end_date
) AS gs;

-- 4. Reload PostgREST schema cache so the new table is immediately visible
NOTIFY pgrst, 'reload schema';
