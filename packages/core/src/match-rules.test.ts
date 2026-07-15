import { describe, expect, it } from 'vitest';
import { matchesAllRules, bodyContainsRule, urlContainsRule } from './match-rules.ts';

describe('match rules', () => {
  it('matches body contains for GraphQL operationName', () => {
    const ok = matchesAllRules([bodyContainsRule('GetCompleteTheLookGMRecommendations')], {
      method: 'POST',
      url: '/gateway/graphql',
      path: '/gateway/graphql',
      body: {
        operationName: 'GetCompleteTheLookGMRecommendations',
        query: 'query { getCompleteTheLookGMRecommendations { lookId } }'
      }
    });
    expect(ok).toBe(true);
  });

  it('rejects other GraphQL operations', () => {
    const ok = matchesAllRules([bodyContainsRule('GetCompleteTheLookGMRecommendations')], {
      method: 'POST',
      url: '/gateway/graphql',
      path: '/gateway/graphql',
      body: { operationName: 'GetProductPage', query: 'query { product { id } }' }
    });
    expect(ok).toBe(false);
  });

  it('matches url contains', () => {
    const ok = matchesAllRules([urlContainsRule('/gateway/graphql')], {
      method: 'POST',
      url: '/gateway/graphql?x=1',
      path: '/gateway/graphql'
    });
    expect(ok).toBe(true);
  });
});
