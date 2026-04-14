import type { JsonSchemaLike } from './types.ts';

const INVALID_IDENTIFIER = /[^a-zA-Z0-9_]/g;

export function nowIso(): string {
  return new Date().toISOString();
}

export function stableId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export function sanitizeIdentifier(value: string): string {
  const cleaned = value.replace(INVALID_IDENTIFIER, '_').replace(/^_+|_+$/g, '');
  return cleaned.length ? cleaned : 'item';
}

export function toTableName(mockName: string, endpointPath: string, method: string): string {
  return sanitizeIdentifier(`mock_${mockName}_${method}_${endpointPath}`)
    .replace(/_+/g, '_')
    .toLowerCase();
}

export function normalizePathPattern(path: string): string {
  return `/${path
    .replace(/^\/+/, '')
    .replace(/\{([^}]+)\}/g, ':$1')
    .replace(/\/+/g, '/')}`;
}

export function pathToName(path: string): string {
  const cleaned = path
    .replace(/^\/+/, '')
    .replace(/\{([^}]+)\}/g, '$1')
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeIdentifier(segment));
  return cleaned.length ? cleaned.join('_') : 'root';
}

export function isCollectionPath(path: string): boolean {
  return !/\{[^}]+\}|:[^/]+/.test(path);
}

export function inferNameFromMethodAndPath(method: string, path: string): string {
  const resource = pathToName(path);
  const safeMethod = method.toLowerCase();
  return sanitizeIdentifier(`${safeMethod}_${resource}`);
}

export function ensureLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export function toJsonSchemaLike(value: unknown): JsonSchemaLike {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length ? toJsonSchemaLike(value[0]) : { type: 'string' }
    };
  }

  if (value === null) {
    return { type: 'null' };
  }

  switch (typeof value) {
    case 'string':
      return { type: 'string', example: value };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer', example: value } : { type: 'number', example: value };
    case 'boolean':
      return { type: 'boolean', example: value };
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>).reduce<Record<string, JsonSchemaLike>>(
        (acc, [key, child]) => {
          acc[key] = toJsonSchemaLike(child);
          return acc;
        },
        {}
      );
      return {
        type: 'object',
        properties: entries,
        required: Object.keys(entries)
      };
    }
    default:
      return { type: 'string', example: String(value) };
  }
}

export function sampleFromSchema(schema: JsonSchemaLike, depth = 0): unknown {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  const typed = schema as Record<string, unknown>;
  if ('example' in typed && typed.example !== undefined) {
    return typed.example;
  }
  if ('default' in typed && typed.default !== undefined) {
    return typed.default;
  }
  if (Array.isArray(typed.enum) && typed.enum.length > 0) {
    return typed.enum[0];
  }
  if (Array.isArray(typed.oneOf) && typed.oneOf.length > 0) {
    return sampleFromSchema(typed.oneOf[0] as JsonSchemaLike, depth + 1);
  }
  if (Array.isArray(typed.anyOf) && typed.anyOf.length > 0) {
    return sampleFromSchema(typed.anyOf[0] as JsonSchemaLike, depth + 1);
  }

  switch (typed.type) {
    case 'string':
      return typed.format === 'date-time' ? new Date().toISOString() : 'string';
    case 'integer':
      return 1;
    case 'number':
      return 1.23;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array':
      return [sampleFromSchema((typed.items as JsonSchemaLike) ?? { type: 'string' }, depth + 1)];
    case 'object': {
      if (depth > 4) {
        return {};
      }
      const properties = (typed.properties as Record<string, JsonSchemaLike> | undefined) ?? {};
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(properties)) {
        output[key] = sampleFromSchema(child, depth + 1);
      }
      if (!Object.keys(output).length && typed.additionalProperties && typeof typed.additionalProperties === 'object') {
        output.value = sampleFromSchema(typed.additionalProperties as JsonSchemaLike, depth + 1);
      }
      return output;
    }
    default:
      if (typed.properties) {
        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(typed.properties as Record<string, JsonSchemaLike>)) {
          output[key] = sampleFromSchema(child, depth + 1);
        }
        return output;
      }
      return 'string';
  }
}

export function safeJsonParse<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;
}
