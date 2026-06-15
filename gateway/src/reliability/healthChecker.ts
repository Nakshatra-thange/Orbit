import { db } from '../utils/db';
import type { EventType } from '../../../shared/types';

/*
 * Incident writer — the event sourcing core of Orbit
 * ────────────────────────────────────────────────────
 * Every significant reliability event is written here as an immutable
 * row in incident_events. The incident timeline in the dashboard is
 * built entirely from these rows — no manual postmortems, no guessing.
 *
 * Event sourcing pattern:
 * Instead of storing "current state" and overwriting it, we store
 * every state transition as an event. This means:
 *   - Full audit trail of what happened and when
 *   - MTTD and MTTR computed from timestamps (not estimated)
 *   - Timeline can be replayed or exported
 *   - Nothing is lost when a circuit closes
 *
 * WHY this impresses interviewers:
 * Most candidates store "service X is down: true/false".
 * Event sourcing lets you answer "what happened at 10:04:31?"
 * That's the question every postmortem starts with.
 */

export async function getOrCreateActiveIncident(
  serviceId: string,
  tenantId:  string
): Promise<string> {
  // Check for an existing active incident for this service
  const existing = await db.query(
    `SELECT id FROM incidents
     WHERE service_id = $1 AND status = 'active'
     ORDER BY started_at DESC LIMIT 1`,
    [serviceId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id as string;
  }

  // No active incident — create one
  const result = await db.query(
    `INSERT INTO incidents (service_id, tenant_id, status)
     VALUES ($1, $2, 'active')
     RETURNING id`,
    [serviceId, tenantId]
  );

  return result.rows[0].id as string;
}

export async function writeIncidentEvent(params: {
  serviceId:   string;
  tenantId:    string;
  eventType:   EventType;
  description: string;
  metadata?:   Record<string, unknown>;
}): Promise<void> {
  try {
    const incidentId = await getOrCreateActiveIncident(
      params.serviceId,
      params.tenantId
    );

    await db.query(
      `INSERT INTO incident_events
         (incident_id, service_id, event_type, description, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        incidentId,
        params.serviceId,
        params.eventType,
        params.description,
        JSON.stringify(params.metadata ?? {}),
      ]
    );
  } catch (err) {
    // Never let incident writing crash the gateway
    console.error('[orbit:incidents] write failed:', err);
  }
}

export async function resolveIncident(
  serviceId: string
): Promise<void> {
  try {
    // Find the active incident
    const result = await db.query(
      `SELECT id, started_at FROM incidents
       WHERE service_id = $1 AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
      [serviceId]
    );

    if (result.rows.length === 0) return;

    const incident   = result.rows[0];
    const now        = new Date();
    const startedAt  = new Date(incident.started_at);

    // Find when threshold was first exceeded — that's when detection happened
    const firstThreshold = await db.query(
      `SELECT MIN(timestamp) AS first_signal
       FROM incident_events
       WHERE incident_id = $1
         AND event_type = 'threshold_exceeded'`,
      [incident.id]
    );

    // Find when circuit first opened — that's when protection kicked in
    const firstOpen = await db.query(
      `SELECT MIN(timestamp) AS first_open
       FROM incident_events
       WHERE incident_id = $1
         AND event_type = 'circuit_opened'`,
      [incident.id]
    );

    const firstSignal  = firstThreshold.rows[0].first_signal;
    const circuitOpened = firstOpen.rows[0].first_open;

    /*
     * MTTD = mean time to detection
     * Time from first threshold_exceeded event to circuit_opened event.
     * In Orbit this should be ~10s (one health check cycle).
     * In a system without active monitoring this could be minutes.
     */
    const mttdSeconds = firstSignal && circuitOpened
      ? Math.round(
          (new Date(circuitOpened).getTime() - new Date(firstSignal).getTime()) / 1000
        )
      : null;

    /*
     * MTTR = mean time to recovery
     * Time from circuit_opened to circuit_closed (now).
     */
    const mttrSeconds = circuitOpened
      ? Math.round(
          (now.getTime() - new Date(circuitOpened).getTime()) / 1000
        )
      : Math.round((now.getTime() - startedAt.getTime()) / 1000);

    await db.query(
      `UPDATE incidents SET
         status       = 'resolved',
         resolved_at  = NOW(),
         mttd_seconds = $1,
         mttr_seconds = $2
       WHERE id = $3`,
      [mttdSeconds, mttrSeconds, incident.id]
    );
  } catch (err) {
    console.error('[orbit:incidents] resolve failed:', err);
  }
}

export async function getIncidentTimeline(
  serviceId: string,
  limit = 10
): Promise<{
  incidents: unknown[];
  events:    unknown[];
}> {
  const [incidents, events] = await Promise.all([
    db.query(
      `SELECT * FROM incidents
       WHERE service_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [serviceId, limit]
    ),
    db.query(
      `SELECT ie.*
       FROM incident_events ie
       JOIN incidents i ON i.id = ie.incident_id
       WHERE i.service_id = $1
       ORDER BY ie.timestamp DESC
       LIMIT 100`,
      [serviceId]
    ),
  ]);

  return {
    incidents: incidents.rows,
    events:    events.rows,
  };
}