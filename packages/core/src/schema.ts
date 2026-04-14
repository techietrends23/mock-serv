import { GraphQLScalarType, Kind } from 'graphql';
import type { JsonSchemaLike, MockDefinition, MockEndpoint } from './types.ts';
import { inferNameFromMethodAndPath, isCollectionPath, pathToName, sampleFromSchema, sanitizeIdentifier } from './utils.ts';

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral(ast) {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.OBJECT: {
        const value: Record<string, unknown> = {};
        for (const field of ast.fields) {
          value[field.name.value] = (field.value.kind === Kind.STRING ? field.value.value : undefined) as unknown;
        }
        return value;
      }
      case Kind.LIST:
        return ast.values.map((item) => (item.kind === Kind.STRING ? item.value : null));
      case Kind.NULL:
        return null;
      default:
        return null;
    }
  }
});

export interface GeneratedGraphQLField {
  name: string;
  kind: 'query' | 'mutation';
  isList: boolean;
  endpointId: string;
  tableName: string;
  method: string;
  path: string;
}

export interface GraphQLArtifacts {
  typeDefs: string;
  resolvers: Record<string, unknown>;
  fields: GeneratedGraphQLField[];
}

export function ensureEndpointTableName(mockName: string, endpoint: Pick<MockEndpoint, 'method' | 'path' | 'tableName'>): string {
  return endpoint.tableName || sanitizeIdentifier(`mock_${mockName}_${endpoint.method}_${endpoint.path}`).toLowerCase();
}

export function buildEndpointArtifacts(mock: MockDefinition): GraphQLArtifacts {
  const fields: GeneratedGraphQLField[] = [];
  const queryLines: string[] = [];
  const mutationLines: string[] = [];
  const queryResolvers: Record<
    string,
    (parent: unknown, args: Record<string, unknown>, ctx: { repository: any; mock: MockDefinition }) => unknown
  > = {};
  const mutationResolvers: Record<
    string,
    (parent: unknown, args: Record<string, unknown>, ctx: { repository: any; mock: MockDefinition }) => unknown
  > = {};

  for (const endpoint of mock.endpoints) {
    const baseName = sanitizeIdentifier(endpoint.name || inferNameFromMethodAndPath(endpoint.method, endpoint.path));
    const isList = endpoint.method.toUpperCase() === 'GET' && isCollectionPath(endpoint.path);
    const fieldName =
      endpoint.method.toUpperCase() === 'GET'
        ? baseName
        : `${baseName}_${endpoint.method.toLowerCase()}`;
    const args = isList
      ? ''
      : endpoint.pathParameters.length
        ? endpoint.pathParameters.map((param) => `${sanitizeIdentifier(param.name)}: ID!`).join(', ')
        : 'id: ID!';

    if (endpoint.method.toUpperCase() === 'GET') {
      fields.push({
        name: fieldName,
        kind: 'query',
        isList,
        endpointId: endpoint.id,
        tableName: endpoint.tableName,
        method: endpoint.method,
        path: endpoint.path
      });
      queryLines.push(`  ${fieldName}${args ? `(${args})` : ''}: ${isList ? '[JSON!]!' : 'JSON'}`);
      queryResolvers[fieldName] = async (_parent, argsObj, ctx) => {
        const records: Array<{ id: string; data: unknown }> = await ctx.repository.listRowsByEndpointId(endpoint.mockId, endpoint.id);
        if (isList) return records.map((row) => row.data);
        const identifier = String(argsObj.id || Object.values(argsObj)[0] || '');
        const row = records.find((candidate) => candidate.id === identifier);
        return row?.data ?? sampleFromSchema(endpoint.responseSchema ?? { type: 'object' });
      };
    } else {
      fields.push({
        name: fieldName,
        kind: 'mutation',
        isList: false,
        endpointId: endpoint.id,
        tableName: endpoint.tableName,
        method: endpoint.method,
        path: endpoint.path
      });
      const inputLine = endpoint.requestBodySchema ? 'input: JSON!' : 'input: JSON';
      mutationLines.push(`  ${fieldName}(${args ? `${args}, ` : ''}${inputLine}): JSON`);
      mutationResolvers[fieldName] = async (_parent, argsObj, ctx) => {
        const identifier = String(argsObj.id || argsObj[Object.keys(argsObj).find((key) => key !== 'input') || 'id'] || '');
        const input = (argsObj.input ?? {}) as Record<string, unknown>;
        if (endpoint.method.toUpperCase() === 'POST') {
          return ctx.repository.insertRow(endpoint.mockId, endpoint.id, input, identifier || undefined);
        }
        if (endpoint.method.toUpperCase() === 'PUT' || endpoint.method.toUpperCase() === 'PATCH') {
          return ctx.repository.updateRow(endpoint.mockId, endpoint.id, identifier, input);
        }
        if (endpoint.method.toUpperCase() === 'DELETE') {
          return ctx.repository.deleteRow(endpoint.mockId, endpoint.id, identifier);
        }
        return input;
      };
    }
  }

  const typeDefs = `
    scalar JSON
    type Query {
${queryLines.length ? queryLines.join('\n') : '      _empty: JSON'}
    }
    type Mutation {
${mutationLines.length ? mutationLines.join('\n') : '      _noop(input: JSON): JSON'}
    }
  `;

  return {
    typeDefs,
    resolvers: {
      JSON: JSONScalar,
      Query: queryResolvers,
      Mutation: mutationResolvers
    },
    fields
  };
}

export function inferEndpointDisplayName(endpoint: Pick<MockEndpoint, 'method' | 'path'>): string {
  return sanitizeIdentifier(`${endpoint.method.toLowerCase()}_${pathToName(endpoint.path)}`);
}

export function endpointResponseExample(endpoint: Pick<MockEndpoint, 'responseSchema' | 'responseExample'>): unknown {
  if (endpoint.responseExample !== undefined) return endpoint.responseExample;
  if (endpoint.responseSchema) return sampleFromSchema(endpoint.responseSchema as JsonSchemaLike);
  return { ok: true };
}
