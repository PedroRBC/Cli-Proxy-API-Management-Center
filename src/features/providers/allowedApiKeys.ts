export type AllowedApiKeysValidationError = 'blank' | 'duplicate';

export const normalizeAllowedApiKeys = (values: string[]): string[] =>
  values.map((value) => value.trim()).filter(Boolean);

export const validateAllowedApiKeys = (values: string[]): AllowedApiKeysValidationError | null => {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) return 'blank';
    const comparison = normalized.toLocaleLowerCase();
    if (seen.has(comparison)) return 'duplicate';
    seen.add(comparison);
  }
  return null;
};
