import type { Request } from 'express';

export type OrbitRequest = Request & {
  orbitSanitisedHeaders?: Record<string, string>;
};
