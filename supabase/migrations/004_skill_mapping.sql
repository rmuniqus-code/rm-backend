-- ============================================================
-- Migration 004 — Skill Mapping (ARC / GRC)
-- ============================================================
-- Adds:
--   skills               — normalised skill dimension (8 skills)
--   employee_skills      — one row per employee × skill
--   employee_sectors     — one row per employee × sector
--   sectors              — normalised primary-sector dimension (9 values)
-- Updates:
--   employees            — adds primary_sector_id FK
-- ============================================================

-- ─── 1. SKILLS DIMENSION ────────────────────────────────────
-- 8 canonical skills used in ARC/GRC skillmapping file.
-- "Not Applicable" entries in the source are dropped at parse time.

CREATE TABLE skills (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL UNIQUE,      -- display name as-is from source
  slug       TEXT NOT NULL UNIQUE,      -- url-safe identifier
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO skills (name, slug) VALUES
  ('Auditing/ Accounting Support',          'auditing_accounting'),
  ('ERM/ Policies & Procedures/ others',    'erm_policies'),
  ('Finance transformation',                'finance_transformation'),
  ('Financial Risk Management',             'financial_risk_mgmt'),
  ('IPO',                                   'ipo'),
  ('SOX/ ICOFR',                            'sox_icofr'),
  ('Technical Accounting- IFRS/ IND AS',    'ta_ifrs_ind_as'),
  ('Technical Accounting- US GAAP',         'ta_us_gaap');

-- ─── 2. EMPLOYEE_SKILLS JUNCTION ────────────────────────────
-- One row per employee × skill.
-- UNIQUE (employee_id, skill_id) — no duplicate skill per employee.
--
-- skill_type : 'primary' | 'secondary'
--   primary   = employee's declared primary skillset (exactly 1 per employee)
--   secondary = any skill from secondary OR tertiary tiers, deduplicated,
--               primary skill excluded from this bucket
--
-- skill_order : relative rank within the skill_type bucket
--   primary   → always 1
--   secondary → 1 = first secondary, 2 = second secondary …
--               tertiary-only entries continue the sequence after secondary ones
--               Lower order = stronger signal

CREATE TABLE employee_skills (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  skill_id    UUID NOT NULL REFERENCES skills(id)    ON DELETE CASCADE,
  skill_type  TEXT NOT NULL CHECK (skill_type IN ('primary', 'secondary')),
  skill_order SMALLINT NOT NULL DEFAULT 1,           -- rank within type bucket
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, skill_id)
);

-- ─── 3. SECTORS DIMENSION ───────────────────────────────────

CREATE TABLE sectors (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO sectors (name) VALUES
  ('Consumer Goods'),
  ('Energy'),
  ('Financial Services'),
  ('Healthcare'),
  ('Infrastructure'),
  ('IT/ ITES'),
  ('Manufacturing'),
  ('Real Estate'),
  ('Telecom');

-- ─── 4. PRIMARY SECTOR ON EMPLOYEES ────────────────────────
-- Nullable FK — only populated for ARC/GRC employees in the skillmap.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS primary_sector_id UUID REFERENCES sectors(id);

-- ─── 5. EMPLOYEE_SECTORS — secondary sectors ────────────────
-- Free-text secondary sectors (normalised where possible, raw otherwise).

CREATE TABLE employee_sectors (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  sector_id   UUID REFERENCES sectors(id),           -- NULL if not in dimension
  raw_name    TEXT NOT NULL,                          -- original value from source
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, raw_name)
);

-- ─── 6. INDEXES ─────────────────────────────────────────────

CREATE INDEX idx_emp_skills_employee   ON employee_skills(employee_id);
CREATE INDEX idx_emp_skills_skill      ON employee_skills(skill_id);
CREATE INDEX idx_emp_skills_type       ON employee_skills(skill_type);
CREATE INDEX idx_emp_skills_emp_type   ON employee_skills(employee_id, skill_type);
-- Enables "find all primary-skill=X employees" fast
CREATE INDEX idx_emp_skills_skill_type ON employee_skills(skill_id, skill_type);

CREATE INDEX idx_emp_sectors_employee  ON employee_sectors(employee_id);
CREATE INDEX idx_emp_sectors_sector    ON employee_sectors(sector_id);

CREATE INDEX idx_employees_primary_sector ON employees(primary_sector_id);

-- ─── 7. VIEWS ───────────────────────────────────────────────

-- Flat employee view with primary skill + all secondary skills as array
CREATE OR REPLACE VIEW v_employee_skills AS
SELECT
  e.employee_id         AS emp_code,
  e.name                AS employee_name,
  e.email,
  s_primary.name        AS primary_skill,
  ARRAY_AGG(
    s_sec.name ORDER BY es_sec.skill_order
  ) FILTER (WHERE es_sec.skill_type = 'secondary')
                        AS secondary_skills,
  sec.name              AS primary_sector
FROM employees e
LEFT JOIN employee_skills es_pri
       ON es_pri.employee_id = e.id AND es_pri.skill_type = 'primary'
LEFT JOIN skills s_primary ON s_primary.id = es_pri.skill_id
LEFT JOIN employee_skills es_sec
       ON es_sec.employee_id = e.id AND es_sec.skill_type = 'secondary'
LEFT JOIN skills s_sec      ON s_sec.id = es_sec.skill_id
LEFT JOIN sectors sec       ON sec.id = e.primary_sector_id
GROUP BY e.id, e.employee_id, e.name, e.email,
         s_primary.name, sec.name;

-- Skill roster: employees per skill broken down by type (for matching page)
CREATE OR REPLACE VIEW v_skill_roster AS
SELECT
  sk.name               AS skill_name,
  sk.slug               AS skill_slug,
  es.skill_type,
  e.employee_id         AS emp_code,
  e.name                AS employee_name,
  e.email,
  es.skill_order
FROM employee_skills es
JOIN skills   sk ON sk.id = es.skill_id
JOIN employees e  ON e.id  = es.employee_id
WHERE e.is_active = true;

-- ─── 8. RLS ─────────────────────────────────────────────────

ALTER TABLE skills           ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_skills  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sectors          ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_sectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_skills"
  ON skills FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_employee_skills"
  ON employee_skills FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_sectors"
  ON sectors FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_employee_sectors"
  ON employee_sectors FOR SELECT TO authenticated USING (true);

-- ─── 9. GRANTS ──────────────────────────────────────────────

GRANT ALL ON skills, employee_skills, sectors, employee_sectors TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON skills, employee_skills, sectors, employee_sectors TO authenticated;
GRANT SELECT ON skills, employee_skills, sectors, employee_sectors TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role, authenticated;
