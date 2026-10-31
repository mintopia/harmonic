export class ExpressionError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

export type Value = string | number | boolean | null | readonly Value[] | { readonly [key: string]: Value };

type Node =
  | { kind: 'lit'; value: string | number | boolean | null }
  | { kind: 'ref'; path: string[]; offset: number }
  | { kind: 'not'; operand: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[]; offset: number };

interface Token {
  type: 'num' | 'str' | 'id' | 'op' | 'end';
  text: string;
  offset: number;
}

const MAX_EXPRESSION_LENGTH = 2000;
const MAX_DEPTH = 32;
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')', ',', '.'];
const FUNCTIONS: Record<string, (args: Value[]) => Value> = {
  contains: ([haystack, needle]) => {
    if (Array.isArray(haystack)) return haystack.some((item) => looseEquals(item, needle ?? null));
    return typeof haystack === 'string' && typeof needle === 'string' ? haystack.toLowerCase().includes(needle.toLowerCase()) : false;
  },
  startsWith: ([text, prefix]) => (typeof text === 'string' && typeof prefix === 'string' ? text.toLowerCase().startsWith(prefix.toLowerCase()) : false),
  format: ([template, ...rest]) => {
    if (typeof template !== 'string') return '';
    return template.replace(/\{(\d+)\}/g, (whole, index: string) => (Number(index) < rest.length ? stringify(rest[Number(index)] ?? null) : whole));
  },
};

function tokenize(src: string): Token[] {
  if (src.length > MAX_EXPRESSION_LENGTH) throw new ExpressionError(`expression is longer than ${MAX_EXPRESSION_LENGTH} characters`, 0);
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === "'") {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= src.length) throw new ExpressionError('unterminated string', i);
        if (src[j] === "'") {
          if (src[j + 1] !== "'") break;
          text += "'";
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      tokens.push({ type: 'str', text, offset: i });
      i = j + 1;
    } else if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ type: 'num', text: match[0], offset: i });
      i += match[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))!;
      tokens.push({ type: 'id', text: match[0], offset: i });
      i += match[0].length;
    } else {
      const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
      if (op === undefined) throw new ExpressionError(`unexpected character '${ch}'`, i);
      tokens.push({ type: 'op', text: op, offset: i });
      i += op.length;
    }
  }
  tokens.push({ type: 'end', text: '', offset: src.length });
  return tokens;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.or();
    const next = this.peek();
    if (next.type !== 'end') throw new ExpressionError(`unexpected '${next.text}'`, next.offset);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private accept(...ops: string[]): Token | undefined {
    const token = this.peek();
    if (token.type === 'op' && ops.includes(token.text)) {
      this.pos += 1;
      return token;
    }
    return undefined;
  }

  private binary(next: () => Node, ...ops: string[]): Node {
    let left = next();
    for (let token = this.accept(...ops); token; token = this.accept(...ops)) left = { kind: 'bin', op: token.text, left, right: next() };
    return left;
  }

  private or(): Node {
    return this.binary(() => this.and(), '||');
  }
  private and(): Node {
    return this.binary(() => this.equality(), '&&');
  }
  private equality(): Node {
    return this.binary(() => this.comparison(), '==', '!=');
  }
  private comparison(): Node {
    return this.binary(() => this.unary(), '<', '<=', '>', '>=');
  }

  private unary(): Node {
    if (this.accept('!')) {
      this.enter();
      const operand = this.unary();
      this.depth -= 1;
      return { kind: 'not', operand };
    }
    return this.primary();
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new ExpressionError('expression is nested too deeply', this.peek().offset);
  }

  private primary(): Node {
    const token = this.peek();
    if (this.accept('(')) {
      this.enter();
      const inner = this.or();
      this.depth -= 1;
      if (!this.accept(')')) throw new ExpressionError("expected ')'", this.peek().offset);
      return inner;
    }
    this.pos += 1;
    if (token.type === 'num') return { kind: 'lit', value: Number(token.text) };
    if (token.type === 'str') return { kind: 'lit', value: token.text };
    if (token.type === 'id') return this.identifier(token);
    throw new ExpressionError(token.type === 'end' ? 'unexpected end of expression' : `unexpected '${token.text}'`, token.offset);
  }

  private identifier(first: Token): Node {
    if (first.text === 'true' || first.text === 'false') return { kind: 'lit', value: first.text === 'true' };
    if (first.text === 'null') return { kind: 'lit', value: null };
    if (this.accept('(')) {
      if (!Object.hasOwn(FUNCTIONS, first.text)) throw new ExpressionError(`unknown function '${first.text}'`, first.offset);
      const args: Node[] = [];
      if (!this.accept(')')) {
        do {
          this.enter();
          args.push(this.or());
          this.depth -= 1;
        } while (this.accept(','));
        if (!this.accept(')')) throw new ExpressionError("expected ')'", this.peek().offset);
      }
      return { kind: 'call', name: first.text, args, offset: first.offset };
    }
    const path = [first.text];
    while (this.accept('.')) {
      const part = this.peek();
      if (part.type !== 'id') throw new ExpressionError('expected a name after .', part.offset);
      this.pos += 1;
      path.push(part.text);
    }
    return { kind: 'ref', path, offset: first.offset };
  }
}

export interface ExpressionRef {
  path: string[];
  offset: number;
}

export interface ParsedExpression {
  readonly node: unknown;
  readonly refs: ExpressionRef[];
}

/** Parses one expression body (without the `${{ }}` delimiters); throws ExpressionError with the offending offset. */
export function parseExpression(src: string): ParsedExpression {
  const node = new Parser(tokenize(src)).parse();
  const refs: ExpressionRef[] = [];
  const walk = (n: Node): void => {
    if (n.kind === 'ref') refs.push({ path: n.path, offset: n.offset });
    else if (n.kind === 'not') walk(n.operand);
    else if (n.kind === 'bin') {
      walk(n.left);
      walk(n.right);
    }
    else if (n.kind === 'call') n.args.forEach(walk);
  };
  walk(node);
  return { node, refs };
}

export type ExpressionContext = { readonly [root: string]: Value };

function lookup(context: ExpressionContext, path: string[]): Value {
  let current: Value | undefined = context;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return null;
    current = (current as { readonly [key: string]: Value })[key];
  }
  return current ?? null;
}

function stringify(value: Value): string {
  if (value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function looseEquals(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b || a === null || b === null) return a === b;
  const left = typeof a === 'object' ? NaN : Number(a);
  const right = typeof b === 'object' ? NaN : Number(b);
  return left === right;
}

export function truthy(value: Value): boolean {
  return !(value === null || value === false || value === 0 || value === '' || (typeof value === 'number' && Number.isNaN(value)));
}

function compare(op: string, a: Value, b: Value): boolean {
  const bothText = typeof a === 'string' && typeof b === 'string';
  const left = bothText ? a.toLowerCase() : typeof a === 'object' && a !== null ? NaN : Number(a);
  const right = bothText ? b.toLowerCase() : typeof b === 'object' && b !== null ? NaN : Number(b);
  if (op === '<') return left < right;
  if (op === '<=') return left <= right;
  if (op === '>') return left > right;
  return left >= right;
}

function run(node: Node, context: ExpressionContext): Value {
  switch (node.kind) {
    case 'lit':
      return node.value;
    case 'ref':
      return lookup(context, node.path);
    case 'not':
      return !truthy(run(node.operand, context));
    case 'call':
      return FUNCTIONS[node.name]!(node.args.map((arg) => run(arg, context)));
    case 'bin': {
      if (node.op === '&&') {
        const left = run(node.left, context);
        return truthy(left) ? run(node.right, context) : left;
      }
      if (node.op === '||') {
        const left = run(node.left, context);
        return truthy(left) ? left : run(node.right, context);
      }
      const left = run(node.left, context);
      const right = run(node.right, context);
      if (node.op === '==') return looseEquals(left, right);
      if (node.op === '!=') return !looseEquals(left, right);
      return compare(node.op, left, right);
    }
  }
}

/** Evaluates a parsed expression; unknown references read as null. */
export function evaluateParsed(parsed: ParsedExpression, context: ExpressionContext): Value {
  return run(parsed.node as Node, context);
}

/** Parses and evaluates a bare expression; a parse or evaluation fault throws ExpressionError. */
export function evaluateExpression(src: string, context: ExpressionContext): Value {
  try {
    return evaluateParsed(parseExpression(src), context);
  } catch (error) {
    if (error instanceof ExpressionError) throw error;
    throw new ExpressionError('expression could not be evaluated', 0);
  }
}

export interface Interpolation {
  /** The expression text between the delimiters, trimmed. */
  source: string;
  /** Offset of the first non-space character of `source` within the whole string. */
  offset: number;
  start: number;
  end: number;
}

/** Finds every `${{ ... }}` span in a string. */
export function findInterpolations(text: string): Interpolation[] {
  const found: Interpolation[] = [];
  const pattern = /\$\{\{([\s\S]*?)\}\}/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const inner = match[1]!;
    const lead = inner.length - inner.trimStart().length;
    found.push({ source: inner.trim(), offset: match.index + 3 + lead, start: match.index, end: match.index + match[0].length });
  }
  return found;
}

/** Replaces each `${{ }}` span with its stringified value. */
export function interpolate(text: string, context: ExpressionContext, render: (value: string) => string = (value) => value): string {
  let out = '';
  let last = 0;
  for (const span of findInterpolations(text)) {
    out += text.slice(last, span.start) + render(stringify(evaluateExpression(span.source, context)));
    last = span.end;
  }
  return out + text.slice(last);
}

/** Evaluates an `if:` value: a bare expression, or one wrapped in a single `${{ }}`. */
export function evaluateCondition(text: string, context: ExpressionContext): boolean {
  return truthy(evaluateExpression(conditionBody(text).source, context));
}

export function conditionBody(text: string): { source: string; offset: number } {
  const spans = findInterpolations(text);
  const only = spans.length === 1 && spans[0]!.start === text.search(/\S/) && text.trimEnd().length === spans[0]!.end ? spans[0] : undefined;
  if (only) return { source: only.source, offset: only.offset };
  return { source: text.trim(), offset: text.length - text.trimStart().length };
}
