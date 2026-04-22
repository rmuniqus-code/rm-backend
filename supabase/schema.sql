-- ============================================================
-- Resource Management Platform — Supabase (Postgres) Schema
-- ============================================================
-- Covers:
--   1. Employee Timesheet Compliance (existing)
--   2. Forecast Tracker — weekly resource allocation (NEW)
--   3. Project & utilization views for dashboard pages
-- ============================================================

-- 0. Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. LOOKUP / DIMENSION TABLES
-- ============================================================

-- Departments (ARC, GRC, SCC, Tech Consulting, Central)
CREATE TABLE departments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Sub-functions / sub-teams (ARC-A, ARC-FT, ARC-FS, GRC, etc.)
CREATE TABLE sub_functions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (department_id, name)
);

-- Regions (India, UAE, USA, KSA)
CREATE TABLE regions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Locations (Mumbai, Gurugram, Dubai, etc.)
CREATE TABLE locations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  region_id   UUID REFERENCES regions(id),
  name        TEXT NOT NULL UNIQUE,
  country     TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Designations / grades
CREATE TABLE designations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL UNIQUE,
  category    TEXT,                       -- 'AM & Below', 'AD & Manager'
  rank_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 2. EMPLOYEES TABLE
-- ============================================================

CREATE TABLE employees (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id     TEXT NOT NULL UNIQUE,      -- '10006', '10025'
  name            TEXT NOT NULL,
  email           TEXT,                      -- user@uniqus.com
  designation_id  UUID REFERENCES designations(id),
  department_id   UUID REFERENCES departments(id),
  sub_function_id UUID REFERENCES sub_functions(id),
  location_id     UUID REFERENCES locations(id),
  employee_region TEXT,                      -- 'India', 'ME', 'USA'
  work_mode       TEXT,                      -- 'Onsite', 'Remote', 'Secondment'
  ft_core         TEXT,                      -- 'Core', 'Non-core', 'Accredited'
  rocketlane_status TEXT,                    -- 'Yes M', 'Yes A', 'NA on RL', etc.
  date_of_joining DATE,
  date_of_exit    DATE,
  is_active       BOOLEAN GENERATED ALWAYS AS (date_of_exit IS NULL) STORED,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 3. TIMESHEET COMPLIANCE (per-period records)
-- ============================================================
-- Each row = 1 employee x 1 reporting period (month)
-- Source: Employee_Timesheet_Compliance + Regionwise View sheets

CREATE TABLE timesheet_compliance (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id      UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_month     TEXT NOT NULL,
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  holidays_days    NUMERIC(5,1) DEFAULT 0,
  leaves_days      NUMERIC(5,1) DEFAULT 0,
  available_hours  NUMERIC(7,1) DEFAULT 0,
  chargeable_hours NUMERIC(7,1) DEFAULT 0,
  non_chargeable_hours NUMERIC(7,1) DEFAULT 0,
  total_hours      NUMERIC(7,1) DEFAULT 0,
  chargeability_pct NUMERIC(5,3) DEFAULT 0,
  compliance_pct   NUMERIC(5,3) DEFAULT 0,
  category         TEXT,
  source_file      TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),

  UNIQUE (employee_id, period_start, period_end)
);

-- ============================================================
-- 4. PROJECTS TABLE
-- ============================================================

CREATE TABLE projects (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code                 TEXT UNIQUE,
  name                 TEXT NOT NULL,
  client               TEXT,
  engagement_manager   TEXT,                -- EM name from forecast tracker
  engagement_partner   TEXT,                -- EP name from forecast tracker
  project_type         TEXT DEFAULT 'chargeable',
    -- 'chargeable', 'non_chargeable', 'internal', 'training'
  status               TEXT DEFAULT 'active',
    -- 'active', 'completed', 'on_hold'
  sub_team             TEXT,                -- owning sub-team (ARC-A, GRC, etc.)
  start_date           DATE,
  end_date             DATE,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 5. FORECAST ALLOCATIONS (weekly resource plan)
-- ============================================================
-- Each row = 1 employee x 1 week x 1 project allocation
-- Source: Forecast Tracker Excel — weekly columns
-- Supports split allocations (e.g. 50% Project A / 50% Project B)

CREATE TABLE forecast_allocations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id       UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  project_id        UUID REFERENCES projects(id) ON DELETE SET NULL,
    -- NULL for non-project statuses (Available, Leave, JIP)
  week_start        DATE NOT NULL,          -- Monday of the week
  allocation_pct    NUMERIC(5,1) DEFAULT 100.0,
  allocation_status TEXT NOT NULL DEFAULT 'confirmed',
    -- 'confirmed'   — firm booking on a project
    -- 'proposed'    — proposed but not confirmed
    -- 'available'   — bench / unallocated
    -- 'leave'       — on leave
    -- 'jip'         — just in probation
    -- 'maternity'   — maternity leave
    -- 'unconfirmed' — allocation expected but not finalized
    -- 'leaver'      — employee exiting
  raw_text          TEXT,                   -- original cell text from Excel
  source_file       TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- On re-import we delete+reinsert per employee per week range,
-- so no strict unique constraint. This index speeds up the upsert lookup.
CREATE UNIQUE INDEX idx_forecast_alloc_unique
  ON forecast_allocations(employee_id, week_start, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ============================================================
-- 6. UTILIZATION SNAPSHOTS (MTD / YTD point-in-time metrics)
-- ============================================================
-- Source: Forecast Tracker columns MTD, YTD, weekly utilization

CREATE TABLE utilization_snapshots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  snapshot_date   DATE NOT NULL,            -- date the snapshot was taken
  mtd_utilization NUMERIC(5,3),             -- 0.000 to 1.000+
  wtd_utilization NUMERIC(5,3),             -- week-to-date (WC column)
  ytd_utilization NUMERIC(5,3),             -- year-to-date
  comments        TEXT,                     -- 'Available', 'Leaves', 'BD work', etc.
  source_file     TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE (employee_id, snapshot_date)
);

-- ============================================================
-- 7. RESOURCE REQUESTS TABLE
-- ============================================================

CREATE TABLE resource_requests (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_number     SERIAL,
  project_id         UUID REFERENCES projects(id),
  resource_requested TEXT,
  request_type       TEXT,                -- 'New Staff', 'Extension', etc.
  booking_type       TEXT DEFAULT 'tentative',
  approval_status    TEXT DEFAULT 'pending',
  requested_by       UUID REFERENCES employees(id),
  approved_by        UUID REFERENCES employees(id),
  start_date         DATE,
  end_date           DATE,
  hours_per_day      NUMERIC(4,1),
  total_hours        NUMERIC(7,1),
  role_needed        TEXT,
  grade_needed       TEXT,
  primary_skill      TEXT,
  notes              TEXT,
  service_line       TEXT,
  sub_service_line   TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 8. UPLOAD LOG (audit trail for file imports)
-- ============================================================

CREATE TABLE upload_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_name     TEXT NOT NULL,
  file_type     TEXT NOT NULL,
    -- 'timesheet_compliance', 'regionwise', 'forecast_tracker'
  uploaded_by   UUID REFERENCES employees(id),
  row_count     INT DEFAULT 0,
  success_count INT DEFAULT 0,
  error_count   INT DEFAULT 0,
  errors        JSONB DEFAULT '[]',
  status        TEXT DEFAULT 'processing',
  created_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

-- ============================================================
-- 9. INDEXES
-- ============================================================

-- Employees
CREATE INDEX idx_employees_department    ON employees(department_id);
CREATE INDEX idx_employees_location      ON employees(location_id);
CREATE INDEX idx_employees_sub_function  ON employees(sub_function_id);
CREATE INDEX idx_employees_active        ON employees(is_active);
CREATE INDEX idx_employees_emp_id        ON employees(employee_id);

-- Timesheet Compliance
CREATE INDEX idx_compliance_employee     ON timesheet_compliance(employee_id);
CREATE INDEX idx_compliance_period       ON timesheet_compliance(period_start, period_end);
CREATE INDEX idx_compliance_month        ON timesheet_compliance(period_month);
CREATE INDEX idx_compliance_category     ON timesheet_compliance(category);

-- Forecast Allocations
CREATE INDEX idx_forecast_employee       ON forecast_allocations(employee_id);
CREATE INDEX idx_forecast_project        ON forecast_allocations(project_id);
CREATE INDEX idx_forecast_week           ON forecast_allocations(week_start);
CREATE INDEX idx_forecast_status         ON forecast_allocations(allocation_status);
CREATE INDEX idx_forecast_emp_week       ON forecast_allocations(employee_id, week_start);

-- Utilization Snapshots
CREATE INDEX idx_utilization_employee    ON utilization_snapshots(employee_id);
CREATE INDEX idx_utilization_date        ON utilization_snapshots(snapshot_date);

-- Projects
CREATE INDEX idx_projects_type           ON projects(project_type);
CREATE INDEX idx_projects_status         ON projects(status);
CREATE INDEX idx_projects_sub_team       ON projects(sub_team);

-- Resource Requests
CREATE INDEX idx_requests_status         ON resource_requests(approval_status);
CREATE INDEX idx_requests_project        ON resource_requests(project_id);

-- Upload Logs
CREATE INDEX idx_uploads_type            ON upload_logs(file_type);
CREATE INDEX idx_uploads_status          ON upload_logs(status);

-- ============================================================
-- 10. VIEWS — COMPLIANCE DASHBOARD
-- ============================================================

-- Chargeability summary by department + period
CREATE OR REPLACE VIEW v_chargeability_by_dept AS
SELECT
  d.name AS department,
  tc.period_month,
  COUNT(DISTINCT tc.employee_id) AS headcount,
  ROUND(AVG(tc.chargeability_pct) * 100, 1) AS avg_chargeability,
  ROUND(AVG(tc.compliance_pct) * 100, 1) AS avg_compliance,
  SUM(tc.chargeable_hours) AS total_chargeable,
  SUM(tc.available_hours) AS total_available
FROM timesheet_compliance tc
JOIN employees e ON e.id = tc.employee_id
JOIN departments d ON d.id = e.department_id
GROUP BY d.name, tc.period_month;

-- Chargeability by region
CREATE OR REPLACE VIEW v_chargeability_by_region AS
SELECT
  r.name AS region,
  tc.period_month,
  COUNT(DISTINCT tc.employee_id) AS headcount,
  ROUND(AVG(tc.chargeability_pct) * 100, 1) AS avg_chargeability,
  ROUND(AVG(tc.compliance_pct) * 100, 1) AS avg_compliance,
  tc.category
FROM timesheet_compliance tc
JOIN employees e ON e.id = tc.employee_id
JOIN locations l ON l.id = e.location_id
JOIN regions r ON r.id = l.region_id
GROUP BY r.name, tc.period_month, tc.category;

-- Employee detail view (flattened)
CREATE OR REPLACE VIEW v_employee_details AS
SELECT
  e.employee_id AS emp_code,
  e.name,
  e.email,
  des.name AS designation,
  des.category,
  d.name AS department,
  sf.name AS sub_function,
  l.name AS location,
  r.name AS region,
  e.employee_region,
  e.work_mode,
  e.ft_core,
  e.rocketlane_status,
  e.date_of_joining,
  e.date_of_exit,
  e.is_active
FROM employees e
LEFT JOIN designations des ON des.id = e.designation_id
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN sub_functions sf ON sf.id = e.sub_function_id
LEFT JOIN locations l ON l.id = e.location_id
LEFT JOIN regions r ON r.id = l.region_id;

-- Compliance overview (for dashboard KPI cards)
CREATE OR REPLACE VIEW v_compliance_overview AS
SELECT
  tc.period_month,
  COUNT(DISTINCT tc.employee_id) AS total_employees,
  ROUND(AVG(tc.chargeability_pct) * 100, 1) AS avg_chargeability,
  ROUND(AVG(tc.compliance_pct) * 100, 1) AS avg_compliance,
  SUM(tc.available_hours) AS total_available_hours,
  SUM(tc.chargeable_hours) AS total_chargeable_hours,
  SUM(tc.total_hours) AS total_logged_hours,
  COUNT(*) FILTER (WHERE tc.compliance_pct < 0.8) AS low_compliance_count,
  COUNT(*) FILTER (WHERE tc.total_hours = 0) AS zero_hours_count
FROM timesheet_compliance tc
GROUP BY tc.period_month;

-- ============================================================
-- 11. VIEWS — RESOURCE ALLOCATION PAGE
-- ============================================================

-- Weekly allocation grid: one row per employee per week with allocation details
CREATE OR REPLACE VIEW v_resource_allocation_grid AS
SELECT
  e.employee_id AS emp_code,
  e.name AS employee_name,
  des.name AS designation,
  d.name AS department,
  sf.name AS sub_function,
  l.name AS location,
  e.work_mode,
  e.ft_core,
  fa.week_start,
  fa.allocation_pct,
  fa.allocation_status,
  p.name AS project_name,
  p.client AS project_client,
  p.engagement_manager,
  p.engagement_partner,
  p.project_type,
  fa.raw_text
FROM forecast_allocations fa
JOIN employees e ON e.id = fa.employee_id
LEFT JOIN projects p ON p.id = fa.project_id
LEFT JOIN designations des ON des.id = e.designation_id
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN sub_functions sf ON sf.id = e.sub_function_id
LEFT JOIN locations l ON l.id = e.location_id;

-- Bench / available resources for a given week
CREATE OR REPLACE VIEW v_available_resources AS
SELECT
  e.employee_id AS emp_code,
  e.name AS employee_name,
  des.name AS designation,
  sf.name AS sub_function,
  l.name AS location,
  fa.week_start,
  fa.allocation_pct AS available_pct
FROM forecast_allocations fa
JOIN employees e ON e.id = fa.employee_id
LEFT JOIN designations des ON des.id = e.designation_id
LEFT JOIN sub_functions sf ON sf.id = e.sub_function_id
LEFT JOIN locations l ON l.id = e.location_id
WHERE fa.allocation_status = 'available'
  AND e.is_active = true;

-- ============================================================
-- 12. VIEWS — PROJECT PAGE
-- ============================================================

-- Project summary with team size and timeline derived from allocations
CREATE OR REPLACE VIEW v_project_summary AS
SELECT
  p.id AS project_id,
  p.code,
  p.name AS project_name,
  p.client,
  p.engagement_manager,
  p.engagement_partner,
  p.project_type,
  p.status,
  p.sub_team,
  MIN(fa.week_start) AS first_allocation_week,
  MAX(fa.week_start) AS last_allocation_week,
  COUNT(DISTINCT fa.employee_id) AS total_team_members,
  COUNT(DISTINCT fa.week_start) AS active_weeks
FROM projects p
LEFT JOIN forecast_allocations fa ON fa.project_id = p.id
  AND fa.allocation_status IN ('confirmed', 'proposed')
GROUP BY p.id, p.code, p.name, p.client, p.engagement_manager,
         p.engagement_partner, p.project_type, p.status, p.sub_team;

-- Project team detail: who is on a project each week
CREATE OR REPLACE VIEW v_project_team AS
SELECT
  p.id AS project_id,
  p.name AS project_name,
  p.client,
  e.employee_id AS emp_code,
  e.name AS employee_name,
  des.name AS designation,
  sf.name AS sub_function,
  fa.week_start,
  fa.allocation_pct,
  fa.allocation_status
FROM forecast_allocations fa
JOIN projects p ON p.id = fa.project_id
JOIN employees e ON e.id = fa.employee_id
LEFT JOIN designations des ON des.id = e.designation_id
LEFT JOIN sub_functions sf ON sf.id = e.sub_function_id
WHERE fa.allocation_status IN ('confirmed', 'proposed');

-- Headcount per project per week (for timeline charts)
CREATE OR REPLACE VIEW v_project_headcount AS
SELECT
  p.id AS project_id,
  p.name AS project_name,
  fa.week_start,
  COUNT(DISTINCT fa.employee_id) AS headcount,
  SUM(fa.allocation_pct) AS total_allocation_pct
FROM forecast_allocations fa
JOIN projects p ON p.id = fa.project_id
WHERE fa.allocation_status IN ('confirmed', 'proposed')
GROUP BY p.id, p.name, fa.week_start;

-- ============================================================
-- 13. TABLE-LEVEL GRANTS
-- ============================================================
-- In Supabase, tables need explicit GRANTs for each role:
--   - service_role: full CRUD (bypasses RLS for ingestion pipeline)
--   - authenticated: SELECT + limited INSERT/UPDATE (enforced by RLS)
--   - anon: SELECT only (further locked by RLS — no policies = no access)
-- Without these, even service_role gets "permission denied" errors.
-- ============================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;

-- Ensure future tables also get proper grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon;

-- ============================================================
-- 14. ROW LEVEL SECURITY (RLS)
-- ============================================================
-- Strategy:
--   - Enable RLS on every table (Supabase requires this for safety)
--   - service_role (used by server-side ingestion) BYPASSES RLS by
--     default — so the upload pipeline, delete-and-replace logic,
--     and "only changes get logged" semantics keep working untouched
--   - authenticated role (signed-in frontend users) gets read-only
--     access to dashboard data + can write resource_requests
--   - anon role gets NO access by default (lock down public reads)
--
-- To tighten later (e.g. "managers see their team only"), modify the
-- USING clauses without rewriting the whole policy structure.
-- ============================================================

-- ─── Enable RLS on all tables ────────────────────────────────

ALTER TABLE departments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_functions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE regions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE designations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees              ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_compliance   ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects               ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_allocations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE utilization_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_logs            ENABLE ROW LEVEL SECURITY;

-- ─── READ POLICIES (authenticated users) ─────────────────────
-- Every signed-in user can read all dashboard data.
-- service_role bypasses these (used by ingestion pipeline).

CREATE POLICY "auth_read_departments"
  ON departments FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_sub_functions"
  ON sub_functions FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_regions"
  ON regions FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_locations"
  ON locations FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_designations"
  ON designations FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_employees"
  ON employees FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_timesheet_compliance"
  ON timesheet_compliance FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_projects"
  ON projects FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_forecast_allocations"
  ON forecast_allocations FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_utilization_snapshots"
  ON utilization_snapshots FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_resource_requests"
  ON resource_requests FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_upload_logs"
  ON upload_logs FOR SELECT TO authenticated USING (true);

-- ─── WRITE POLICIES (authenticated users) ────────────────────
-- Only resource_requests is user-writable from the frontend.
-- All other writes (allocations, employees, compliance, projects)
-- happen via the server-side ingestion pipeline using service_role,
-- which bypasses RLS — so re-imports and the delete-and-replace
-- carry-forward logic in ingest-forecast.ts continue to work.

CREATE POLICY "auth_insert_resource_requests"
  ON resource_requests FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "auth_update_own_resource_requests"
  ON resource_requests FOR UPDATE TO authenticated
  USING (requested_by IN (
    SELECT id FROM employees WHERE email = auth.jwt() ->> 'email'
  ))
  WITH CHECK (requested_by IN (
    SELECT id FROM employees WHERE email = auth.jwt() ->> 'email'
  ));

-- ─── ANON ROLE: explicit deny (no public access) ─────────────
-- We don't create any policies for the anon role, which means
-- (with RLS enabled) anonymous reads/writes are blocked by default.
-- If you ever need a public landing-page metric, add a narrow
-- policy on a single view rather than a base table.

-- ─── VIEWS RESPECT BASE TABLE RLS ────────────────────────────
-- The dashboard views (v_resource_allocation_grid, v_project_summary,
-- v_compliance_overview, etc.) are NOT separate RLS objects — they
-- inherit the policies of their underlying tables. So once a user
-- has SELECT on employees + forecast_allocations + projects, the
-- views work automatically.

-- ─── HOW TO TIGHTEN LATER ────────────────────────────────────
-- Example: only let employees see their own timesheet record:
--
--   DROP POLICY "auth_read_timesheet_compliance" ON timesheet_compliance;
--   CREATE POLICY "auth_read_own_timesheet"
--     ON timesheet_compliance FOR SELECT TO authenticated
--     USING (employee_id IN (
--       SELECT id FROM employees WHERE email = auth.jwt() ->> 'email'
--     ));
--
-- Example: only managers/admins can see all employees:
--
--   CREATE POLICY "managers_read_all_employees"
--     ON employees FOR SELECT TO authenticated
--     USING (
--       (auth.jwt() ->> 'role') IN ('manager', 'admin')
--       OR email = auth.jwt() ->> 'email'   -- self
--     );
