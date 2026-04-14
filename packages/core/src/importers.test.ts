import { describe, expect, it } from 'vitest';
import { parseCurlCommand } from './importers/curl.ts';

describe('importers', () => {
  it('parses a cURL command into a draft', async () => {
    const draft = await parseCurlCommand('curl -X POST https://example.com/api/users -H "x-test: yes" -d \'{"name":"A"}\'');
    expect(draft.sourceType).toBe('curl');
    expect(draft.endpoints).toHaveLength(1);
    expect(draft.endpoints[0].method).toBe('POST');
    expect(draft.endpoints[0].path).toBe('/api/users');
  });
});
