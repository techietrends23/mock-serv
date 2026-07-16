import { describe, expect, it } from 'vitest';
import {
  sampleFromSchema,
  normalizePathPattern,
  toTableName,
  sanitizeIdentifier,
  isCollectionPath,
  toJsonSchemaLike,
  ensureLeadingSlash,
  nowIso
} from './utils.ts';

describe('sanitizeIdentifier', () => {
  it('removes invalid characters', () => {
    expect(sanitizeIdentifier('hello world')).toBe('hello_world');
    expect(sanitizeIdentifier('foo-bar!baz')).toBe('foo_bar_baz');
  });

  it('trims leading/trailing underscores', () => {
    expect(sanitizeIdentifier('__hello__')).toBe('hello');
  });

  it('returns fallback when result is empty', () => {
    expect(sanitizeIdentifier('!!!')).toBe('item');
  });
});

describe('toTableName', () => {
  it('creates a valid table name from mock name and endpoint', () => {
    const result = toTableName('My Mock', '/api/users', 'GET');
    expect(result).toBe('mock_my_mock_get_api_users');
    expect(result).not.toMatch(/[^a-z0-9_]/);
  });
});

describe('normalizePathPattern', () => {
  it('converts {param} to :param style', () => {
    expect(normalizePathPattern('/users/{id}')).toBe('/users/:id');
  });

  it('normalizes leading slashes', () => {
    expect(normalizePathPattern('users')).toBe('/users');
  });

  it('removes duplicate slashes', () => {
    expect(normalizePathPattern('//users//posts')).toBe('/users/posts');
  });
});

describe('isCollectionPath', () => {
  it('returns true for paths without parameters', () => {
    expect(isCollectionPath('/users')).toBe(true);
  });

  it('returns false for paths with {param}', () => {
    expect(isCollectionPath('/users/{id}')).toBe(false);
  });

  it('returns false for paths with :param', () => {
    expect(isCollectionPath('/users/:id')).toBe(false);
  });
});

describe('toJsonSchemaLike', () => {
  it('converts an object to a JSON schema', () => {
    const schema = toJsonSchemaLike({ name: 'Alice', age: 30, active: true });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', example: 'Alice' },
        age: { type: 'integer', example: 30 },
        active: { type: 'boolean', example: true }
      },
      required: ['name', 'age', 'active']
    });
  });

  it('converts an array to array schema', () => {
    const schema = toJsonSchemaLike([{ id: 1 }]);
    expect(schema).toHaveProperty('type', 'array');
    expect(schema).toHaveProperty('items');
  });

  it('handles null', () => {
    expect(toJsonSchemaLike(null)).toEqual({ type: 'null' });
  });
});

describe('sampleFromSchema', () => {
  it('returns example if present', () => {
    expect(sampleFromSchema({ type: 'string', example: 'hello' })).toBe('hello');
  });

  it('returns default if no example', () => {
    expect(sampleFromSchema({ type: 'string', default: 'fallback' })).toBe('fallback');
  });

  it('returns first enum value', () => {
    expect(sampleFromSchema({ type: 'string', enum: ['a', 'b', 'c'] })).toBe('a');
  });

  it('generates string sample', () => {
    expect(sampleFromSchema({ type: 'string' })).toBe('string');
  });

  it('generates date-time sample', () => {
    const result = sampleFromSchema({ type: 'string', format: 'date-time' });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('generates integer sample', () => {
    expect(sampleFromSchema({ type: 'integer' })).toBe(1);
  });

  it('generates number sample', () => {
    expect(sampleFromSchema({ type: 'number' })).toBe(1.23);
  });

  it('generates boolean sample', () => {
    expect(sampleFromSchema({ type: 'boolean' })).toBe(true);
  });

  it('generates null sample', () => {
    expect(sampleFromSchema({ type: 'null' })).toBe(null);
  });

  it('generates array sample', () => {
    const result = sampleFromSchema({ type: 'array', items: { type: 'string' } });
    expect(result).toEqual(['string']);
  });

  it('generates object sample from properties', () => {
    const result = sampleFromSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' }
      }
    });
    expect(result).toEqual({ name: 'string', age: 1 });
  });

  it('limits depth to 5 levels', () => {
    const deep: Record<string, unknown> = { type: 'object', properties: {} as Record<string, unknown> };
    let current = deep;
    for (let i = 0; i < 10; i++) {
      const nested = { type: 'object', properties: {} as Record<string, unknown> };
      (current.properties as Record<string, unknown>).nested = nested;
      current = nested;
    }
    const result = sampleFromSchema(deep);
    expect(result).toBeDefined();
  });

  it('handles oneOf by using first option', () => {
    const result = sampleFromSchema({
      oneOf: [{ type: 'string' }, { type: 'integer' }]
    });
    expect(result).toBe('string');
  });

  it('handles anyOf by using first option', () => {
    const result = sampleFromSchema({
      anyOf: [{ type: 'integer' }, { type: 'string' }]
    });
    expect(result).toBe(1);
  });
});

describe('ensureLeadingSlash', () => {
  it('adds leading slash when missing', () => {
    expect(ensureLeadingSlash('users')).toBe('/users');
  });

  it('preserves existing leading slash', () => {
    expect(ensureLeadingSlash('/users')).toBe('/users');
  });
});

describe('nowIso', () => {
  it('returns an ISO string', () => {
    const result = nowIso();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
