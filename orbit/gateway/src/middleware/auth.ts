import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../utils/db';

/*
 * Auth middleware — runs on every non-public route
 * ─────────────────────────────────────────────────
 * Two auth modes:
 *
 * 1. JWT (user-facing requests)
 *    Bearer token in Authorization header.
 *    Verified against JWT_SECRET.
 *    User ID and tier extracted, stamped as headers for downstream services.
 *    Downstream services never decode JWTs — they trust X-User-Id.
 *
 * 2. API Key (service-to-service or dashboard)
 *    X-Api-Key header.
 *    Looked up in tenants table.
 *    Tenant ID stamped as X-Tenant-Id for downstream.
 *
 * WHY verify at the gateway and not each service?
 * If each service verifies JWTs independently:
 *   - JWT_SECRET must be shared with every service (security surface grows)
 *   - Every service adds auth library dependency
 *   - One misconfigured service skips auth silently
 * Gateway verifies once. Services trust the stamped headers.
 * One place to audit, one place to rotate secrets.
 */

interface JwtPayload {
  sub: string;       // user ID
  email: string;
  tier: string;      // free | pro | enterprise
  tenantId: string;
  iat: number;
  exp: number;
}

// Routes that skip JWT verification entirely
const PUBLIC_ROUTES = [
  '/health',
  '/orbit/services',
  '/auth/register',
  '/auth/login',
  '/auth/refresh',
];

function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTES.some(route => path.startsWith(route));
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (isPublicRoute(req.path)) {
    return next();
  }

  // ── Mode 1: API Key ────────────────────────────────────────────────────────
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey) {
    try {
      const result = await db.query(
        'SELECT id, plan FROM tenants WHERE api_key = $1',
        [apiKey]
      );
      if (result.rows.length === 0) {
        res.status(401).json({
          success: false,
          error:   'Invalid API key',
          correlationId: req.headers['x-correlation-id'],
        });
        return;
      }
      const tenant = result.rows[0];
      req.headers['x-tenant-id'] = tenant.id;
      req.headers['x-auth-mode'] = 'api-key';
      return next();
    } catch (err) {
      console.error('[orbit:auth] API key lookup failed:', err);
      res.status(500).json({ success: false, error: 'Auth service error' });
      return;
    }
  }

  // ── Mode 2: JWT Bearer token ───────────────────────────────────────────────
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error:   'Missing authentication. Provide Bearer token or X-Api-Key.',
      correlationId: req.headers['x-correlation-id'],
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not configured');

    const payload = jwt.verify(token, secret) as JwtPayload;

    /*
     * Stamp verified claims as headers for downstream services.
     * Services read X-User-Id, X-User-Tier, X-Tenant-Id — never the JWT.
     * This means:
     *   - JWT_SECRET never leaves the gateway
     *   - Services are stateless with respect to auth
     *   - Changing auth strategy only requires changing the gateway
     */
    req.headers['x-user-id']    = payload.sub;
    req.headers['x-user-tier']  = payload.tier;
    req.headers['x-tenant-id']  = payload.tenantId;
    req.headers['x-user-email'] = payload.email;
    req.headers['x-auth-mode']  = 'jwt';

    // Remove the raw JWT — downstream services don't need it
    delete req.headers['authorization'];

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        error:   'Token expired',
        correlationId: req.headers['x-correlation-id'],
      });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        success: false,
        error:   'Invalid token',
        correlationId: req.headers['x-correlation-id'],
      });
      return;
    }
    res.status(500).json({ success: false, error: 'Auth error' });
  }
}