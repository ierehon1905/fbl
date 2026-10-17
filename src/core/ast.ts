import type { Loc } from './errors'

// ── Types as written in source ────────────────────────────────────────────────

export interface TypeExpr {
  name: string
  array: boolean
  loc: Loc
}

// ── Expressions ───────────────────────────────────────────────────────────────

export type Expr =
  /**
   * `end` is where the token stops, and only the literals carry it.
   *
   * It is what lets a value be replaced in the source rather than described: a recipe, a
   * direction and a count are each one token, so each has a span an edit can splice. Anything
   * computed deliberately has none — `x + i * 3` cannot be changed by an example, and the
   * absence of a span is how that is said.
   */
  | { kind: 'number'; value: number; loc: Loc; end?: Loc }
  | { kind: 'text'; value: string; loc: Loc; end?: Loc }
  | { kind: 'name'; name: string; loc: Loc; end?: Loc }
  /**
   * `entries` is the same list as written, kept because an item may itself be `name (…)` —
   * a nested call, not a label. Only whoever knows what is callable can tell them apart.
   */
  | { kind: 'tuple'; items: Expr[]; entries?: Arg[]; loc: Loc }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; loc: Loc }
  | { kind: 'unary'; op: string; operand: Expr; loc: Loc }
  /** `n > 2 ? 3 : 1` — a choice between two values, not two branches of a program. */
  | { kind: 'ternary'; condition: Expr; then: Expr; otherwise: Expr; loc: Loc }
  | { kind: 'range'; from: Expr; to: Expr; loc: Loc }
  | { kind: 'field'; target: Expr; field: string; loc: Loc }
  /** `lines[0]` — one item out of a list, or the x or y of a coordinate. */
  | { kind: 'index'; target: Expr; index: Expr; loc: Loc }
  /** `close` is the closing bracket, which is where a new argument would be written. */
  | { kind: 'call'; callee: string; args: Arg[]; loc: Loc; close?: Loc }
  | { kind: 'measure'; body: Expr; loc: Loc }

/** `recipe r` is labelled; `north` is bare and finds its slot by type. */
export interface Arg {
  label?: string
  labelLoc?: Loc
  value: Expr
  /**
   * `repeat (4, x)` reads either as the label `repeat` with a tuple, or as a call.
   * The parser records both and the checker keeps whichever the callee supports.
   */
  asCall?: Expr
  /**
   * When the value was parenthesised, the arguments as written — which keeps the pairing in
   * `content (iron-ore left, coal right)` that a flat tuple would lose.
   */
  entries?: Arg[]
  loc: Loc
}

// ── Statements ────────────────────────────────────────────────────────────────

export interface Param {
  type: TypeExpr
  name: string
  /** Where the name itself is written, which is what the editor paints. */
  nameLoc: Loc
  default?: Expr
  loc: Loc
}

export type Stmt =
  | { kind: 'defblock'; name: string; params: Param[]; body: Stmt[]; loc: Loc }
  /**
   * `defrecord line (direction dir = east, content content = ())` — a named bag of fields,
   * written like a block header with no body. Its fields are ordinary parameters, defaults
   * and all, so everything that knows how to fill a slot already knows how to fill a field.
   */
  | { kind: 'defrecord'; name: string; fields: Param[]; loc: Loc }
  | { kind: 'def'; name: string; type?: TypeExpr; value: Expr; loc: Loc }
  | { kind: 'assign'; name: string; type?: TypeExpr; value: Expr; loc: Loc }
  | { kind: 'defaults'; target?: string; targetLoc?: Loc; args: Arg[]; body?: Stmt[]; loc: Loc }
  /** `for l, i in lines` — the second name, when there is one, counts the passes. */
  | { kind: 'for'; name: string; indexName?: string; iterable: Expr; body: Stmt[]; loc: Loc }
  | { kind: 'if'; condition: Expr; then: Stmt[]; else?: Stmt[]; loc: Loc }
  /** `throw "size must be at least 2"` — the author's own error, raised where it is written. */
  | { kind: 'throw'; value: Expr; loc: Loc }
  /** `import "stdlib"` — pulls a library's blocks and helpers into scope. */
  | { kind: 'import'; name: string; loc: Loc }
  | {
      kind: 'block'
      form: 'at' | 'row' | 'column' | 'transform'
      args: Arg[]
      /** `row for i in 0..n => { … }` — one layout item per pass. */
      each?: { name: string; indexName?: string; iterable: Expr }
      body: Stmt[]
      loc: Loc
    }
  | { kind: 'expr'; expr: Expr; loc: Loc }

export interface Module {
  statements: Stmt[]
}

/** Statement-level forms that take a `=> { … }` body. */
export const BLOCK_FORMS = new Set(['at', 'row', 'column', 'transform'])
