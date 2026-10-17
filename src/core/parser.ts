import type { Arg, Expr, Module, Param, Stmt, TypeExpr } from './ast'
import { BLOCK_FORMS } from './ast'
import { fail, type Loc } from './errors'
import { tokenize, type Token } from './lexer'

/** Binary operator precedence, loosest first. */
const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
}

const RESERVED = new Set([
  'defblock',
  'defrecord',
  'def',
  'defaults',
  'for',
  'in',
  'if',
  'else',
  'and',
  'or',
  'not',
  'measure',
  'throw',
  'import',
])

/** Where a token stops. `pad` covers what the text left out, which is a string's quotes. */
const after = (token: Token, pad = 0): Loc => ({ line: token.loc.line, col: token.loc.col + token.text.length + pad })

class Parser {
  private pos = 0
  /**
   * The bracket that closed the last argument list, read by the call that opened it — which
   * is the very next line, so it never has to survive anything.
   */
  private lastClose: Loc = { line: 0, col: 0 }

  constructor(private readonly tokens: Token[]) {}

  // ── Token helpers ───────────────────────────────────────────────────────────

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]
  }

  private at(text: string, offset = 0): boolean {
    const token = this.peek(offset)
    return (token.kind === 'punct' || token.kind === 'ident') && token.text === text
  }

  private next(): Token {
    return this.tokens[this.pos++] ?? this.tokens[this.tokens.length - 1]
  }

  private expect(text: string, context: string): Token {
    if (!this.at(text)) {
      const found = this.peek()
      fail(
        `expected '${text}' ${context}, found ${found.kind === 'newline' ? 'end of line' : `'${found.text}'`}`,
        found.loc,
      )
    }
    return this.next()
  }

  private skipNewlines(): void {
    while (this.peek().kind === 'newline') this.pos++
  }

  /** After an operator or a comma, a line break is a continuation, not a terminator. */
  private skipSoftNewlines(): void {
    this.skipNewlines()
  }

  private startsExpression(offset = 0): boolean {
    const token = this.peek(offset)
    if (token.kind === 'number' || token.kind === 'string') return true
    if (token.kind === 'ident') return !RESERVED.has(token.text) || token.text === 'not' || token.text === 'measure'
    return token.kind === 'punct' && (token.text === '(' || token.text === '-')
  }

  // ── Module ──────────────────────────────────────────────────────────────────

  parseModule(): Module {
    const statements: Stmt[] = []
    this.skipNewlines()
    while (this.peek().kind !== 'eof') {
      statements.push(this.parseStatement())
      this.skipNewlines()
    }
    return { statements }
  }

  private parseBody(): Stmt[] {
    this.expect('{', 'to open a block')
    const statements: Stmt[] = []
    this.skipNewlines()
    while (!this.at('}') && this.peek().kind !== 'eof') {
      statements.push(this.parseStatement())
      this.skipNewlines()
    }
    this.expect('}', 'to close a block')
    return statements
  }

  private parseArrow(): Stmt[] {
    this.skipNewlines()
    this.expect('=>', 'before a block body')
    this.skipNewlines()
    return this.parseBody()
  }

  // ── Statements ──────────────────────────────────────────────────────────────

  private parseStatement(): Stmt {
    const token = this.peek()
    const loc = token.loc

    if (token.kind === 'ident') {
      switch (token.text) {
        case 'defblock':
          return this.parseDefblock()
        case 'defrecord':
          return this.parseDefrecord()
        case 'def':
          return this.parseDef()
        case 'defaults':
          return this.parseDefaults()
        case 'for':
          return this.parseFor()
        case 'if':
          return this.parseIf()
        case 'throw':
          return this.parseThrow()
        case 'import':
          return this.parseImport()
      }

      if (BLOCK_FORMS.has(token.text) && this.isBlockForm()) {
        this.next()
        // `at (10, 4)` carries a coordinate, not an argument list, so read it as an expression.
        const args: Arg[] =
          token.text === 'at'
            ? [{ label: 'at', labelLoc: loc, value: this.parsePrimary(), loc }]
            : this.at('(')
              ? this.parseArgList()
              : []

        // `row for i in 0..n => { … }` folds the loop into the layout.
        let each: { name: string; indexName?: string; iterable: Expr } | undefined
        if (token.text !== 'at' && this.at('for')) {
          this.next()
          const names = this.parseLoopNames()
          this.expect('in', 'in a for header')
          this.skipSoftNewlines()
          each = { ...names, iterable: this.parseExpr() }
        }

        const body = this.parseArrow()
        return { kind: 'block', form: token.text as 'at' | 'row' | 'column', args, each, body, loc }
      }

      const typed = this.tryParseTypedLocal()
      if (typed) return typed

      if (this.peek(1).kind === 'punct' && this.peek(1).text === '=') {
        const name = this.next().text
        this.next() // '='
        this.skipSoftNewlines()
        return { kind: 'assign', name, value: this.parseExpr(), loc }
      }
    }

    return { kind: 'expr', expr: this.parseExpr(), loc }
  }

  /**
   * `for l in xs` or `for l, i in xs`. The second name counts the passes, which is what a
   * body needs when it has to place its item at a row of its own.
   */
  private parseLoopNames(): { name: string; indexName?: string } {
    const name = this.expectIdent('a loop variable')
    if (!this.at(',')) return { name }
    this.next()
    return { name, indexName: this.expectIdent('a name for the loop index') }
  }

  /** `at`, `row` and `column` are block forms only when a `=> {` follows their arguments. */
  private isBlockForm(): boolean {
    if (this.at('=>', 1)) return true
    if (this.at('for', 1)) return true
    if (!this.at('(', 1)) return false
    let depth = 0
    for (let i = 1; ; i++) {
      const token = this.peek(i)
      if (token.kind === 'eof') return false
      if (token.kind !== 'punct') continue
      if (token.text === '(') depth++
      else if (token.text === ')') {
        depth--
        if (depth === 0) return this.at('=>', i + 1) || this.at('for', i + 1)
      }
    }
  }

  /** `coord f = (…)` and `module[] m = ()` — a declared type in front of a local name. */
  private tryParseTypedLocal(): Stmt | null {
    const start = this.pos
    const loc = this.peek().loc
    if (this.peek().kind !== 'ident' || RESERVED.has(this.peek().text)) return null

    const typeName = this.peek().text
    const array = this.at('[]', 1)
    const nameIndex = array ? 2 : 1
    const eqIndex = nameIndex + 1

    if (this.peek(nameIndex).kind !== 'ident') return null
    if (!this.at('=', eqIndex)) return null

    this.pos = start + eqIndex + 1
    const type: TypeExpr = { name: typeName, array, loc }
    const name = this.tokens[start + nameIndex].text
    this.skipSoftNewlines()
    return { kind: 'assign', name, type, value: this.parseExpr(), loc }
  }

  private parseDefblock(): Stmt {
    const loc = this.next().loc
    const name = this.expectIdent('a block name')
    const params = this.parseParams()
    const body = this.parseArrow()
    return { kind: 'defblock', name, params, body, loc }
  }

  /** A block header with no body: the fields are parameters, and read exactly like them. */
  private parseDefrecord(): Stmt {
    const loc = this.next().loc
    const name = this.expectIdent('a record name')
    return { kind: 'defrecord', name, fields: this.parseParams(), loc }
  }

  private parseDef(): Stmt {
    const loc = this.next().loc
    let type: TypeExpr | undefined
    // `def coord origin = (0, 0)` — the type is optional.
    if (this.peek().kind === 'ident' && (this.at('=', 1) === false) && this.peek(1).kind === 'ident') {
      const typeName = this.next().text
      type = { name: typeName, array: false, loc }
    } else if (this.peek().kind === 'ident' && this.at('[]', 1)) {
      const typeName = this.next().text
      this.next()
      type = { name: typeName, array: true, loc }
    }
    const name = this.expectIdent('a name after def')
    this.expect('=', 'in a def')
    this.skipSoftNewlines()
    return { kind: 'def', name, type, value: this.parseExpr(), loc }
  }

  private parseDefaults(): Stmt {
    const loc = this.next().loc
    let target: string | undefined
    let targetLoc: Loc | undefined
    if (this.peek().kind === 'ident' && !RESERVED.has(this.peek().text)) {
      targetLoc = this.peek().loc
      target = this.next().text
    }
    const args = this.parseArgList()
    const body = this.at('=>') || this.peek().kind === 'newline' ? undefined : undefined
    if (this.at('=>')) {
      return { kind: 'defaults', target, targetLoc, args, body: this.parseArrow(), loc }
    }
    return { kind: 'defaults', target, targetLoc, args, body, loc }
  }

  /** `import "stdlib"`. The name is a string, so a library is never mistaken for a variable. */
  private parseImport(): Stmt {
    const loc = this.next().loc
    // A lone parenthesised value is grouping, so `import ("stdlib")` reads the same.
    const open = this.at('(')
    if (open) this.next()

    const token = this.peek()
    if (token.kind !== 'string') {
      fail('import needs the name of a library, in quotes', loc, 'import "stdlib"')
    }
    this.next()
    if (open) this.expect(')', 'after the library name')

    return { kind: 'import', name: token.text, loc }
  }

  /** `throw <message>`; a parenthesised list is joined with spaces, the way `print` reads. */
  private parseThrow(): Stmt {
    const loc = this.next().loc
    const next = this.peek()
    if (next.kind === 'newline' || next.kind === 'eof') {
      fail('throw needs a message', loc, 'throw "size must be at least 2"')
    }
    return { kind: 'throw', value: this.parseExpr(), loc }
  }

  private parseFor(): Stmt {
    const loc = this.next().loc
    const { name, indexName } = this.parseLoopNames()
    this.expect('in', 'in a for statement')
    this.skipSoftNewlines()
    const iterable = this.parseExpr()
    const body = this.parseArrow()
    return { kind: 'for', name, indexName, iterable, body, loc }
  }

  private parseIf(): Stmt {
    const loc = this.next().loc
    const condition = this.parseExpr()
    const then = this.parseArrow()
    this.skipNewlines()
    if (this.at('else')) {
      this.next()
      return { kind: 'if', condition, then, else: this.parseArrow(), loc }
    }
    return { kind: 'if', condition, then, loc }
  }

  private expectIdent(what: string): string {
    const token = this.peek()
    if (token.kind !== 'ident') fail(`expected ${what}, found '${token.text || 'end of input'}'`, token.loc)
    return this.next().text
  }

  // ── Parameters ──────────────────────────────────────────────────────────────

  private parseParams(): Param[] {
    this.expect('(', 'to open a parameter list')
    const params: Param[] = []
    this.skipNewlines()

    while (!this.at(')') && this.peek().kind !== 'eof') {
      const loc = this.peek().loc
      const typeName = this.expectIdent('a parameter type')
      const array = this.at('[]')
      if (array) this.next()
      const nameLoc = this.peek().loc
      const name = this.expectIdent('a parameter name')

      let fallback: Expr | undefined
      if (this.at('=')) {
        this.next()
        this.skipSoftNewlines()
        fallback = this.parseExpr()
      }

      params.push({ type: { name: typeName, array, loc }, name, nameLoc, default: fallback, loc })
      if (this.at(',')) this.next()
      this.skipNewlines()
    }

    this.expect(')', 'to close a parameter list')
    return params
  }

  // ── Arguments ───────────────────────────────────────────────────────────────

  private parseArgList(): Arg[] {
    return this.parseGroup().entries
  }

  /**
   * Whether a comma was written matters to the caller: `(x)` is grouping and collapses back
   * to `x`, while `(x,)` and `(x, y)` are a list.
   */
  private parseGroup(): { entries: Arg[]; sawComma: boolean } {
    this.expect('(', 'to open an argument list')
    const entries: Arg[] = []
    let sawComma = false
    this.skipNewlines()

    while (!this.at(')') && this.peek().kind !== 'eof') {
      entries.push(this.parseArg())
      this.skipNewlines()
      if (this.at(',')) {
        sawComma = true
        this.next()
        this.skipNewlines()
      }
    }

    this.lastClose = this.expect(')', 'to close an argument list').loc
    return { entries, sawComma }
  }

  /**
   * `tier blue` is a label and its value; `blue` alone finds its slot from its type.
   * `repeat (4, x)` is ambiguous between the two, so both readings are recorded and the
   * checker picks whichever the callee actually has — a slot or a function in scope.
   */
  private parseArg(): Arg {
    const token = this.peek()

    // A name followed by an operator is arithmetic, not a label: `at (0, lines - j)` is a
    // subtraction. Only `-` is ambiguous — it can begin a value too — and reading it as a
    // label there would quietly drop the left-hand side rather than fail.
    const labelled = token.kind === 'ident' && !RESERVED.has(token.text) && this.startsExpression(1)

    if (labelled && !this.continuesExpression(1)) {
      const labelLoc = token.loc
      const label = this.next().text

      // A parenthesised value is read as an argument list, so `content (iron-ore left)` keeps
      // its pairing. It still reads as a tuple when every entry is bare, which is what
      // `at (0, 0)` and `modules (a, b)` rely on.
      if (this.at('(')) {
        const mark = this.pos
        const entries = this.parseArgList()

        // Unless the expression carries on past the brackets, in which case they were only
        // grouping: `gap (1 + 2) * 3`.
        if (!this.continuesExpression()) {
          const arg: Arg = {
            label,
            labelLoc,
            value: { kind: 'tuple', items: entries.map((e) => e.value), entries, loc: labelLoc },
            entries,
            loc: labelLoc,
          }
          arg.asCall = { kind: 'call', callee: label, args: entries, loc: labelLoc }
          return arg
        }
        this.pos = mark
      }

      return { label, labelLoc, value: this.parseExpr(), loc: labelLoc }
    }

    // An unlabelled group may be a record written out — `(dir west, content (coal))` — so it
    // is read as an argument list as well, and collapses back to plain grouping when it turns
    // out to hold a single unlabelled value: `at (0, (lines - j))` is arithmetic, not a list.
    if (this.at('(')) {
      const mark = this.pos
      const { entries, sawComma } = this.parseGroup()

      if (!this.continuesExpression()) {
        if (entries.length === 1 && !sawComma && entries[0].label === undefined) {
          return { value: entries[0].value, entries: entries[0].entries, loc: entries[0].loc }
        }
        const items = entries.map((e) => e.value)
        return { value: { kind: 'tuple', items, entries, loc: token.loc }, entries, loc: token.loc }
      }
      this.pos = mark
    }

    const value = this.parseExpr()
    return { value, loc: value.loc }
  }

  /** True when the next token would extend an expression that just ended. */
  private continuesExpression(offset = 0): boolean {
    const token = this.peek(offset)
    if (token.kind === 'punct' && (token.text === '.' || token.text === '..' || token.text === '[')) return true
    return (token.kind === 'punct' || token.kind === 'ident') && PRECEDENCE[token.text] !== undefined
  }

  // ── Expressions ─────────────────────────────────────────────────────────────

  parseExpr(minPrecedence = 0): Expr {
    let left = this.parseUnary()

    for (;;) {
      const token = this.peek()

      if (token.kind === 'punct' && token.text === '..' && minPrecedence === 0) {
        this.next()
        this.skipSoftNewlines()
        left = { kind: 'range', from: left, to: this.parseExpr(1), loc: left.loc }
        continue
      }

      const op = token.kind === 'punct' || token.kind === 'ident' ? token.text : ''
      const precedence = PRECEDENCE[op]
      if (precedence === undefined || precedence < minPrecedence) break

      this.next()
      this.skipSoftNewlines()
      const right = this.parseExpr(precedence + 1)
      left = { kind: 'binary', op, left, right, loc: token.loc }
    }

    // Looser than every operator, and right-associative, so `a ? b : c ? d : e` reads as a
    // chain of choices rather than a puzzle.
    if (minPrecedence === 0 && this.at('?')) {
      const loc = this.next().loc
      this.skipSoftNewlines()
      const then = this.parseExpr()
      this.expect(':', 'between the two halves of a `?` choice')
      this.skipSoftNewlines()
      left = { kind: 'ternary', condition: left, then, otherwise: this.parseExpr(), loc }
    }

    return left
  }

  private parseUnary(): Expr {
    const token = this.peek()
    if ((token.kind === 'punct' && token.text === '-') || (token.kind === 'ident' && token.text === 'not')) {
      this.next()
      return { kind: 'unary', op: token.text, operand: this.parseUnary(), loc: token.loc }
    }
    return this.parsePostfix()
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary()
    for (;;) {
      if (this.at('.')) {
        const loc = this.next().loc
        expr = { kind: 'field', target: expr, field: this.expectIdent('a field name'), loc }
        continue
      }
      if (this.at('[')) {
        const loc = this.next().loc
        this.skipSoftNewlines()
        const index = this.parseExpr()
        this.skipSoftNewlines()
        this.expect(']', 'to close an index')
        expr = { kind: 'index', target: expr, index, loc }
        continue
      }
      return expr
    }
  }

  private parsePrimary(): Expr {
    const token = this.peek()

    if (token.kind === 'number') {
      this.next()
      return { kind: 'number', value: Number(token.text), loc: token.loc, end: after(token) }
    }

    if (token.kind === 'string') {
      // The quotes are not in the text but they are in the source, so the span covers them.
      this.next()
      return { kind: 'text', value: token.text, loc: token.loc, end: after(token, 2) }
    }

    if (token.kind === 'ident') {
      if (token.text === 'measure') {
        this.next()
        this.expect('(', 'after measure')
        this.skipNewlines()
        const body = this.parseExpr()
        this.skipNewlines()
        this.expect(')', 'to close measure')
        return { kind: 'measure', body, loc: token.loc }
      }
      if (RESERVED.has(token.text)) fail(`'${token.text}' cannot be used here`, token.loc)

      this.next()
      if (this.at('(')) {
        const args = this.parseArgList()
        return { kind: 'call', callee: token.text, args, loc: token.loc, close: this.lastClose }
      }
      return { kind: 'name', name: token.text, loc: token.loc, end: after(token) }
    }

    if (token.kind === 'punct' && token.text === '(') {
      this.next()
      this.skipNewlines()
      const items: Expr[] = []
      let sawComma = false
      while (!this.at(')') && this.peek().kind !== 'eof') {
        items.push(this.parseExpr())
        this.skipNewlines()
        if (this.at(',')) {
          sawComma = true
          this.next()
          this.skipNewlines()
        }
      }
      this.expect(')', 'to close a group')
      // A single value in parentheses is grouping; anything else builds a tuple.
      if (items.length === 1 && !sawComma) return items[0]
      return { kind: 'tuple', items, loc: token.loc }
    }

    fail(
      token.kind === 'newline' ? 'unexpected end of line' : `unexpected '${token.text || 'end of input'}'`,
      token.loc,
    )
  }
}

export function parse(source: string): Module {
  return new Parser(tokenize(source)).parseModule()
}
