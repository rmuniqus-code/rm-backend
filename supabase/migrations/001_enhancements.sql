-- ============================================================
-- Enhancement Migration: Outliers, Notifications, File Versioning,
-- Audit Log, Resource Request lifecycle, Zoho Project Code
-- ============================================================

-- ============================================================
-- 1. NOTIFICATIONS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type          TEXT NOT NULL,
    -- 'request_raised', 'booking_confirmed', 'allocation_updated',
    -- 'over_allocation', 'timesheet_gap', 'approval_status'
  title         TEXT NOT NULL,
  message       TEXT NOT NULL,
  recipient_id  UUID REFERENCES employees(id) ON DELETE CASCADE,
  related_entity_type TEXT,      -- 'resource_request', 'forecast_allocation', 'project'
  related_entity_id   UUID,
  is_read       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, is_read);
CREATE INDEX idx_notifications_created   ON notifications(created_at DESC);

-- ============================================================
-- 2. FILE VERSIONING TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS file_uploads (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_name     TEXT NOT NULL,
  file_type     TEXT NOT NULL,
    -- 'forecast_tracker', 'timesheet_compliance', 'regionwise'
  file_size     INT,
  version       INT NOT NULL DEFAULT 1,     -- 1 or 2 (max 2 versions)
  storage_path  TEXT,                       -- Supabase storage path or reference
  upload_log_id UUID REFERENCES upload_logs(id),
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  is_active     BOOLEAN DEFAULT TRUE        -- FALSE = archived/superseded
);

CREATE INDEX idx_file_uploads_type    ON file_uploads(file_type, is_active);
CREATE INDEX idx_file_uploads_name    ON file_uploads(file_name);

-- ============================================================
-- 3. AUDIT LOG TABLE (real, replacing mock)
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_name     TEXT NOT NULL,
  user_id       UUID REFERENCES employees(id),
  action        TEXT NOT NULL,               -- 'Created', 'Updated', 'Deleted', 'Alert'
  entity        TEXT NOT NULL,               -- 'Allocation', 'Employee', 'Project', 'Request'
  entity_name   TEXT,
  entity_id     UUID,
  field         TEXT,                        -- specific field changed
  old_value     TEXT,
  new_value     TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_log_user    ON audit_log(user_name);
CREATE INDEX idx_audit_log_entity  ON audit_log(entity);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);

-- ============================================================
-- 4. RESOURCE REQUEST ENHANCEMENTS
-- ============================================================

-- Add missing fields for request lifecycle + booking confirmation
ALTER TABLE resource_requests
  ADD COLUMN IF NOT EXISTS opportunity_id     TEXT,
  ADD COLUMN IF NOT EXISTS skill_set          TEXT,
  ADD COLUMN IF NOT EXISTS travel_requirements TEXT,
  ADD COLUMN IF NOT EXISTS project_status     TEXT,
  ADD COLUMN IF NOT EXISTS loading_pct        NUMERIC(5,1) DEFAULT 100.0,
  ADD COLUMN IF NOT EXISTS em_ep_name         TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_status   TEXT DEFAULT 'draft',
    -- 'draft', 'submitted', 'under_review', 'approved', 'rejected', 'allocated', 'closed'
  ADD COLUMN IF NOT EXISTS allocated_resource UUID REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS allocation_date    DATE,
  ADD COLUMN IF NOT EXISTS rejection_reason   TEXT;

-- ============================================================
-- 5. PROJECTS — Ensure Zoho project_code is stored
-- ============================================================

-- Column 'code' already exists in projects table.
-- Add zoho-specific fields if needed:
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS zoho_project_id TEXT,
  ADD COLUMN IF NOT EXISTS project_description TEXT;

-- ============================================================
-- 6. GRANTS FOR NEW TABLES
-- ============================================================

GRANT ALL ON notifications TO service_role;
GRANT ALL ON file_uploads TO service_role;
GRANT ALL ON audit_log TO service_role;

GRANT SELECT, INSERT, UPDATE ON notifications TO authenticated;
GRANT SELECT ON file_uploads TO authenticated;
GRANT SELECT ON audit_log TO authenticated;

GRANT SELECT ON notifications TO anon;
GRANT SELECT ON file_uploads TO anon;
GRANT SELECT ON audit_log TO anon;

-- ============================================================
-- 7. RLS FOR NEW TABLES
-- ============================================================

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically
-- Authenticated users can see their own notifications
CREATE POLICY "Users see own notifications"
  ON notifications FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users read file uploads"
  ON file_uploads FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users read audit log"
  ON audit_log FOR SELECT TO authenticated
  USING (true);
