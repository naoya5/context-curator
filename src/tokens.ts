// tokens.ts — token estimation (DESIGN.md §4.3)
// estimateTokens(text) = ceil(asciiChars / 3.7 + nonAsciiChars / 1.8)

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      ascii++;
    } else {
      nonAscii++;
    }
  }
  return Math.ceil(ascii / 3.7 + nonAscii / 1.8);
}
