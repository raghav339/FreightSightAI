"""Server-side localisation: catalog parity, placeholder safety, request-language plumbing."""
import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import i18n  # noqa: E402
from app.decision_text import (  # noqa: E402
    build_congestion_text, build_contract_text, build_prediction_text, build_rejection_reason,
)

LANGS = [c for c in i18n.SUPPORTED if c != "en"]
NATIVE_DIGITS = re.compile("[\u09e6-\u09ef\u0b66-\u0b6f\u0c66-\u0c6f\u0be6-\u0bef]")
FIELD = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)(?:![rs])?(?::[^}]*)?\}")
SCRIPT = {"bn": "\u0980-\u09ff", "or": "\u0b00-\u0b7f", "te": "\u0c00-\u0c7f", "ta": "\u0b80-\u0bff"}


def fields(template):
    return sorted(FIELD.findall(template))


def specs(template):
    return sorted(re.findall(r"\{[A-Za-z_][A-Za-z0-9_]*(:[^}]*)\}", template))


class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cat = {c: i18n.catalog(c) for c in i18n.SUPPORTED}

    def test_every_language_has_every_key(self):
        en = set(self.cat["en"])
        for lang in LANGS:
            self.assertEqual(en - set(self.cat[lang]), set(), f"{lang}: missing keys")
            self.assertEqual(set(self.cat[lang]) - en, set(), f"{lang}: keys not in English")

    def test_placeholders_and_format_specs_match_english(self):
        for key, en_tpl in self.cat["en"].items():
            for lang in LANGS:
                tpl = self.cat[lang][key]
                self.assertEqual(fields(tpl), fields(en_tpl), f"{lang}:{key} placeholders differ")
                self.assertEqual(specs(tpl), specs(en_tpl), f"{lang}:{key} format specs differ")

    def test_every_template_formats(self):
        # a stray brace or a wrong spec would raise at request time
        for lang, cat in self.cat.items():
            for key, tpl in cat.items():
                params = {f: 1.5 for f in fields(tpl)}
                tpl.format(**params)

    def test_latin_digits_only(self):
        for lang in LANGS:
            for key, tpl in self.cat[lang].items():
                self.assertIsNone(NATIVE_DIGITS.search(tpl), f"{lang}:{key} uses non-Latin digits")

    def test_translations_are_really_in_the_language(self):
        for lang in LANGS:
            rx = re.compile(f"[{SCRIPT[lang]}]")
            untranslated = [k for k, v in self.cat[lang].items() if not rx.search(v)]
            self.assertEqual(untranslated, [], f"{lang}: entries without any {lang} script")


class RequestLanguageTests(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(i18n.normalize("bn-IN,en;q=0.8"), "bn")
        self.assertEqual(i18n.normalize("OD"), "or")
        self.assertEqual(i18n.normalize("fr"), "en")
        self.assertEqual(i18n.normalize(None), "en")

    def test_builders_follow_the_current_language(self):
        kw = dict(commodity="Coal", destination="Paradip", forecast=12.34, risk="medium", direction="rise",
                  note="n", vessel="Panamax", turnaround=6, pct_move=0.05)
        en = build_prediction_text(**kw)
        self.assertIn("Charter within", en[1])
        for lang in LANGS:
            token = i18n.set_lang(lang)
            try:
                summary, window, vessel, idle = build_prediction_text(**kw)
            finally:
                i18n.reset_lang(token)
            rx = re.compile(f"[{SCRIPT[lang]}]")
            for part in (summary, window, vessel, idle):
                self.assertRegex(part, rx, lang)
            self.assertIn("12.34", summary)
            self.assertIn("Paradip", summary)
            self.assertNotEqual(window, en[1])
        self.assertEqual(i18n.get_lang(), "en")  # reset restored the default

    def test_congestion_text_parses_english_canonical_form(self):
        canon = "Load port Haldia: high congestion risk — busy | Discharge port Paradip: medium congestion risk — x"
        self.assertIn("Load port Haldia: high congestion risk", build_congestion_text(canon))
        token = i18n.set_lang("ta")
        try:
            out = build_congestion_text(canon)
        finally:
            i18n.reset_lang(token)
        self.assertIn("Haldia", out)
        self.assertIn("Paradip", out)
        self.assertRegex(out, "[\u0b80-\u0bff]")
        self.assertNotIn("congestion risk", out)

    def test_rejection_and_contract_text(self):
        token = i18n.set_lang("te")
        try:
            r = build_rejection_reason(kind="draft", vessel="Capesize", port="Haldia", value=18.0, limit=8.5)
            c = build_contract_text(pct_move=0.1, risk="low", duration_note=" (6 months)",
                                    cargo_weight_tons=50000, total_program_tons=300000)
        finally:
            i18n.reset_lang(token)
        self.assertIn("Haldia", r)
        self.assertRegex(r, "[\u0c00-\u0c7f]")
        self.assertIn("6 voyages".split()[0], c)  # program of 6 voyages rendered with Latin digits
        self.assertRegex(c, "[\u0c00-\u0c7f]")


class MiddlewareTests(unittest.TestCase):
    def test_x_lang_header_sets_language_for_sync_endpoints(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.add_middleware(i18n.LangMiddleware)

        @app.get("/who")
        def who():  # sync endpoint -> runs in a worker thread
            return {"lang": i18n.get_lang(), "text": i18n.t("errors.model_incomplete")}

        client = TestClient(app)
        self.assertEqual(client.get("/who").json()["lang"], "en")
        r = client.get("/who", headers={"X-Lang": "bn"}).json()
        self.assertEqual(r["lang"], "bn")
        self.assertRegex(r["text"], "[\u0980-\u09ff]")
        self.assertEqual(client.get("/who?lang=or").json()["lang"], "or")
        self.assertEqual(client.get("/who", headers={"X-Lang": "xx"}).json()["lang"], "en")
        self.assertEqual(client.get("/who").json()["lang"], "en")  # nothing leaks between requests


if __name__ == "__main__":
    unittest.main()
