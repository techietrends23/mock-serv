import SwaggerParser from '@apidevtools/swagger-parser';
import YAML from 'yaml';
import type { MockDraft, MockEndpoint } from '../types.ts';
import { inferNameFromMethodAndPath, normalizePathPattern } from '../utils.ts';

function firstObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function responseSchemaFromOperation(operation: Record<string, unknown>): { schema?: unknown; example?: unknown; statusCode: number } {
  const responses = firstObject(operation.responses) ?? {};
  const statusKey = Object.keys(responses).find((key) => key.startsWith('2')) || '200';
  const chosen = firstObject(responses[statusKey]) ?? {};
  const content = firstObject(chosen.content) ?? {};
  const json = firstObject(content['application/json']) ?? firstObject(content['application/*+json']) ?? {};
  const schema = json.schema;
  const example = json.example ?? json.examples;
  return {
    schema,
    example,
    statusCode: Number.parseInt(statusKey, 10) || 200
  };
}

export async function parseOpenApiDocument(content: string): Promise<MockDraft> {
  const raw = YAML.parse(content) as Record<string, unknown>;
  const doc = (await SwaggerParser.dereference(raw as never)) as Record<string, unknown>;
  const paths = firstObject(doc.paths) ?? {};
  const endpoints: Omit<MockEndpoint, 'id' | 'mockId' | 'tableName' | 'orderIndex'>[] = [];

  for (const [path, operationsValue] of Object.entries(paths)) {
    const operations = firstObject(operationsValue) ?? {};
    for (const [method, operationValue] of Object.entries(operations)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      const operation = firstObject(operationValue) ?? {};
      const responseMeta = responseSchemaFromOperation(operation);
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const pathParameters = parameters
        .filter((param) => firstObject(param)?.in === 'path')
        .map((param) => {
          const typed = firstObject(param) ?? {};
          return {
            name: String(typed.name ?? 'id'),
            required: Boolean(typed.required ?? true),
            schema: typed.schema ?? undefined
          };
        });
      const queryParameters = parameters
        .filter((param) => firstObject(param)?.in === 'query')
        .map((param) => {
          const typed = firstObject(param) ?? {};
          return {
            name: String(typed.name ?? 'query'),
            required: Boolean(typed.required ?? false),
            schema: typed.schema ?? undefined
          };
        });
      const requestBody = firstObject(operation.requestBody) ?? {};
      const contentMap = firstObject(requestBody.content) ?? {};
      const jsonBody = firstObject(contentMap['application/json']) ?? {};

      endpoints.push({
        name: inferNameFromMethodAndPath(method.toUpperCase(), path),
        method: method.toUpperCase(),
        path: normalizePathPattern(path),
        summary: typeof operation.summary === 'string' ? operation.summary : undefined,
        description: typeof operation.description === 'string' ? operation.description : undefined,
        requestHeaders: {},
        pathParameters,
        queryParameters,
        requestBodySchema: jsonBody.schema ?? undefined,
        responseSchema: responseMeta.schema ?? undefined,
        responseExample: responseMeta.example,
        statusCode: responseMeta.statusCode,
        latencyMs: 0,
        errorRate: 0
      });
    }
  }

  return {
    name: String(doc.info && typeof doc.info === 'object' ? (doc.info as Record<string, unknown>).title ?? 'openapi-mock' : 'openapi-mock'),
    protocol: 'rest',
    description: String(doc.info && typeof doc.info === 'object' ? (doc.info as Record<string, unknown>).description ?? '' : ''),
    sourceType: 'openapi',
    endpoints
  };
}
