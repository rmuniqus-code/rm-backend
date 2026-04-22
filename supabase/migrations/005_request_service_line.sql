-- ============================================================
-- 005: Add service_line and sub_service_line to resource_requests
-- ============================================================

ALTER TABLE resource_requests
  ADD COLUMN IF NOT EXISTS service_line     TEXT,
  ADD COLUMN IF NOT EXISTS sub_service_line TEXT;
