import { describe, expect, it } from 'vitest';
import {
  matchesAllRules,
  bodyContainsRule,
  urlContainsRule,
  queryEqualsRule,
  bodyRegexRule,
  evaluateMatchRule
} from './match-rules.ts';
import type { MatchRule, MatchRequest } from './match-rules.ts';

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

  describe('regex operator', () => {
    it('matches regex on body', () => {
      const ok = matchesAllRules([bodyRegexRule('Get[A-Za-z]+Recommendations')], {
        method: 'POST',
        url: '/gateway/graphql',
        path: '/gateway/graphql',
        body: { operationName: 'GetCompleteTheLookGMRecommendations' }
      });
      expect(ok).toBe(true);
    });

    it('rejects when regex does not match', () => {
      const ok = matchesAllRules([bodyRegexRule('^Get[A-Z]+$')], {
        method: 'POST',
        url: '/gateway/graphql',
        path: '/gateway/graphql',
        body: 'getProducts'
      });
      expect(ok).toBe(false);
    });

    it('handles invalid regex gracefully', () => {
      const ok = matchesAllRules([bodyRegexRule('[')], {
        method: 'GET',
        url: '/test',
        path: '/test',
        body: 'anything'
      });
      expect(ok).toBe(false);
    });
  });

  describe('equals operator', () => {
    it('matches exact body text', () => {
      const rule: MatchRule = { target: 'body', operator: 'equals', value: 'hello' };
      const ok = matchesAllRules([rule], {
        method: 'POST',
        url: '/test',
        path: '/test',
        body: 'hello'
      });
      expect(ok).toBe(true);
    });

    it('rejects case difference with equals', () => {
      const rule: MatchRule = { target: 'body', operator: 'equals', value: 'Hello' };
      const ok = matchesAllRules([rule], {
        method: 'POST',
        url: '/test',
        path: '/test',
        body: 'hello'
      });
      expect(ok).toBe(false);
    });
  });

  describe('query target', () => {
    it('matches query parameter by name', () => {
      const ok = matchesAllRules([queryEqualsRule('page', '2')], {
        method: 'GET',
        url: '/users?page=2&limit=10',
        path: '/users',
        queryString: '?page=2&limit=10'
      });
      expect(ok).toBe(true);
    });

    it('rejects query parameter mismatch', () => {
      const ok = matchesAllRules([queryEqualsRule('page', '3')], {
        method: 'GET',
        url: '/users?page=2',
        path: '/users',
        queryString: '?page=2'
      });
      expect(ok).toBe(false);
    });

    it('returns false for missing query param', () => {
      const ok = matchesAllRules([queryEqualsRule('sort', 'asc')], {
        method: 'GET',
        url: '/users',
        path: '/users',
        queryString: ''
      });
      expect(ok).toBe(false);
    });
  });

  describe('empty rules', () => {
    it('always match when rules is undefined', () => {
      expect(matchesAllRules(undefined, { method: 'GET', url: '/', path: '/' })).toBe(true);
    });

    it('always match when rules is empty array', () => {
      expect(matchesAllRules([], { method: 'GET', url: '/', path: '/' })).toBe(true);
    });
  });

  describe('AND logic', () => {
    it('passes when all rules match', () => {
      const rules: MatchRule[] = [
        bodyContainsRule('GetProducts'),
        { target: 'url', operator: 'contains', value: '/graphql' }
      ];
      const ok = matchesAllRules(rules, {
        method: 'POST',
        url: '/gateway/graphql',
        path: '/gateway/graphql',
        body: { operationName: 'GetProducts' }
      });
      expect(ok).toBe(true);
    });

    it('fails when one rule does not match', () => {
      const rules: MatchRule[] = [
        bodyContainsRule('GetProducts'),
        { target: 'url', operator: 'contains', value: '/rest' }
      ];
      const ok = matchesAllRules(rules, {
        method: 'POST',
        url: '/gateway/graphql',
        path: '/gateway/graphql',
        body: { operationName: 'GetProducts' }
      });
      expect(ok).toBe(false);
    });
  });
});
