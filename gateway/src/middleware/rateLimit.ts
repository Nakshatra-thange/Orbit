import { Request, Response, NextFunction } from 'express';
import { createRedisWall, DEFAULT_TIERS } from '@nakshatrathange/rediswall';
import { redis } from '../utils/redis';

/*
 * Rate limiting via @nakshatrathange/rediswall
 * ─────────────────────────────────────────────
 * This is the "dog-fooding" moment — Orbit uses its author's own
 * published package for rate limiting. In an interview this signals:
 *   1. You ship reusable open-source code
 *   2. You design systems where components are interchangeable
 *   3. You understand your own abstractions well enough to build on them
 *
 * Tier resolution: read X-User-Tier stamped by authMiddleware.
 * Identifier: prefer X-User-Id (authenticated) over IP (anonymous).
 *
 * Different limits per tier:
 *   free:       100 req/min   → protects against accidental abuse
 *   pro:        1000 req/min  → generous for paying customers
 *   enterprise: 10000 req/min → effectively unlimited for large accounts
 *
 * Circuit breaker on the rate limiter itself:
 * If Redis goes down, rediswall's circuit breaker opens and falls back
 * to in-memory limiting. Orbit keeps running even if Redis dies.
 */

const tiers = {
  free:       { name: 'free',       limit: 100,   windowMs: 60_000 },
  pro:        { name: 'pro',        limit: 1000,  windowMs: 60_000 },
  enterprise: { name: 'enterprise', limit: 10000, windowMs: 60_000 },
};

export const rateLimitMiddleware = createRedisWall({
  redis:        redis as never,
  strategy:     'sliding-window',
  tiers,
  defaultTier:  'free',

  tierFn: (req: Request) => {
    const tier = req.headers['x-user-tier'] as string;
    if (tier === 'pro' || tier === 'enterprise') return tier;
    return 'free';
  },

  identifierFn: (req: Request) => {
    // Authenticated: rate limit per user ID (accurate)
    const userId = req.headers['x-user-id'] as string;
    if (userId) return `user:${userId}`;

    // Anonymous: fall back to IP (less accurate but still protective)
    const forwarded = req.headers['x-forwarded-for'] as string;
    const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
    return `ip:${ip ?? 'unknown'}`;
  },

  circuitBreaker: {
    failureThreshold: 3,
    cooldownMs:       10_000,
  },
  failOpen: true,

  onLimitReached: (req, result) => {
    console.log(JSON.stringify({
      event:         'rate_limit_exceeded',
      userId:        req.headers['x-user-id'],
      tier:          req.headers['x-user-tier'] ?? 'free',
      path:          req.path,
      correlationId: req.headers['x-correlation-id'],
      resetAt:       new Date(result.resetAt).toISOString(),
    }));
  },
});