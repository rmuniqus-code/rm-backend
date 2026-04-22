/**
 * File Versioning Logic
 *
 * Strategy: Keep at most 2 versions per file_type.
 *   - On new upload: if 2 versions exist, archive (deactivate) the oldest
 *   - New file becomes version = max(existing) + 1
 *   - Retrieval: active version is the latest; previous version is retrievable
 *
 * Usage:
 *   const record = await trackFileUpload({
 *     fileName: 'Forecast_April.xlsx',
 *     fileType: 'forecast_tracker',
 *     fileSize: buffer.byteLength,
 *     uploadLogId: result.uploadId,
 *     uploadedBy: 'admin',
 *   })
 */

import { supabaseAdmin } from '../db/supabase-admin'

const MAX_VERSIONS = 2

interface TrackFileParams {
  fileName: string
  fileType: string
  fileSize: number
  uploadLogId?: string
  uploadedBy?: string
}

interface FileUploadRecord {
  id: string
  file_name: string
  file_type: string
  version: number
  is_active: boolean
  created_at: string
}

export async function trackFileUpload(params: TrackFileParams): Promise<FileUploadRecord | null> {
  const sb = supabaseAdmin()

  // 1. Get existing versions for this file type (ordered by version desc)
  const { data: existing } = await sb
    .from('file_uploads')
    .select('id, version, is_active')
    .eq('file_type', params.fileType)
    .order('version', { ascending: false })

  const versions = existing ?? []
  const nextVersion = versions.length > 0 ? versions[0].version + 1 : 1

  // 2. If we already have MAX_VERSIONS, deactivate the oldest
  if (versions.length >= MAX_VERSIONS) {
    const oldest = versions[versions.length - 1]
    await sb
      .from('file_uploads')
      .update({ is_active: false })
      .eq('id', oldest.id)
  }

  // 3. Also deactivate all currently active (new one becomes the active)
  if (versions.length > 0) {
    await sb
      .from('file_uploads')
      .update({ is_active: false })
      .eq('file_type', params.fileType)
      .eq('is_active', true)
  }

  // 4. Insert the new version as active
  const { data, error } = await sb
    .from('file_uploads')
    .insert({
      file_name:     params.fileName,
      file_type:     params.fileType,
      file_size:     params.fileSize,
      version:       nextVersion,
      upload_log_id: params.uploadLogId ?? null,
      uploaded_by:   params.uploadedBy ?? null,
      is_active:     true,
    })
    .select()
    .single()

  if (error) {
    console.error('[file-versioning] Insert error:', error)
    return null
  }

  // 5. Clean up: if more than MAX_VERSIONS total, delete the oldest inactive
  if (versions.length >= MAX_VERSIONS) {
    const { data: allVersions } = await sb
      .from('file_uploads')
      .select('id')
      .eq('file_type', params.fileType)
      .order('version', { ascending: false })

    if (allVersions && allVersions.length > MAX_VERSIONS) {
      const toDelete = allVersions.slice(MAX_VERSIONS).map(v => v.id)
      await sb
        .from('file_uploads')
        .delete()
        .in('id', toDelete)
    }
  }

  return data
}

/**
 * Get the previous (non-active) version of a file type.
 */
export async function getPreviousVersion(fileType: string): Promise<FileUploadRecord | null> {
  const { data } = await supabaseAdmin()
    .from('file_uploads')
    .select('*')
    .eq('file_type', fileType)
    .eq('is_active', false)
    .order('version', { ascending: false })
    .limit(1)
    .single()

  return data
}
