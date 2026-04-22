/**
 * Service-role Supabase client. Bypasses RLS.
 * Singleton — reuses the same client across requests.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}

// Alias for the legacy name used throughout ingestion code.
export const getSupabase = supabaseAdmin
