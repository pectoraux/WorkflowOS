/**
 * V2-003 — strict JSON parser.
 *
 * Deserialization must fail closed on AMBIGUOUS wire documents: standard
 * JSON.parse silently accepts duplicate object keys (last one wins) and
 * rejects nothing else until trailing content. This parser additionally:
 * - rejects duplicate keys at any nesting level (ambiguous IR);
 * - rejects trailing content after the top-level document;
 * - enforces the exact JSON grammar.
 *
 * Value decoding (string escapes, number conversion) is delegated to the
 * built-in decoders on the exact raw token slices so escape/surrogate/number
 * semantics match the platform exactly.
 */

const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/** Parse `text` strictly; throws on invalid JSON, duplicate keys or trailing content. */
export function parseStrictJson(text: string): unknown {
  const parser = new StrictParser(text);
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) {
    parser.fail(`trailing content after JSON document at position ${parser.position()}`);
  }
  return value;
}

class StrictParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  position(): number {
    return this.pos;
  }

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  skipWhitespace(): void {
    while (!this.atEnd() && JSON_WHITESPACE.has(this.peek())) this.pos += 1;
  }

  fail(message: string): never {
    throw new Error(message);
  }

  private peek(): string {
    const ch = this.text[this.pos];
    if (ch === undefined) this.fail(`unexpected end of input at position ${this.pos}`);
    return ch;
  }

  parseValue(): unknown {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"') return this.parseString();
    if (ch === 't') return this.parseKeyword('true', true as unknown);
    if (ch === 'f') return this.parseKeyword('false', false as unknown);
    if (ch === 'n') return this.parseKeyword('null', null);
    return this.parseNumber();
  }

  private parseObject(): Record<string, unknown> {
    this.pos += 1; // consume '{'
    const result: Record<string, unknown> = {};
    const seenKeys = new Set<string>();
    this.skipWhitespace();
    if (!this.atEnd() && this.peek() === '}') {
      this.pos += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.atEnd() || this.peek() !== '"') {
        this.fail(`expected object key at position ${this.pos}`);
      }
      const key = this.parseString();
      if (seenKeys.has(key)) {
        this.fail(`duplicate object key "${key}" at position ${this.pos}`);
      }
      seenKeys.add(key);
      this.skipWhitespace();
      if (this.atEnd() || this.peek() !== ':') {
        this.fail(`expected ':' after object key at position ${this.pos}`);
      }
      this.pos += 1;
      const value = this.parseValue();
      result[key] = value;
      this.skipWhitespace();
      if (this.atEnd()) this.fail(`unterminated object at position ${this.pos}`);
      const ch = this.peek();
      if (ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '}') {
        this.pos += 1;
        return result;
      }
      this.fail(`expected ',' or '}' in object at position ${this.pos}`);
    }
  }

  private parseArray(): unknown[] {
    this.pos += 1; // consume '['
    const result: unknown[] = [];
    this.skipWhitespace();
    if (!this.atEnd() && this.peek() === ']') {
      this.pos += 1;
      return result;
    }
    for (;;) {
      const value = this.parseValue();
      result.push(value);
      this.skipWhitespace();
      if (this.atEnd()) this.fail(`unterminated array at position ${this.pos}`);
      const ch = this.peek();
      if (ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === ']') {
        this.pos += 1;
        return result;
      }
      this.fail(`expected ',' or ']' in array at position ${this.pos}`);
    }
  }

  private parseString(): string {
    const start = this.pos;
    this.pos += 1; // consume opening '"'
    for (;;) {
      if (this.atEnd()) this.fail(`unterminated string at position ${start}`);
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos += 1;
        const raw = this.text.slice(start, this.pos);
        return JSON.parse(raw) as string;
      }
      if (ch === '\\') {
        this.pos += 2; // skip the escape and the escaped character
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        this.fail(`unescaped control character in string at position ${this.pos}`);
      }
      this.pos += 1;
    }
  }

  private parseNumber(): number {
    const rest = this.text.slice(this.pos);
    const match = JSON_NUMBER_PATTERN.exec(rest);
    if (match === null || match[0].length === 0) {
      this.fail(`invalid number at position ${this.pos}`);
    }
    const raw = match[0];
    this.pos += raw.length;
    return Number(raw);
  }

  private parseKeyword(keyword: string, value: unknown): unknown {
    if (!this.text.startsWith(keyword, this.pos)) {
      this.fail(`invalid literal at position ${this.pos}`);
    }
    this.pos += keyword.length;
    return value;
  }
}
