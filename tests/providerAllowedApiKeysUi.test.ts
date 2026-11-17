import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('allowed API key provider form UI', () => {
  test('keeps client restrictions separate from upstream credentials and masks values', () => {
    const source = readFileSync('src/features/providers/sheets/forms/AllowedApiKeysEditor.tsx', 'utf8');
    const form = readFileSync('src/features/providers/sheets/forms/BaseProviderForm.tsx', 'utf8');
    expect(source).toContain('type={isVisible ? \'text\' : \'password\'}');
    expect(source).toContain('addAllowedApiKey');
    expect(source).toContain('removeAllowedApiKey');
    expect(form).toContain('supportsAllowedApiKeys');
    expect(form).toContain('apiKeyEntriesSection');
    expect(form).toContain('allowedApiKeysSection');
  });
});
