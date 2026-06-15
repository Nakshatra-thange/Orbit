import jwt from 'jsonwebtoken';
import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    beforeAll,
    afterAll,
  } from "@jest/globals";
// Set JWT_SECRET before importing middleware
process.env.JWT_SECRET = 'test_secret';

import { sanitiseHeaders, redactBody } from '../../gateway/src/utils/sanitise';

describe('sanitiseHeaders', () => {
  it('strips authorization header', () => {
    const result = sanitiseHeaders({
      authorization:    'Bearer token123',
      'content-type':   'application/json',
      'x-correlation-id': 'abc-123',
    });
    expect(result['authorization']).toBeUndefined();
    expect(result['content-type']).toBe('application/json');
    expect(result['x-correlation-id']).toBe('abc-123');
  });

  it('strips cookie header', () => {
    const result = sanitiseHeaders({ cookie: 'session=abc123', host: 'localhost' });
    expect(result['cookie']).toBeUndefined();
    expect(result['host']).toBe('localhost');
  });

  it('strips x-api-key header', () => {
    const result = sanitiseHeaders({ 'x-api-key': 'secret', accept: 'application/json' });
    expect(result['x-api-key']).toBeUndefined();
    expect(result['accept']).toBe('application/json');
  });
});

describe('redactBody', () => {
  const sensitiveFields = ['password', 'token', 'secret', 'card'];

  it('redacts top-level sensitive fields', () => {
    const result = redactBody(
      { email: 'user@example.com', password: 'supersecret123' },
      sensitiveFields
    );
    expect(result?.['password']).toBe('***');
    expect(result?.['email']).toBe('user@example.com');
  });

  it('redacts nested sensitive fields', () => {
    const result = redactBody(
      { user: { name: 'Alice', token: 'abc123' } },
      sensitiveFields
    );
    expect((result?.['user'] as Record<string, unknown>)?.['token']).toBe('***');
    expect((result?.['user'] as Record<string, unknown>)?.['name']).toBe('Alice');
  });

  it('redacts fields case-insensitively', () => {
    const result = redactBody({ Password: 'secret' }, sensitiveFields);
    expect(result?.['Password']).toBe('***');
  });

  it('handles arrays in body', () => {
    const result = redactBody(
      { items: [{ card: '4111111111111111', amount: 100 }] },
      sensitiveFields
    );
    const items = result?.['items'] as Record<string, unknown>[];
    expect(items[0]['card']).toBe('***');
    expect(items[0]['amount']).toBe(100);
  });

  it('returns null for non-object body', () => {
    expect(redactBody('string body', sensitiveFields)).toBeNull();
    expect(redactBody(null, sensitiveFields)).toBeNull();
  });
});

describe('JWT structure', () => {
  it('generates a verifiable token with correct claims', () => {
    const payload = {
      sub:      'user-123',
      email:    'user@example.com',
      tier:     'pro',
      tenantId: 'tenant-abc',
    };
    const token = jwt.sign(payload, 'test_secret', { expiresIn: '1h' });
    const decoded = jwt.verify(token, 'test_secret') as typeof payload;

    expect(decoded.sub).toBe('user-123');
    expect(decoded.tier).toBe('pro');
    expect(decoded.tenantId).toBe('tenant-abc');
  });

  it('throws on expired token', () => {
    const token = jwt.sign({ sub: 'user-1' }, 'test_secret', { expiresIn: '-1s' });
    expect(() => jwt.verify(token, 'test_secret')).toThrow(jwt.TokenExpiredError);
  });

  it('throws on invalid signature', () => {
    const token = jwt.sign({ sub: 'user-1' }, 'correct_secret');
    expect(() => jwt.verify(token, 'wrong_secret')).toThrow(jwt.JsonWebTokenError);
  });
});