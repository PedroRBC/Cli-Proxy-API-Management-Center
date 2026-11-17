import { describe, expect, test } from 'bun:test';
import { serializeOpenAIProvider } from '@/services/api/providers';
import { normalizeOpenAIProvider } from '@/services/api/transformers';

describe('allowed-api-keys Management API mapping', () => {
  test('serializes the exact v8 kebab-case field', () => {
    const payload = serializeOpenAIProvider({
      name: 'router',
      baseUrl: 'https://upstream.example/v1',
      apiKeyEntries: [],
      allowedApiKeys: ['client-a'],
    });
    expect(payload['allowed-api-keys']).toEqual(['client-a']);
    expect(payload.allowedApiKeys).toBeUndefined();
  });

  test('hydrates the exact backend field', () => {
    const config = normalizeOpenAIProvider({
      name: 'router',
      'base-url': 'https://upstream.example/v1',
      keys: [],
      'allowed-api-keys': ['client-a'],
    });
    expect(config?.allowedApiKeys).toEqual(['client-a']);
  });
});
