export type MockProtocol = 'rest' | 'graphql';
export type MockSourceType = 'openapi' | 'curl' | 'postman' | 'har';
export type MockStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export type JsonSchemaLike =
  | {
      type?: string;
      title?: string;
      description?: string;
      properties?: Record<string, JsonSchemaLike>;
      required?: string[];
      items?: JsonSchemaLike;
      enum?: unknown[];
      oneOf?: JsonSchemaLike[];
      anyOf?: JsonSchemaLike[];
      allOf?: JsonSchemaLike[];
      example?: unknown;
      default?: unknown;
      format?: string;
      additionalProperties?: boolean | JsonSchemaLike;
    }
  | unknown;

export interface MockEndpoint {
  id: string;
  mockId: string;
  name: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  requestHeaders: Record<string, string>;
  pathParameters: Array<{ name: string; required?: boolean; schema?: JsonSchemaLike }>;
  queryParameters: Array<{ name: string; required?: boolean; schema?: JsonSchemaLike }>;
  requestBodySchema?: JsonSchemaLike;
  responseSchema?: JsonSchemaLike;
  responseExample?: unknown;
  statusCode: number;
  latencyMs: number;
  errorRate: number;
  tableName: string;
  orderIndex: number;
}

export interface MockDefinition {
  id: string;
  name: string;
  protocol: MockProtocol;
  description?: string;
  sourceType: MockSourceType;
  sourceRef?: string;
  port?: number;
  status: MockStatus;
  latencyMs: number;
  errorRate: number;
  graphqlEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  endpoints: MockEndpoint[];
}

export interface MockDraft {
  name: string;
  protocol: MockProtocol;
  description?: string;
  sourceType: MockSourceType;
  sourceRef?: string;
  endpoints: Omit<MockEndpoint, 'id' | 'mockId' | 'tableName' | 'orderIndex'>[];
}

export interface LogEntry {
  id: number;
  mockId?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  payload?: unknown;
  createdAt: string;
}

export interface MockRow {
  id: string;
  data: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface MockSnapshot {
  mock: MockDefinition;
  rowsByEndpoint: Record<string, MockRow[]>;
}
