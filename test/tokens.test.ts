import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../src/tokens.js';

describe('estimateTokens', () => {
  it('empty string → 0 tokens', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('pure ASCII: ceil(n / 3.7)', () => {
    const text = 'hello world'; // 11 chars, all ASCII
    expect(estimateTokens(text)).toBe(Math.ceil(11 / 3.7));
  });

  it('pure non-ASCII (Japanese): ceil(n / 1.8)', () => {
    const text = 'こんにちは'; // 5 non-ASCII chars
    expect(estimateTokens(text)).toBe(Math.ceil(5 / 1.8));
  });

  it('mixed ASCII + non-ASCII', () => {
    const text = 'hello世界'; // 5 ASCII + 2 non-ASCII
    const expected = Math.ceil(5 / 3.7 + 2 / 1.8);
    expect(estimateTokens(text)).toBe(expected);
  });

  it('larger text gives proportional result', () => {
    const text = 'a'.repeat(370); // 100 tokens exactly
    expect(estimateTokens(text)).toBe(100);
  });
});
