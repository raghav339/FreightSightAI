#!/usr/bin/env python3
"""Extract user-visible strings from the ML service (Python) for the i18n inventory.

Prints a JSON list to stdout. Called by inventory.mjs; can also be run alone:
    python3 tools/i18n/py_extract.py <repo-root>

Heuristics (deliberately over-inclusive; a human reviews the result):
  * f-strings and plain strings that read like sentences (>= 2 words),
  * `HTTPException(detail=...)` -> kind "api-error" (shown to users through the API),
  * `raise SomeError("...")` -> kind "exception" (often surfaced as a 400),
  * enum-like tokens (NORMAL, INSUFFICIENT_DATA ...) -> kind "enum-value".
Skipped: docstrings, dict keys, subscripts, comparisons, print/logging/warnings,
SQL, decorator args, pydantic Field(description=...), tests and CLI scripts.
"""
from __future__ import annotations

import ast
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
ML = ROOT / "ml-service"

SKIP_DIRS = {"tests", "scripts", "models", "data", "__pycache__", "sources"}
LOG_CALLS = {"print", "warn", "debug", "info", "warning", "error", "exception", "critical", "log"}
SQL_START = re.compile(r"^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|PRAGMA|FROM|SET)\b", re.I)
ENUM_RE = re.compile(r"^[A-Z][A-Z_]{3,}$")
ENUM_NOISE = {"GET", "POST", "HEAD", "PUT", "DELETE", "NONE", "TRUE", "FALSE", "UTF", "JSON", "MYSQL", "SQLITE"}
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_\-\.]*$")


def looks_like_text(s: str) -> bool:
    s = s.strip()
    if len(s) < 4 or not re.search(r"[A-Za-z]{3}", s):
        return False
    if SQL_START.match(s) or s.startswith(("/", "http", "%", ".", "#")):
        return False
    if IDENT_RE.match(s):
        return False
    return len(s.split()) >= 2


FILELIKE = re.compile(r"\.(joblib|csv|json|sqlite3?|py|md|txt|pkl)\b", re.I)
REGEXY = re.compile(r"(\\[sdw]|\(\?:|^\^|\$$)")


def sentence_like(text: str) -> bool:
    """>= 2 alphabetic words once {placeholders} are removed; not a file name or regex;
    reads like UI text (capitalised, punctuated, or long) rather than a column alias."""
    t = re.sub(r"\{[^}]*\}", " ", text)
    if REGEXY.search(text) or SQL_START.match(text):
        return False
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'\-]+", t) if len(w) >= 2]
    if len(words) < 2:
        return False
    stripped = text.strip()
    if " " not in stripped:          # identifiers, file names, URLs, column names
        return False
    if re.search(r"=\s*\?", stripped) or FILELIKE.search(stripped) and len(stripped.split()) < 4:
        return False                  # SQL parameters / file names
    return bool(stripped[:1].isupper() or stripped.startswith("{") or re.search(r"[.,;:!?—–()]", stripped) or len(words) >= 4)


def placeholder_name(e: ast.AST) -> str:
    """Readable name for an f-string expression: {commodity}, {typical_congestion}..."""
    if isinstance(e, ast.Name):
        return e.id
    if isinstance(e, ast.Attribute):
        return e.attr
    if isinstance(e, ast.Subscript):
        sl = e.slice
        if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
            return sl.value
        return placeholder_name(e.value)
    if isinstance(e, ast.Call):
        if isinstance(e.func, ast.Attribute) and isinstance(e.func.value, (ast.Name, ast.Attribute, ast.Subscript)):
            return placeholder_name(e.func.value)
        if e.args:
            return placeholder_name(e.args[0])
    if isinstance(e, ast.IfExp):
        return placeholder_name(e.body)
    return "value"


def fstring_text(node: ast.JoinedStr) -> str:
    parts = []
    for v in node.values:
        if isinstance(v, ast.Constant):
            parts.append(str(v.value))
        elif isinstance(v, ast.FormattedValue):
            parts.append("{" + placeholder_name(v.value) + "}")
    return "".join(parts)


def call_name(call: ast.Call) -> str:
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return ""


class V(ast.NodeVisitor):
    def __init__(self, rel: str):
        self.rel = rel
        self.stack: list[ast.AST] = []
        self.func: list[str] = []
        self.out: list[dict] = []
        self.skip_ids: set[int] = set()

    # -- helpers
    def add(self, node, text, kind, conf):
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return
        self.out.append({
            "area": "ml-service", "file": self.rel, "line": node.lineno,
            "kind": kind, "confidence": conf, "text": text,
            "context": ".".join(self.func) or "<module>",
        })

    def generic_visit(self, node):
        self.stack.append(node)
        super().generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node):
        # docstring
        if node.body and isinstance(node.body[0], ast.Expr) and isinstance(getattr(node.body[0], "value", None), ast.Constant):
            self.skip_ids.add(id(node.body[0].value))
        self.func.append(node.name)
        self.generic_visit(node)
        self.func.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        if node.body and isinstance(node.body[0], ast.Expr) and isinstance(getattr(node.body[0], "value", None), ast.Constant):
            self.skip_ids.add(id(node.body[0].value))
        self.func.append(node.name)
        self.generic_visit(node)
        self.func.pop()

    def visit_Module(self, node):
        if node.body and isinstance(node.body[0], ast.Expr) and isinstance(getattr(node.body[0], "value", None), ast.Constant):
            self.skip_ids.add(id(node.body[0].value))
        self.generic_visit(node)

    def visit_Dict(self, node):
        for k in node.keys:
            if k is not None:
                self._mark_all(k)
        self.generic_visit(node)

    def visit_Subscript(self, node):
        self._mark_all(node.slice)
        self.generic_visit(node)

    def visit_Compare(self, node):
        # `x == "NORMAL"` is logic, but the enum token is still worth listing.
        for c in [node.left, *node.comparators]:
            if isinstance(c, ast.Constant) and isinstance(c.value, str):
                if ENUM_RE.match(c.value) and c.value not in ENUM_NOISE:
                    self.add(c, c.value, "enum-value", "low")
                self.skip_ids.add(id(c))
        self.generic_visit(node)

    def visit_Call(self, node):
        name = call_name(node)
        if name in LOG_CALLS:
            self._mark_all(node)  # nothing inside a log call is user-visible
            return
        if name == "HTTPException":
            for kw in node.keywords:
                if kw.arg == "detail":
                    self._emit(kw.value, "api-error", "high")
                    self._mark_all(kw.value)
        elif name == "Field":
            self._mark_all(node)
            return
        elif name.endswith("Error") or name == "Exception":
            for a in node.args:
                self._emit(a, "exception", "medium")
                self._mark_all(a)
        elif name in {"getenv", "get", "environ", "setdefault", "startswith", "endswith", "strftime",
                      "strptime", "to_datetime", "read_csv", "read_json", "Path", "joinpath", "execute", "executemany"}:
            for a in node.args:
                self._mark_all(a)
        self.generic_visit(node)

    def visit_Assert(self, node):
        return  # test-style assertion messages are not shown to users

    def visit_Import(self, node):
        return

    visit_ImportFrom = visit_Import

    def _mark_all(self, node):
        for n in ast.walk(node):
            if isinstance(n, (ast.Constant, ast.JoinedStr)):
                self.skip_ids.add(id(n))

    def _emit(self, node, kind, conf):
        if isinstance(node, ast.JoinedStr):
            self.add(node, fstring_text(node), kind, conf)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            self.add(node, node.value, kind, conf)
        elif isinstance(node, ast.BinOp) or isinstance(node, ast.Call):
            for n in ast.walk(node):
                if isinstance(n, ast.JoinedStr):
                    self.add(n, fstring_text(n), kind, conf)
                elif isinstance(n, ast.Constant) and isinstance(n.value, str) and sentence_like(n.value):
                    self.add(n, n.value, kind, conf)

    def visit_JoinedStr(self, node):
        if id(node) in self.skip_ids:
            return
        # do not descend: nested constants belong to this f-string
        self._mark_all(node)
        if self.stack and isinstance(self.stack[-1], (ast.List, ast.Tuple, ast.Set)):
            return
        text = fstring_text(node)
        if sentence_like(text):
            self.add(node, text, "message", "high")

    def visit_Constant(self, node):
        if id(node) in self.skip_ids or not isinstance(node.value, str):
            return
        s = node.value
        if ENUM_RE.match(s) and s not in ENUM_NOISE:
            self.add(node, s, "enum-value", "low")
        elif sentence_like(s) and not (self.stack and isinstance(self.stack[-1], (ast.List, ast.Tuple, ast.Set))):
            self.add(node, s, "message", "medium")


def main():
    results: list[dict] = []
    for path in sorted(ML.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        if any(part in SKIP_DIRS for part in path.relative_to(ML).parts[:-1]):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as exc:
            print(f"warning: could not parse {rel}: {exc}", file=sys.stderr)
            continue
        v = V(rel)
        v.visit(tree)
        results.extend(v.out)
    json.dump(results, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
