import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiProblem } from './errors.js';

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function hasValidBearerToken(request: Request, token?: string) {
  if (!token) return true;
  const header = request.header('authorization') ?? '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Boolean(candidate && safeEqual(candidate, token));
}

export function authGuard(token?: string) {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!hasValidBearerToken(request, token)) {
      return next(new ApiProblem(401, 'UNAUTHORIZED', 'A valid Bearer token is required'));
    }
    next();
  };
}

export function parseCorsOrigins(raw = process.env.PACT_CORS_ORIGINS ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173') {
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
}
