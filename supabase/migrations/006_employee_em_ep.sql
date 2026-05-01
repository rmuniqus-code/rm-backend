-- Migration 006: Store per-employee current EM/EP
-- The "Current EM/EP" column in the forecast sheet is a per-employee attribute
-- (who manages that employee), not a project-level attribute. Previously it was
-- only used to seed projects.engagement_manager, causing all team members on a
-- project to show the same EM/EP. This migration stores it per-employee so the
-- Team Breakdown modal can display each person's actual manager.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS current_em_ep TEXT;

-- Rebuild the allocation grid view to expose the per-employee current_em_ep.
-- DROP + CREATE is required because CREATE OR REPLACE cannot change column
-- order or types on an existing view.
DROP VIEW IF EXISTS v_resource_allocation_grid;
CREATE VIEW v_resource_allocation_grid AS
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
  fa.raw_text,
  e.current_em_ep
FROM forecast_allocations fa
JOIN employees e ON e.id = fa.employee_id
LEFT JOIN projects p ON p.id = fa.project_id
LEFT JOIN designations des ON des.id = e.designation_id
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN sub_functions sf ON sf.id = e.sub_function_id
LEFT JOIN locations l ON l.id = e.location_id;
