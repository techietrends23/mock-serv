export type MockProtocol = 'rest' | 'graphql';
export type MockSourceType = 'openapi' | 'curl' | 'postman' | 'har';
export type MockStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export type MatchTarget = 'url' | 'path' | 'body' | 'header';
export type MatchOperator = 'contains' | 'equals';

/** Mockoon-style response rule: mock only when request matches. */
export interface MatchRule {
  target: MatchTarget;
  operator: MatchOperator;
  value: string;
  /** Required when target is `header`. */
  header?: string;
}

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
  /** When set, all rules must match (AND). Empty = any request to method+path. */
  matchRules?: MatchRule[];
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
  /**
   * Mockoon-style proxy mode: requests that do not match any endpoint rule
   * are forwarded to proxyUrl (or sourceRef origin).
   */
  proxyEnabled?: boolean;
  proxyUrl?: string;
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

export type CaptureStatus = 'idle' | 'starting' | 'running' | 'stopped';

export interface CaptureSession {
  id: string;
  name: string;
  proxyPort?: number;
  status: CaptureStatus;
  createdAt: string;
  updatedAt: string;
  callCount: number;
}

export interface CapturedCall {
  id: string;
  sessionId: string;
  method: string;
  url: string;
  host: string;
  path: string;
  queryString: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  contentType: string;
  durationMs: number;
  timestamp: string;
}
