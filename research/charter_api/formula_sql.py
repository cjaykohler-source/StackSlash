"""
Charter formula -> DuckDB SQL, for server-side event conditions (the
/event_study endpoint). The same language as the page's src/lib/formula.ts:

  numbers            1, 0.5, 1e6
  column names       close, vol_ratio, sma20 ...  (must be in `columns`)
  + - * /  ( )  unary -
  comparisons        > < >= <= == !=   (1 or 0)
  functions          abs(x) log(x) sqrt(x) min(a, b) max(a, b)
                     lag(x, n) sma(x, n) change(x, n) zscore(x, n)  -- per symbol, over its own sessions

Safety: the output SQL is assembled only from validated pieces -- column
names from the caller's whitelist (double-quoted), numbers re-rendered from
float(), and fixed operator / function text. Nothing the user typed is
copied into the SQL verbatim. Semantics match formula.ts: missing input,
division by zero, log/sqrt of a non-positive -> NULL; comparisons -> 1/0.

Series functions become window functions over `partition by symbol order by
date`; SQL can't nest window functions, so a series function's argument must
not itself contain one, and n is limited to 1..250 sessions.
"""
import re

FUNCS = {"abs": 1, "log": 1, "sqrt": 1, "min": 2, "max": 2, "lag": 2, "sma": 2, "change": 2, "zscore": 2}
SERIES = {"lag", "sma", "change", "zscore"}
TOKEN = re.compile(r"\s*(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|>=|<=|==|!=|[-+*/(),<>])", re.I)
MAX_LEN = 500
MAX_N = 250


class FormulaError(ValueError):
    pass


def _tokens(src):
    src = src.strip()
    if len(src) > MAX_LEN:
        raise FormulaError(f"formula longer than {MAX_LEN} characters")
    out, i = [], 0
    while i < len(src):
        m = TOKEN.match(src, i)
        if not m:
            raise FormulaError(f'unexpected character at position {i + 1}: "{src[i]}"')
        out.append(m.group(1))
        i = m.end()
        while i < len(src) and src[i] == " ":
            i += 1
    return out


def _win(n):
    return f"(partition by symbol order by date rows between {n - 1} preceding and current row)"


def to_sql(src, columns):
    """Return (sql, referenced_columns). Raises FormulaError with a readable message."""
    t = _tokens(src)
    if not t:
        raise FormulaError("the formula is empty")
    pos = 0
    used = set()

    def peek():
        return t[pos] if pos < len(t) else None

    def eat(x=None):
        nonlocal pos
        v = peek()
        if x is not None and v != x:
            raise FormulaError(f'expected "{x}" but found "{v or "end"}"')
        pos += 1
        return v

    # every node returns (sql, has_window)
    def cmp():
        a, wa = add()
        while peek() in (">", "<", ">=", "<=", "==", "!="):
            op = eat()
            b, wb = add()
            a, wa = f"(({a}) {'=' if op == '==' else '<>' if op == '!=' else op} ({b}))::int", wa or wb
        return a, wa

    def add():
        a, wa = mul()
        while peek() in ("+", "-"):
            op = eat()
            b, wb = mul()
            a, wa = f"({a} {op} {b})", wa or wb
        return a, wa

    def mul():
        a, wa = unary()
        while peek() in ("*", "/"):
            op = eat()
            b, wb = unary()
            a, wa = (f"({a} * {b})" if op == "*" else f"({a} / nullif({b}, 0))"), wa or wb
        return a, wa

    def unary():
        if peek() == "-":
            eat()
            a, w = unary()
            return f"(-{a})", w
        return atom()

    def atom():
        v = peek()
        if v is None:
            raise FormulaError("the formula ends too early")
        if v == "(":
            eat("(")
            e = cmp()
            eat(")")
            return e
        if v[0].isdigit() or v[0] == ".":
            eat()
            return repr(float(v)), False
        if v[0].isalpha() or v[0] == "_":
            eat()
            if peek() == "(":
                fn = v.lower()
                if fn not in FUNCS:
                    raise FormulaError(f'unknown function "{v}"')
                eat("(")
                args = [cmp()]
                while peek() == ",":
                    eat(",")
                    args.append(cmp())
                eat(")")
                if len(args) != FUNCS[fn]:
                    raise FormulaError(f"{fn}() takes {FUNCS[fn]} argument(s)")
                (a, wa) = args[0]
                if fn == "abs":
                    return f"abs({a})", wa
                if fn == "log":
                    return f"(case when {a} > 0 then ln({a}) end)", wa
                if fn == "sqrt":
                    return f"(case when {a} >= 0 then sqrt({a}) end)", wa
                if fn in ("min", "max"):
                    b, wb = args[1]
                    # least/greatest skip NULLs in DuckDB; formula.ts gives NULL if either side is missing
                    return f"(case when {a} is not null and {b} is not null then {'least' if fn == 'min' else 'greatest'}({a}, {b}) end)", wa or wb
                # series functions
                try:
                    n = float(args[1][0])
                except ValueError:
                    raise FormulaError(f"the second argument of {fn}() must be a number")
                n = int(round(n))
                if not 1 <= n <= MAX_N:
                    raise FormulaError(f"{fn}() looks back 1 to {MAX_N} sessions")
                if wa:
                    raise FormulaError(f"{fn}() can't contain another lag/sma/change/zscore here")
                p = "(partition by symbol order by date)"
                if fn == "lag":
                    return f"lag({a}, {n}) over {p}", True
                if fn == "change":
                    return f"({a} / nullif(lag({a}, {n}) over {p}, 0) - 1)", True
                full = f"count({a}) over {_win(n)} = {n}"
                if fn == "sma":
                    return f"(case when {full} then avg({a}) over {_win(n)} end)", True
                return (f"(case when {full} and stddev_pop({a}) over {_win(n)} > 0 "
                        f"then ({a} - avg({a}) over {_win(n)}) / stddev_pop({a}) over {_win(n)} end)"), True
            if v not in columns:
                raise FormulaError(f'unknown metric "{v}"' + (" (forward metrics are outcomes and can't define an event)" if v.startswith("fwd_") else ""))
            used.add(v)
            return f'"{v}"', False
        raise FormulaError(f'unexpected "{v}"')

    sql, _ = cmp()
    if pos != len(t):
        raise FormulaError(f'unexpected "{t[pos]}"')
    return sql, used
