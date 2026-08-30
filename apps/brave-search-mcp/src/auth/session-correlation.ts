import type { RequestMetadata } from './identity-context.js';

const STARTUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN = /^\w[\w.-]{0,199}$/;
const MAX_CORRELATIONS = 4096;

export const SESSION_CORRELATION_PATH = '/session-correlation';

interface StoredCorrelation {
  metadata: RequestMetadata;
  updatedAt: number;
}

export interface SessionCorrelationInput {
  cwd: string;
  sessionId: string;
  startupId: string;
}

export class SessionCorrelationStore {
  private readonly entries = new Map<string, StoredCorrelation>();

  get(startupId: string): RequestMetadata | undefined {
    return this.entries.get(startupId)?.metadata;
  }

  set(input: SessionCorrelationInput): void {
    if (this.entries.size >= MAX_CORRELATIONS && !this.entries.has(input.startupId)) {
      const oldest = [...this.entries.entries()]
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]?.[0];
      if (oldest)
        this.entries.delete(oldest);
    }

    this.entries.set(input.startupId, {
      metadata: {
        client: 'claude',
        cwd: input.cwd,
        sessionId: input.sessionId,
      },
      updatedAt: Date.now(),
    });
  }
}

export function parseSessionCorrelationInput(value: unknown): SessionCorrelationInput | undefined {
  if (!value || typeof value !== 'object')
    return undefined;

  const { cwd, sessionId, startupId } = value as Record<string, unknown>;
  if (
    typeof startupId !== 'string'
    || !STARTUP_ID_PATTERN.test(startupId)
    || typeof sessionId !== 'string'
    || !SESSION_ID_PATTERN.test(sessionId)
    || sessionId === '..'
    || typeof cwd !== 'string'
    || !cwd.startsWith('/')
    || cwd.length > 4096
    || /[\0\r\n]/.test(cwd)
  ) {
    return undefined;
  }

  return { cwd, sessionId, startupId };
}

export function isValidStartupId(value: string | undefined): value is string {
  return typeof value === 'string' && STARTUP_ID_PATTERN.test(value);
}
