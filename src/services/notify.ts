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
