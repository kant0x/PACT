import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyMessage } from 'viem';
import { query } from './db.js';
import { ApiProblem } from './errors.js';

export interface WalletSessionClaims {
  sub: string;
  kind: 'wallet';
  iat: number;
  exp: number;
  jti: string;
  aud: string;
}

interface ChallengeRecord {
  id: string;
  address: string;
  message: string;
  expiresAt: number;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = <T>(value: string) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class WalletAuthService {
  private readonly memoryChallenges = new Map<string, ChallengeRecord>();
  private schemaReady: Promise<void> | null = null;
  private readonly databaseEnabled: boolean;

  constructor(
    private readonly secret: string,
    private readonly audience: string,
    private readonly challengeTtlSeconds = Number(process.env.PACT_AUTH_CHALLENGE_TTL_SECONDS ?? 180),
    private readonly sessionTtlSeconds = Number(process.env.PACT_AUTH_SESSION_TTL_SECONDS ?? 900),
  ) {
    if (secret.length < 32) throw new Error('PACT_SESSION_SECRET must contain at least 32 characters');
    this.databaseEnabled = Boolean(process.env.PACT_DATABASE_URL ?? process.env.DATABASE_URL);
  }

  async issueChallenge(address: string) {
    const normalized = address.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
      throw new ApiProblem(400, 'INVALID_WALLET_ADDRESS', 'address must be a 20-byte EVM address');
    }
    const id = randomUUID();
    const nonce = randomBytes(18).toString('base64url');
    const issuedAt = new Date();
    const expiresAt = Math.floor(issuedAt.getTime() / 1000) + this.challengeTtlSeconds;
    const message = [
      'PACT wallet authentication',
      `domain=${this.audience}`,
      `address=${normalized}`,
      `nonce=${nonce}`,
      `issuedAt=${issuedAt.toISOString()}`,
      `expirationTime=${new Date(expiresAt * 1000).toISOString()}`,
    ].join('\n');
    const record = { id, address: normalized, message, expiresAt };
    if (this.databaseEnabled) {
      await this.ensureSchema();
      await query(
        `INSERT INTO auth_challenges (id, address, message, expires_at, used_at)
         VALUES ($1, $2, $3, $4, NULL)`,
        [id, normalized, message, expiresAt],
      );
    } else {
      this.pruneMemoryChallenges();
      this.memoryChallenges.set(id, record);
    }
    return { challengeId: id, message, expiresAt };
  }

  async verifyChallenge(input: { challengeId: string; address: string; signature: string }) {
    const normalized = input.address.toLowerCase();
    const record = await this.consumeChallenge(input.challengeId);
    if (!record || record.address !== normalized || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new ApiProblem(401, 'AUTH_CHALLENGE_INVALID', 'The wallet challenge is invalid, expired, or already used');
    }
    let valid = false;
    try {
      valid = await verifyMessage({
        address: normalized as `0x${string}`,
        message: record.message,
        signature: input.signature as `0x${string}`,
      });
    } catch {
      valid = false;
    }
    if (!valid) throw new ApiProblem(403, 'INVALID_WALLET_SIGNATURE', 'Wallet signature verification failed');
    const now = Math.floor(Date.now() / 1000);
    const claims: WalletSessionClaims = {
      sub: normalized,
      kind: 'wallet',
      iat: now,
      exp: now + this.sessionTtlSeconds,
      jti: randomUUID(),
      aud: this.audience,
    };
    return { token: this.signSession(claims), address: normalized, expiresAt: claims.exp };
  }

  verifySession(token: string): WalletSessionClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'pact1') return null;
    const expected = createHmac('sha256', this.secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (!safeEqual(expected, parts[2])) return null;
    try {
      const claims = decode<WalletSessionClaims>(parts[1]);
      if (claims.kind !== 'wallet' || claims.aud !== this.audience || claims.exp <= Math.floor(Date.now() / 1000)) return null;
      if (!/^0x[a-f0-9]{40}$/.test(claims.sub)) return null;
      return claims;
    } catch {
      return null;
    }
  }

  private signSession(claims: WalletSessionClaims) {
    const payload = encode(claims);
    const unsigned = `pact1.${payload}`;
    return `${unsigned}.${createHmac('sha256', this.secret).update(unsigned).digest('base64url')}`;
  }

  private async consumeChallenge(id: string): Promise<ChallengeRecord | null> {
    if (this.databaseEnabled) {
      await this.ensureSchema();
      const result = await query(
        `UPDATE auth_challenges
         SET used_at = $2
         WHERE id = $1 AND used_at IS NULL AND expires_at >= $2
         RETURNING id, address, message, expires_at`,
        [id, Math.floor(Date.now() / 1000)],
      );
      const row = result.rows[0];
      return row ? { id: row.id, address: row.address, message: row.message, expiresAt: Number(row.expires_at) } : null;
    }
    const record = this.memoryChallenges.get(id) ?? null;
    this.memoryChallenges.delete(id);
    return record;
  }

  private ensureSchema() {
    this.schemaReady ??= query(`
      CREATE TABLE IF NOT EXISTS auth_challenges (
        id UUID PRIMARY KEY,
        address VARCHAR(42) NOT NULL,
        message TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        used_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at ON auth_challenges(expires_at);
    `).then(() => undefined);
    return this.schemaReady;
  }

  private pruneMemoryChallenges() {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, record] of this.memoryChallenges) {
      if (record.expiresAt < now) this.memoryChallenges.delete(id);
    }
  }
}
