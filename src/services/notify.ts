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

interface NotificationPayload {
  type: string
  title: string
  message: string
  recipientId?: string | null
  relatedEntityType?: string | null
  relatedEntityId?: string | null
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
 */
export async function notifyBookingConfirmed(
  employeeName: string,
  projectName: string,
  startDate: string,
  endDate: string,
  emEpName?: string,
): Promise<void> {
  await emitNotification({
    type: 'booking_confirmed',
    title: 'Booking Confirmed',
    message: `${employeeName} allocated to ${projectName} (${startDate} – ${endDate})${emEpName ? ` — EM/EP: ${emEpName}` : ''}`,
    relatedEntityType: 'project',
  })
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
