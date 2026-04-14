import type { MockDraft, MockEndpoint } from '../types.ts';
import { inferNameFromMethodAndPath, normalizePathPattern, toJsonSchemaLike } from '../utils.ts';

function tokenizeCurl(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const prev = command[index - 1];
    if ((char === '"' || char === "'") && prev !== '\\') {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      } else {
        current += char;
      }
      continue;
    }
    if (char === ' ' && !quote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function firstUrl(tokens: string[]): string | undefined {
  return tokens.find((token) => /^https?:\/\//i.test(token));
}

export async function parseCurlCommand(command: string): Promise<MockDraft> {
  const tokens = tokenizeCurl(command.replace(/\\\n/g, ' '));
  const method = (tokens.includes('-X') ? tokens[tokens.indexOf('-X') + 1] : 'GET').toUpperCase();
  const url = firstUrl(tokens);
  const headers: Record<string, string> = {};
  let body: unknown;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-H' || token === '--header') {
      const value = tokens[index + 1];
      const separator = value.indexOf(':');
      if (separator > -1) {
        headers[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
      }
      index += 1;
    }
    if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary') {
      const value = tokens[index + 1];
      try {
        body = JSON.parse(value);
      } catch {
        body = value;
      }
      index += 1;
    }
  }

  const parsed = url ? new URL(url) : new URL('http://localhost/');
  const path = normalizePathPattern(parsed.pathname || '/');
  const endpoint: Omit<MockEndpoint, 'id' | 'mockId' | 'tableName' | 'orderIndex'> = {
    name: inferNameFromMethodAndPath(method, path),
    method,
    path,
    summary: 'Imported from cURL',
    requestHeaders: headers,
    pathParameters: [],
    queryParameters: Array.from(parsed.searchParams.keys()).map((name) => ({ name })),
    requestBodySchema: body !== undefined ? toJsonSchemaLike(body) : undefined,
    responseSchema: undefined,
    responseExample: undefined,
    statusCode: 200,
    latencyMs: 0,
    errorRate: 0
  };

  return {
    name: `curl_${path.replace(/\//g, '_').replace(/[:{}]/g, '') || 'root'}`,
    protocol: 'rest',
    sourceType: 'curl',
    sourceRef: command,
    endpoints: [endpoint]
  };
}
