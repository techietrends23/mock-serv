import type { MatchRule, MatchOperator } from './types.ts';

export interface MatchRequest {
  method: string;
  url: string;
  path: string;
  queryString?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

function headerValue(headers: MatchRequest['headers'], name: string): string {
  if (!headers) return '';
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct.join(',');
  return direct == null ? '' : String(direct);
}

function bodyText(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function getQueryParam(queryString: string | undefined, name: string): string {
  if (!queryString) return '';
  const params = new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString);
  return params.get(name) ?? '';
}

function resolveJsonPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/^\./, '').split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compare(actual: string, operator: MatchOperator, expected: string): boolean {
  if (!expected) return true;
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'regex':
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
    case 'jsonpath': {
      const parsed = tryParseJson(actual);
      if (parsed === undefined) return actual.toLowerCase().includes(expected.toLowerCase());
      const resolved = resolveJsonPath(parsed, expected);
      if (resolved === undefined) return false;
      return String(resolved) === expected.split('.').pop();
    }
    default:
      return actual.toLowerCase().includes(expected.toLowerCase());
  }
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export type { MatchRule };
export function evaluateMatchRule(rule: MatchRule, request: MatchRequest): boolean {
  const operator = rule.operator || 'contains';
  switch (rule.target) {
    case 'url':
      return compare(request.url || `${request.path}${request.queryString || ''}`, operator, rule.value);
    case 'path':
      return compare(request.path, operator, rule.value);
    case 'query':
      return compare(getQueryParam(request.queryString, rule.queryParam ?? ''), operator, rule.value);
    case 'body':
      return compare(bodyText(request.body), operator, rule.value);
    case 'header':
      return compare(headerValue(request.headers, rule.header || ''), operator, rule.value);
    default:
      return true;
  }
}

/** Empty rules mean "always match" (method/path already matched by routing). */
export function matchesAllRules(rules: MatchRule[] | undefined, request: MatchRequest): boolean {
  if (!rules?.length) return true;
  return rules.every((rule) => evaluateMatchRule(rule, request));
}

export function bodyContainsRule(value: string): MatchRule {
  return { target: 'body', operator: 'contains', value };
}

export function urlContainsRule(value: string): MatchRule {
  return { target: 'url', operator: 'contains', value };
}

export function pathContainsRule(value: string): MatchRule {
  return { target: 'path', operator: 'contains', value };
}

export function queryEqualsRule(name: string, value: string): MatchRule {
  return { target: 'query', operator: 'equals', value, queryParam: name };
}

export function bodyRegexRule(pattern: string): MatchRule {
  return { target: 'body', operator: 'regex', value: pattern };
}

export function rulesFromShortcuts(input: {
  bodyContains?: string;
  urlContains?: string;
  pathContains?: string;
}): MatchRule[] {
  const rules: MatchRule[] = [];
  if (input.bodyContains?.trim()) rules.push(bodyContainsRule(input.bodyContains.trim()));
  if (input.urlContains?.trim()) rules.push(urlContainsRule(input.urlContains.trim()));
  if (input.pathContains?.trim()) rules.push(pathContainsRule(input.pathContains.trim()));
  return rules;
}

export function shortcutFromRules(rules: MatchRule[] | undefined): {
  bodyContains: string;
  urlContains: string;
  pathContains: string;
} {
  const list = rules ?? [];
  return {
    bodyContains: list.find((rule) => rule.target === 'body' && rule.operator === 'contains')?.value ?? '',
    urlContains: list.find((rule) => rule.target === 'url' && rule.operator === 'contains')?.value ?? '',
    pathContains: list.find((rule) => rule.target === 'path' && rule.operator === 'contains')?.value ?? ''
  };
}
