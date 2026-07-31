import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiProblem } from './errors.js';
import type { WalletAuthService, WalletSessionClaims } from './wallet-auth.js';

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function hasValidBearerToken(request: Request, token?: string) {
  if (!token) return false;
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
  const value = raw.trim();
  if (value === '*') {
    if (process.env.NODE_ENV === 'production' || process.env.PACT_MODE === 'arc') {
      throw new Error('PACT_CORS_ORIGINS=* is forbidden in production/Arc mode');
    }
    return true;
  }
  return value.split(',').map((origin) => origin.trim()).filter(Boolean);
}

export type RequestIdentity =
  | { kind: 'operator'; subject: 'operator' }
  | { kind: 'wallet'; subject: string; claims: WalletSessionClaims }
  | { kind: 'agent'; subject: string; keyId: string };

const identities = new WeakMap<Request, RequestIdentity>();

export function requestIdentity(request: Request): RequestIdentity | null {
  return identities.get(request) ?? null;
}

export function identityMiddleware(
  operatorToken: string | undefined,
  walletAuth: WalletAuthService,
  verifyAgentToken?: (token: string) => Promise<{ agentAddress: string; keyId: string } | null> | { agentAddress: string; keyId: string } | null,
) {
  return (request: Request, _response: Response, next: NextFunction) => {
    const header = request.header('authorization') ?? '';
    const candidate = header.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (!candidate) return next();
    if (operatorToken && safeEqual(candidate, operatorToken)) {
      identities.set(request, { kind: 'operator', subject: 'operator' });
      return next();
    }
    const claims = walletAuth.verifySession(candidate);
    if (claims) {
      identities.set(request, { kind: 'wallet', subject: claims.sub, claims });
      return next();
    }
    Promise.resolve(verifyAgentToken?.(candidate) ?? null)
      .then((agent) => {
        if (agent) identities.set(request, { kind: 'agent', subject: agent.agentAddress, keyId: agent.keyId });
        next();
      })
      .catch(next);
  };
}

export function authenticatedGuard(request: Request, _response: Response, next: NextFunction) {
  if (!requestIdentity(request)) {
    return next(new ApiProblem(401, 'UNAUTHORIZED', 'Authenticate with a signed wallet session'));
  }
  next();
}

export function operatorGuard(request: Request, _response: Response, next: NextFunction) {
  const identity = requestIdentity(request);
  if (!identity) {
    return next(new ApiProblem(401, 'UNAUTHORIZED', 'A valid operator Bearer token is required'));
  }
  if (identity.kind !== 'operator') {
    return next(new ApiProblem(403, 'OPERATOR_REQUIRED', 'This operation is restricted to the settlement operator'));
  }
  next();
}

export function assertWalletSubject(request: Request, expectedAddress: string, message = 'The connected wallet does not own this resource') {
  const identity = requestIdentity(request);
  if (identity?.kind === 'operator') return;
  if (identity?.kind !== 'wallet' || identity.subject.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new ApiProblem(403, 'RESOURCE_FORBIDDEN', message);
  }
}

export function assertAgentSubject(request: Request, expectedAddress: string, message = 'The agent credential does not own this resource') {
  const identity = requestIdentity(request);
  if (identity?.kind === 'operator') return;
  if (identity?.kind !== 'agent' || identity.subject.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new ApiProblem(403, 'AGENT_FORBIDDEN', message);
  }
}

export function assertWalletOrAgentSubject(request: Request, expectedAddress: string, message = 'The credential does not own this resource') {
  const identity = requestIdentity(request);
  if (identity?.kind === 'operator') return;
  if ((identity?.kind === 'wallet' || identity?.kind === 'agent') && identity.subject.toLowerCase() === expectedAddress.toLowerCase()) return;
  throw new ApiProblem(403, 'RESOURCE_FORBIDDEN', message);
}
