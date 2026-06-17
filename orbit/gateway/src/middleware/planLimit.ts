import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db';

/*
 * Plan limit enforcement — the SaaS layer
 * ──────────────────────────────────────────
 * Applied when a tenant tries to register a new service.
 * Each plan has a service_limit set in the tenants table.
 *
 *   starter:    3 services,  no policy editor, no replay
 *   pro:        10 services, full feature access
 *   enterprise: unlimited
 *
 * This is the difference between "I built infrastructure" and
 * "I built a product with pricing tiers that enforce themselves."
 */

export async function enforcePlanLimit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      res.status(401).json({ success: false, error: 'Tenant not identified' });
      return;
    }

    const tenantResult = await db.query(
      'SELECT plan, service_limit FROM tenants WHERE id = $1',
      [tenantId]
    );

    if (tenantResult.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Tenant not found' });
      return;
    }

    const { plan, service_limit } = tenantResult.rows[0];

    const countResult = await db.query(
      'SELECT COUNT(*) FROM services WHERE tenant_id = $1 AND is_active = TRUE',
      [tenantId]
    );

    const currentCount = Number(countResult.rows[0].count);

    if (currentCount >= service_limit) {
      res.status(403).json({
        success: false,
        error: `Plan limit reached. ${plan} plan allows ${service_limit} services. Upgrade to add more.`,
        currentCount,
        limit: service_limit,
        plan,
      });
      return;
    }

    // Attach plan info to request for downstream use (e.g. feature gating)
    req.headers['x-tenant-plan'] = plan;
    next();
  } catch (err) {
    console.error('[orbit:plan-limit] check failed:', err);
    res.status(500).json({ success: false, error: 'Plan check failed' });
  }
}

/*
 * Feature gating — policy editor and safe replay are Pro+ features
 */
export function requirePlan(...allowedPlans: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const plan = req.headers['x-tenant-plan'] as string;
    if (!allowedPlans.includes(plan)) {
      res.status(403).json({
        success: false,
        error: `This feature requires one of: ${allowedPlans.join(', ')}. Current plan: ${plan}.`,
      });
      return;
    }
    next();
  };
}