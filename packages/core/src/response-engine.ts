import type { MockEndpoint, ResponseSequenceItem } from './types.ts';

export interface RequestContext {
  body: unknown;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  method: string;
  path: string;
}

const sequenceCounters = new Map<string, number>();

function resolveJsonPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/^\./, '').split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatNow(format?: string): string {
  const d = new Date();
  switch (format) {
    case 'iso': return d.toISOString();
    case 'date': return d.toISOString().slice(0, 10);
    case 'time': return d.toTimeString().slice(0, 8);
    case 'timestamp': return String(Math.floor(d.getTime() / 1000));
    default: return d.toISOString();
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickOne<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

const firstNames = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Hank'];
const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis'];
const domains = ['example.com', 'test.org', 'mock.dev', 'sample.io'];

function faker(prop: string): string {
  switch (prop) {
    case 'name': return `${pickOne(firstNames)} ${pickOne(lastNames)}`;
    case 'firstName': return pickOne(firstNames);
    case 'lastName': return pickOne(lastNames);
    case 'email': return `${pickOne(firstNames).toLowerCase()}.${pickOne(lastNames).toLowerCase()}@${pickOne(domains)}`;
    case 'uuid': return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    case 'int':
    case 'integer': return String(randomInt(1, 10000));
    case 'float':
    case 'number': return String(Math.round(Math.random() * 10000) / 100);
    case 'bool':
    case 'boolean': return Math.random() > 0.5 ? 'true' : 'false';
    case 'street': return `${randomInt(1, 9999)} ${pickOne(['Main', 'Oak', 'Elm', 'Park', 'Lake', 'Hill'])} St`;
    case 'city': return pickOne(['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Sydney', 'Melbourne', 'London']);
    case 'phone': return `+1-${randomInt(200, 999)}-${randomInt(100, 999)}-${randomInt(1000, 9999)}`;
    case 'url': return `https://${pickOne(domains)}/${pickOne(['api', 'app', 'www'])}`;
    default: return `{{faker.${prop}}}`;
  }
}

function evaluateExpression(expr: string, ctx: RequestContext): string {
  const trimmed = expr.trim();

  // faker.*
  if (trimmed.startsWith('faker.')) {
    return faker(trimmed.slice(6));
  }

  // request.body.path
  if (trimmed.startsWith('request.body.')) {
    const path = trimmed.slice(13);
    const resolved = resolveJsonPath(ctx.body, path);
    return resolved == null ? '' : String(resolved);
  }

  // request.query.name
  if (trimmed.startsWith('request.query.')) {
    const name = trimmed.slice(14);
    return ctx.query[name] ?? '';
  }

  // request.params.name
  if (trimmed.startsWith('request.params.')) {
    const name = trimmed.slice(15);
    return ctx.params[name] ?? '';
  }

  // request.headers.name
  if (trimmed.startsWith('request.headers.')) {
    const name = trimmed.slice(16).toLowerCase();
    return ctx.headers[name] ?? '';
  }

  // now(format?)
  if (trimmed.startsWith('now')) {
    const formatMatch = trimmed.match(/^now\(['"]?(\w+)['"]?\)$/);
    return formatNow(formatMatch?.[1]);
  }

  // randomInt(min, max)
  if (trimmed.startsWith('randomInt')) {
    const match = trimmed.match(/randomInt\((\d+),\s*(\d+)\)/);
    if (match) return String(randomInt(Number(match[1]), Number(match[2])));
  }

  return `{{${expr}}}`;
}

/**
 * Renders a template string by replacing {{...}} placeholders.
 */
export function renderTemplate(template: string, ctx: RequestContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, expr) => evaluateExpression(expr, ctx));
}

/**
 * Renders a value that may be a template string or a nested structure containing templates.
 */
export function renderDeep(value: unknown, ctx: RequestContext): unknown {
  if (typeof value === 'string') {
    return value.includes('{{') && value.includes('}}') ? renderTemplate(value, ctx) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderDeep(item, ctx));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = renderDeep(val, ctx);
    }
    return result;
  }
  return value;
}

/**
 * Gets the current response from a sequence and advances the counter.
 */
export function resolveSequence(
  endpoint: MockEndpoint,
  counters?: Map<string, number>
): { body: unknown; statusCode: number; latencyMs: number } | null {
  if (!endpoint.responseSequence?.length) return null;

  const localCounters = counters ?? sequenceCounters;
  const key = endpoint.id;
  const current = localCounters.get(key) ?? 0;
  const item = endpoint.responseSequence[current];
  const next = (current + 1) % endpoint.responseSequence.length;
  localCounters.set(key, next);

  return {
    body: item.body,
    statusCode: item.statusCode,
    latencyMs: item.latencyMs ?? 0
  };
}

/**
 * Resets sequence counters for testing.
 */
export function resetSequenceCounters(): void {
  sequenceCounters.clear();
}

/**
 * Builds a RequestContext from incoming request parts.
 */
export function buildRequestContext(req: {
  body: unknown;
  query?: Record<string, string | string[]>;
  params?: Record<string, string>;
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
}): RequestContext {
  const flattenValues = (obj: Record<string, string | string[] | undefined>): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = Array.isArray(val) ? val.join(',') : String(val ?? '');
    }
    return result;
  };

  return {
    body: req.body,
    query: flattenValues(req.query ?? {}),
    params: req.params ?? {},
    headers: flattenValues(req.headers ?? {}),
    method: req.method ?? 'GET',
    path: req.path ?? '/'
  };
}
