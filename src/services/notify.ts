/**
 * Server-side notification emitter.
 *
 * Call from other API routes to create notifications on key events:
 *   - Resource request raised
 *   - Booking confirmed (allocation created)
 *   - Allocation updated/changed
 *
 * Usage:
 *   import { emitNotification } from '@/lib/notify'
 *   await emitNotification({
 *     type: 'request_raised',
 *     title: 'New Resource Request',
 *     message: `Request for ${roleName} on ${projectName}`,
 *     recipientId: managerId,
 *     relatedEntityType: 'resource_request',
 *     relatedEntityId: requestId,
 *   })
 */

import { supabaseAdmin } from '../db/supabase-admin'

/**
 * Resolve the employees.id UUID for a Supabase auth user by their email.
 * Returns null if no matching employee record is found.
 */
export async function resolveEmployeeIdByEmail(email?: string | null): Promise<string | null> {
  if (!email) return null
  const { data } = await supabaseAdmin()
    .from('employees')
    .select('id')
    .ilike('email', email.trim())
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/**
 * Resolve the employees.id UUID by employee display name.
 * Returns null if no matching employee record is found.
 */
async function resolveEmployeeIdByName(name?: string | null): Promise<string | null> {
  if (!name) return null
  const { data } = await supabaseAdmin()
    .from('employees')
    .select('id')
    .ilike('name', name.trim())
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/** Structured payload stored in notifications.metadata for booking_confirmed cards. */
export interface AllocationNotificationMetadata {
  resourceName: string
  roleSkill: string | null
  startDate: string
  endDate: string
  loadingPct: number
  projectName: string
  projectCode: string | null
  emEpName: string | null
  projectDescription: string | null
}

interface NotificationPayload {
  type: string
  title: string
  message: string
  recipientId?: string | null
  relatedEntityType?: string | null
  relatedEntityId?: string | null
  metadata?: AllocationNotificationMetadata | null
}

export async function emitNotification(payload: NotificationPayload): Promise<void> {
  try {
    await supabaseAdmin()
      .from('notifications')
      .insert({
        type:                payload.type,
        title:               payload.title,
        message:             payload.message,
        recipient_id:        payload.recipientId ?? null,
        related_entity_type: payload.relatedEntityType ?? null,
        related_entity_id:   payload.relatedEntityId ?? null,
        metadata:            payload.metadata ?? null,
      })
  } catch (err) {
    // Don't let notification failures break the calling API
    console.error('[notify] Failed to emit notification:', err)
  }
}

/**
 * Emit notification when a resource request is raised.
 */
export async function notifyRequestRaised(
  requestId: string,
  projectName: string,
  roleName: string,
): Promise<void> {
  await emitNotification({
    type: 'request_raised',
    title: 'New Resource Request',
    message: `Request raised for ${roleName} on ${projectName}`,
    relatedEntityType: 'resource_request',
    relatedEntityId: requestId,
  })
}

/**
 * Emit notification when a booking is confirmed (allocation created).
 * Sends targeted notifications to:
 *   1. The resource (employee being allocated)
 *   2. The EM/EP (resolved by name from the employees table)
 *   3. The approving RM/admin (actor)
 * Each notification carries structured metadata for the allocation detail card.
 */
export async function notifyAllocationConfirmed(opts: {
  requestId: string
  resourceEmployeeId: string
  resourceName: string
  roleSkill: string | null
  startDate: string
  endDate: string
  loadingPct: number
  projectName: string
  projectCode: string | null
  emEpName: string | null
  projectDescription: string | null
  actorEmployeeId: string | null
}): Promise<void> {
  const metadata: AllocationNotificationMetadata = {
    resourceName:       opts.resourceName,
    roleSkill:          opts.roleSkill,
    startDate:          opts.startDate,
    endDate:            opts.endDate,
    loadingPct:         opts.loadingPct,
    projectName:        opts.projectName,
    projectCode:        opts.projectCode,
    emEpName:           opts.emEpName,
    projectDescription: opts.projectDescription,
  }

  const title   = 'Resource Booking Confirmed'
  const message = `${opts.resourceName} allocated to ${opts.projectName} (${opts.startDate} – ${opts.endDate})`

  const emitSafe = async (payload: NotificationPayload) => {
    try { await emitNotification(payload) } catch (err) {
      console.error('[notify] notifyAllocationConfirmed failed:', err)
    }
  }

  const base = {
    type:              'booking_confirmed',
    title,
    message,
    relatedEntityType: 'resource_request',
    relatedEntityId:   opts.requestId,
    metadata,
  }

  // Track which employee IDs have already been notified to avoid duplicates
  const notified = new Set<string>()

  // 1. Notify the resource
  await emitSafe({ ...base, recipientId: opts.resourceEmployeeId })
  notified.add(opts.resourceEmployeeId)

  // 2. Notify EM/EP — resolve by name
  const emEpEmployeeId = await resolveEmployeeIdByName(opts.emEpName)
  if (emEpEmployeeId && !notified.has(emEpEmployeeId)) {
    await emitSafe({ ...base, recipientId: emEpEmployeeId })
    notified.add(emEpEmployeeId)
  }

  // 3. Notify the approving RM/admin actor
  if (opts.actorEmployeeId && !notified.has(opts.actorEmployeeId)) {
    await emitSafe({ ...base, recipientId: opts.actorEmployeeId })
    notified.add(opts.actorEmployeeId)
  }
}

/**
 * Emit notification when an allocation is updated/changed.
 */
export async function notifyAllocationUpdated(
  employeeName: string,
  projectName: string,
  change: string,
): Promise<void> {
  await emitNotification({
    type: 'allocation_updated',
    title: 'Allocation Updated',
    message: `${employeeName}'s allocation on ${projectName}: ${change}`,
    relatedEntityType: 'forecast_allocation',
  })
}

/**
 * Send targeted notifications for an allocation action to:
 *  1. The resource (employee whose allocation changed) — always, when resourceEmployeeId is known.
 *  2. The actor (RM/admin who made the change) — only when their employee UUID is resolved and
 *     differs from the resource, so a person doesn't receive two identical notifications.
 *
 * Both notifications are fire-and-forget; failures are logged but do not abort the caller.
 */
export async function notifyAllocationAction(opts: {
  action: 'created' | 'updated' | 'deleted' | 'extended' | 'status_changed'
  employeeName: string | null
  projectName: string | null
  /** Human-readable description of what changed (e.g. "100% confirmed (week of 2026-05-04)") */
  change: string
  /** employees.id of the resource whose allocation was changed */
  resourceEmployeeId: string | null
  /** employees.id of the RM/admin who made the change — null if not resolvable */
  actorEmployeeId: string | null
  actorName: string
  relatedEntityId?: string | null
}): Promise<void> {
  const { action, employeeName, projectName, change, resourceEmployeeId, actorEmployeeId, actorName, relatedEntityId } = opts
  const resource = employeeName ?? 'Resource'
  const project  = projectName  ?? 'project'

  const actionTitles: Record<string, string> = {
    created:        'New Allocation',
    updated:        'Allocation Updated',
    deleted:        'Allocation Removed',
    extended:       'Allocation Extended',
    status_changed: 'Allocation Status Changed',
  }
  const title = actionTitles[action] ?? 'Allocation Changed'

  const emitSafe = async (payload: Parameters<typeof emitNotification>[0]) => {
    try { await emitNotification(payload) } catch (err) {
      console.error('[notify] notifyAllocationAction failed:', err)
    }
  }

  // 1. Notify the resource
  if (resourceEmployeeId) {
    await emitSafe({
      type:                'allocation_updated',
      title,
      message:             `Your allocation on ${project}: ${change}`,
      recipientId:         resourceEmployeeId,
      relatedEntityType:   'forecast_allocation',
      relatedEntityId:     relatedEntityId ?? null,
    })
  }

  // 2. Notify the actor (confirmation of the action they performed)
  if (actorEmployeeId && actorEmployeeId !== resourceEmployeeId) {
    await emitSafe({
      type:                'allocation_updated',
      title:               `${title} — Confirmed`,
      message:             `${resource}'s allocation on ${project}: ${change}`,
      recipientId:         actorEmployeeId,
      relatedEntityType:   'forecast_allocation',
      relatedEntityId:     relatedEntityId ?? null,
    })
  }
}
