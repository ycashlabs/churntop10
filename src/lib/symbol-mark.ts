/** How many CSS tone classes the letter avatar uses. The SVG itself is first-party. */
export const LETTER_TONES = 8;

export function letterMark(symbol: string): { letter: string; tone: number } {
  const cleaned = symbol.trim().toUpperCase();
  const first = cleaned[0];
  const letter = first && /[A-Z0-9]/.test(first) ? first : "?";
  const basis = cleaned || "?";
  let hash = 0;
  for (let i = 0; i < basis.length; i += 1) hash = (hash * 33 + basis.charCodeAt(i)) >>> 0;
  return { letter, tone: hash % LETTER_TONES };
}
