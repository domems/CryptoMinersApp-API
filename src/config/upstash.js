import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import "dotenv/config";

/**
 * Cliente Redis (REST) – para locks, caches, etc.
 * Requer:
 *  - UPSTASH_REDIS_REST_URL
 *  - UPSTASH_REDIS_REST_TOKEN
 */
export const redis = Redis.fromEnv();

/**
 * Rate limiter (continua igual ao que tinhas).
 */
export const rateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(100, "60 s"),
});

// Mantém default para não partir middleware que já importa default
export default rateLimiter;
