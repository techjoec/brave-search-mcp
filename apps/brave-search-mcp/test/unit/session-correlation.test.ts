import { describe, expect, it } from 'vitest';
import { parseSessionCorrelationInput, SessionCorrelationStore } from '../../src/auth/session-correlation.js';

describe('session correlation', () => {
  it('validates and stores Claude session metadata', () => {
    const input = parseSessionCorrelationInput({
      startupId: '5948588b-902b-4f64-8b8c-39571df874c9',
      sessionId: '7ea1180d-32f1-416c-b4f4-42184a9f158e',
      cwd: '/tmp/what',
    });
    expect(input).toBeDefined();

    const store = new SessionCorrelationStore();
    store.set(input!);
    expect(store.get(input!.startupId)).toEqual({
      client: 'claude',
      cwd: '/tmp/what',
      sessionId: '7ea1180d-32f1-416c-b4f4-42184a9f158e',
    });
  });

  it.each([
    { startupId: 'not-a-uuid', sessionId: 'session', cwd: '/tmp' },
    { startupId: '5948588b-902b-4f64-8b8c-39571df874c9', sessionId: '../escape', cwd: '/tmp' },
    { startupId: '5948588b-902b-4f64-8b8c-39571df874c9', sessionId: 'session', cwd: 'relative' },
  ])('rejects invalid correlation metadata: %o', (input) => {
    expect(parseSessionCorrelationInput(input)).toBeUndefined();
  });
});
