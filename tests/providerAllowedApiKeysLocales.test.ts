import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko', 'tr'];
const requiredKeys = [
  'allowedApiKeysSection',
  'allowedApiKeysHint',
  'allowedApiKeysGlobal',
  'allowedApiKeysRestricted',
  'allowedApiKey',
  'allowedApiKeyPlaceholder',
  'showAllowedApiKey',
  'hideAllowedApiKey',
  'removeAllowedApiKey',
  'addAllowedApiKey',
  'allowedApiKeyBlank',
  'allowedApiKeyDuplicate',
];

describe('allowed API key translations', () => {
  test('all supported locales contain the new provider form strings', () => {
    for (const locale of locales) {
      const source = readFileSync(`src/i18n/locales/${locale}.json`, 'utf8');
      for (const key of requiredKeys) expect(source).toContain(`"${key}"`);
    }
  });
});
