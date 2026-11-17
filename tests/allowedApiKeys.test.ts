import { describe, expect, test } from 'bun:test';
import {
  normalizeAllowedApiKeys,
  validateAllowedApiKeys,
} from '@/features/providers/allowedApiKeys';

describe('allowed API keys', () => {
  test('normalizes whitespace while preserving accepted casing', () => {
    expect(normalizeAllowedApiKeys([' Client-A ', 'client-B'])).toEqual(['Client-A', 'client-B']);
  });

  test('rejects blank and case-insensitive duplicate values', () => {
    expect(validateAllowedApiKeys(['client-a', '  '])).toBe('blank');
    expect(validateAllowedApiKeys(['Client-A', 'client-a'])).toBe('duplicate');
  });

  test('accepts an empty list for global access', () => {
    expect(validateAllowedApiKeys([])).toBeNull();
    expect(normalizeAllowedApiKeys([])).toEqual([]);
  });
});
