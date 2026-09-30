/**
 * Formula metrics for Charter: a user-typed expression over existing daily
 * columns, evaluated element-wise over whole series. A small hand-written
 * parser -- never eval() -- so only these constructs exist:
 *
 *   numbers            1, 0.5, 1e6
 *   column names       close, vol_ratio, sma20, short_float ...  (must exist)
 *   + - * /  ( )  unary -
 *   comparisons        > < >= <= == !=   (1 or 0)
 *   functions          abs(x) log(x) sqrt(x) min(a, b) max(a, b)
 *                      lag(x, n)   value n rows earlier
 *                      sma(x, n)   n-row moving average
 *                      change(x, n) x / lag(x, n) - 1
 *                      zscore(x, n) (x - sma) / rolling std over n rows
 *
 * Division by zero, missing inputs or out-of-range lags give null, never
 * an exception or a wrong number.
 */

type Series = (number | null)[];
type Node =
  | { k: "num"; v: number }
  | { k: "col"; name: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; fn: string; args: Node[] };

const FUNCS: Record<string, number> = { abs: 1, log: 1, sqrt: 1, min: 2, max: 2, lag: 2, sma: 2, change: 2, zscore: 2 };

export class FormulaError extends Error {}

function tokenize(src: string): string[] {
  const re = /\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|>=|<=|==|!=|[-+*/(),<>])/y;
  const out: string[] = [];
  let i = 0;
  src = src.trim();
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new FormulaError(`unexpected character at position ${i + 1}: "${src[i]}"`);
    out.push(m[1]);
    i = re.lastIndex;
    while (i < src.length && src[i] === " ") i++;
  }
  return out;
}

export function parseFormula(src: string, columns: Set<string>): Node {
  const t = tokenize(src);
  let p = 0;
  const peek = () => t[p];
  const eat = (x?: string) => {
    const v = t[p];
    if (x !== undefined && v !== x) throw new FormulaError(`expected "${x}" but found "${v ?? "end"}"`);
    p++;
    return v;
  };
  function cmp(): Node {
    let a = add();
    while ([">", "<", ">=", "<=", "==", "!="].includes(peek())) {
      const op = eat();
      a = { k: "bin", op, a, b: add() };
    }
    return a;
  }
  function add(): Node {
    let a = mul();
    while (peek() === "+" || peek() === "-") {
      const op = eat();
      a = { k: "bin", op, a, b: mul() };
    }
    return a;
  }
  function mul(): Node {
    let a = unary();
    while (peek() === "*" || peek() === "/") {
      const op = eat();
      a = { k: "bin", op, a, b: unary() };
    }
    return a;
  }
  function unary(): Node {
    if (peek() === "-") {
      eat();
      return { k: "neg", a: unary() };
    }
    return atom();
  }
  function atom(): Node {
    const v = peek();
    if (v === undefined) throw new FormulaError("the formula ends too early");
    if (v === "(") {
      eat("(");
      const e = cmp();
      eat(")");
      return e;
    }
    if (/^(\d|\.)/.test(v)) {
      eat();
      return { k: "num", v: Number(v) };
    }
    if (/^[A-Za-z_]/.test(v)) {
      eat();
      if (peek() === "(") {
        const fn = v.toLowerCase();
        if (!(fn in FUNCS)) throw new FormulaError(`unknown function "${v}"`);
        eat("(");
        const args: Node[] = [cmp()];
        while (peek() === ",") {
          eat(",");
          args.push(cmp());
        }
        eat(")");
        if (args.length !== FUNCS[fn]) throw new FormulaError(`${fn}() takes ${FUNCS[fn]} argument(s)`);
        if (["lag", "sma", "change", "zscore"].includes(fn) && args[1].k !== "num")
          throw new FormulaError(`the second argument of ${fn}() must be a number`);
        return { k: "call", fn, args };
      }
      if (!columns.has(v)) throw new FormulaError(`unknown metric "${v}"`);
      return { k: "col", name: v };
    }
    throw new FormulaError(`unexpected "${v}"`);
  }
  const tree = cmp();
  if (p !== t.length) throw new FormulaError(`unexpected "${t[p]}"`);
  return tree;
}

const ok = (x: number | null): x is number => x != null && Number.isFinite(x);

function evalNode(n: Node, cols: Record<string, Series>, len: number): Series {
  switch (n.k) {
    case "num":
      return new Array(len).fill(n.v);
    case "col":
      return cols[n.name].map((v) => (typeof v === "number" ? v : null));
    case "neg":
      return evalNode(n.a, cols, len).map((v) => (ok(v) ? -v : null));
    case "bin": {
      const a = evalNode(n.a, cols, len);
      const b = evalNode(n.b, cols, len);
      return a.map((x, i) => {
        const y = b[i];
        if (!ok(x) || !ok(y)) return null;
        switch (n.op) {
          case "+": return x + y;
          case "-": return x - y;
          case "*": return x * y;
          case "/": return y === 0 ? null : x / y;
          case ">": return x > y ? 1 : 0;
          case "<": return x < y ? 1 : 0;
          case ">=": return x >= y ? 1 : 0;
          case "<=": return x <= y ? 1 : 0;
          case "==": return x === y ? 1 : 0;
          default: return x !== y ? 1 : 0;
        }
      });
    }
    case "call": {
      const a = evalNode(n.args[0], cols, len);
      const k = n.args[1]?.k === "num" ? Math.round((n.args[1] as { v: number }).v) : 0;
      switch (n.fn) {
        case "abs": return a.map((v) => (ok(v) ? Math.abs(v) : null));
        case "log": return a.map((v) => (ok(v) && v > 0 ? Math.log(v) : null));
        case "sqrt": return a.map((v) => (ok(v) && v >= 0 ? Math.sqrt(v) : null));
        case "min":
        case "max": {
          const b = evalNode(n.args[1], cols, len);
          return a.map((v, i) => (ok(v) && ok(b[i]) ? (n.fn === "min" ? Math.min(v, b[i]!) : Math.max(v, b[i]!)) : null));
        }
        case "lag": return a.map((_, i) => (i - k >= 0 && k >= 0 ? a[i - k] : null));
        case "change": return a.map((v, i) => (i - k >= 0 && ok(v) && ok(a[i - k]) && a[i - k] !== 0 ? v / a[i - k]! - 1 : null));
        case "sma":
        case "zscore": {
          return a.map((v, i) => {
            if (i + 1 < k || k < 1) return null;
            const win = a.slice(i + 1 - k, i + 1);
            if (!win.every(ok)) return null;
            const m = (win as number[]).reduce((s, x) => s + x, 0) / k;
            if (n.fn === "sma") return m;
            const sd = Math.sqrt((win as number[]).reduce((s, x) => s + (x - m) ** 2, 0) / k);
            return sd === 0 || !ok(v) ? null : (v - m) / sd;
          });
        }
      }
    }
  }
  return new Array(len).fill(null);
}

/** Parse and evaluate; throws FormulaError with a readable message. */
export function evaluateFormula(src: string, cols: Record<string, Series>): Series {
  const names = new Set(Object.keys(cols));
  const tree = parseFormula(src, names);
  const len = Object.values(cols)[0]?.length ?? 0;
  return evalNode(tree, cols, len);
}
