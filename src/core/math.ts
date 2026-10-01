/**
 * Evaluate a tiny arithmetic expression ("1920/2", "45 + 10", "-(3*4)").
 * Recursive descent over + - * / and parentheses; returns NaN on bad input.
 * Used by numeric fields so users can type quick calculations.
 */
export function evalMath(src: string): number {
  let i = 0;
  const s = src.replace(/\s+/g, '');
  const peek = () => s[i];
  function num(): number {
    const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error('number');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor(): number {
    if (peek() === '-') {
      i++;
      return -factor();
    }
    if (peek() === '+') {
      i++;
      return factor();
    }
    if (peek() === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') throw new Error(')');
      i++;
      return v;
    }
    return num();
  }
  function term(): number {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  try {
    if (!s) return NaN;
    const v = expr();
    return i === s.length ? v : NaN;
  } catch {
    return NaN;
  }
}
