"""Server-side localisation for user-facing decision text.

The forecast engine builds long English sentences (analyst read, charter window,
vessel rationale, COA notes...). They are now looked up in per-language catalogs
(app/locales/<lang>.json, flat "namespace.key" -> Python format template) using the
language of the current request.

How the language reaches the code
---------------------------------
* The Node backend forwards the user's language in an ``X-Lang`` header.
* ``LangMiddleware`` (main.py) stores it in a context variable for the request,
  so builders never need a ``lang`` argument. Sync endpoints run in a worker
  thread that inherits the context, so this works for both kinds of endpoint.
* ``t("decision.summary", commodity=...)`` returns the localised, formatted text.

Rules for catalog entries: keep every ``{placeholder}`` (and its format spec such as
``{forecast:.2f}``) exactly as in English; numbers stay Latin digits; a language that
lacks a key falls back to English, and ``tests/test_i18n.py`` enforces full parity.
"""
from __future__ import annotations

import contextvars
import json
import logging
from collections.abc import Mapping
from pathlib import Path

log = logging.getLogger("freightsight.i18n")

SUPPORTED = ("en", "bn", "or", "te", "ta")
DEFAULT = "en"
LOCALES_DIR = Path(__file__).resolve().parent / "locales"

_ALIASES = {"od": "or", "odia": "or", "oriya": "or", "ben": "bn", "tel": "te", "tam": "ta"}
_current: contextvars.ContextVar[str] = contextvars.ContextVar("freightsight_lang", default=DEFAULT)
_catalogs: dict[str, dict[str, str]] = {}


def _load() -> None:
    for code in SUPPORTED:
        path = LOCALES_DIR / f"{code}.json"
        if path.exists():
            _catalogs[code] = json.loads(path.read_text(encoding="utf-8"))
        else:
            _catalogs[code] = {}


_load()


def normalize(code: str | None) -> str:
    """'bn-IN' -> 'bn', 'OD' -> 'or', unknown -> 'en'. Accepts an Accept-Language style list."""
    if not code:
        return DEFAULT
    first = code.split(",")[0].split(";")[0].strip().lower().replace("_", "-")
    primary = first.split("-")[0]
    primary = _ALIASES.get(primary, primary)
    return primary if primary in SUPPORTED else DEFAULT


def set_lang(code: str | None):
    """Set the language for the current context; returns a token for reset_lang()."""
    return _current.set(normalize(code))


def reset_lang(token) -> None:
    _current.reset(token)


def get_lang() -> str:
    return _current.get()


def text(key: str, lang: str | None = None) -> str:
    """Raw template for ``key`` in ``lang`` (default: current), falling back to English."""
    lang = normalize(lang) if lang else get_lang()
    tpl = _catalogs.get(lang, {}).get(key)
    if tpl is None:
        tpl = _catalogs["en"].get(key)
        if tpl is None:
            raise KeyError(f"Missing i18n key: {key}")
        if lang != DEFAULT:
            log.warning("i18n: key %r missing for %r, using English", key, lang)
    return tpl


def t(key: str, **params) -> str:
    tpl = text(key)
    return tpl.format(**params) if params else tpl


class Namespace(Mapping):
    """dict-like view of one catalog namespace, resolved in the current language.

    ``TEXT["summary"]`` == ``text("decision.summary")``. Lets older code keep its
    ``TEXT[key].format(...)`` shape while the wording lives in the catalogs.
    """

    def __init__(self, prefix: str):
        self._prefix = prefix + "."

    def __getitem__(self, key: str) -> str:
        try:
            return text(self._prefix + key)
        except KeyError:
            raise KeyError(key) from None

    def __iter__(self):
        return (k[len(self._prefix):] for k in _catalogs["en"] if k.startswith(self._prefix))

    def __len__(self):
        return sum(1 for _ in self)


def catalog(lang: str) -> dict[str, str]:
    return dict(_catalogs.get(normalize(lang), {}))


class LangMiddleware:
    """Pure-ASGI middleware: X-Lang header (or ?lang=) -> language for this request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        raw = None
        for name, value in scope.get("headers", []):
            if name == b"x-lang":
                raw = value.decode("latin-1")
                break
        if raw is None:
            qs = scope.get("query_string", b"").decode("latin-1")
            for part in qs.split("&"):
                if part.startswith("lang="):
                    raw = part[5:]
        token = set_lang(raw)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_lang(token)
