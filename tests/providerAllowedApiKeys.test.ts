import { describe, expect, test } from 'bun:test';
import { buildOpenAIConfig } from '@/features/providers/useProviderWorkbench';
import type { ProviderEntryFormInput } from '@/features/providers/types';

const input = (allowedApiKeys: string[]): ProviderEntryFormInput => ({
  apiKey: '',
  name: 'router',
  baseUrl: 'https://upstream.example/v1',
  proxyUrl: '',
  prefix: '',
  disabled: false,
  models: [],
  headers: [],
  excludedModelsText: '',
  apiKeyEntries: [],
  allowedApiKeys,
});

describe('OpenAI-compatible allowed API key serialization', () => {
  test('serializes normalized client keys under allowed-api-keys', () => {
    const config = buildOpenAIConfig(input([' client-A ', 'client-B']));
    expect(config.allowedApiKeys).toEqual(['client-A', 'client-B']);
  });

  test('serializes an empty list for global access', () => {
    const config = buildOpenAIConfig(input([]));
    expect(config.allowedApiKeys).toEqual([]);
  });
});
