"""Verify that the legacy HTML was imported without losing visible text.

Run with the project virtualenv:
    python scripts/verify_import.py --source /home/maksim/vault-site
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import django  # noqa: E402

django.setup()

from bs4 import BeautifulSoup  # noqa: E402
from django.contrib.sites.models import Site  # noqa: E402

from apps.faq.models import FaqItem  # noqa: E402
from apps.legal.models import LegalDocument  # noqa: E402
from apps.pages.models import Page  # noqa: E402
from apps.pricing.models import Plan  # noqa: E402
from apps.releases.models import Release  # noqa: E402


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def text(html: str) -> str:
    return norm(BeautifulSoup(html or "", "html.parser").get_text(" "))


def ratio(expected: str, actual: str) -> float:
    expected = norm(expected)
    actual = norm(actual)
    if not expected:
        return 1.0
    # Character-level containment: imported text may add separators, but it
    # must contain every meaningful character of the source.
    missing = sum(1 for ch in expected if ch not in actual)
    return 1.0 - missing / len(expected)


def check_site(domain: str, index_path: Path) -> list[str]:
    problems: list[str] = []
    site = Site.objects.get(domain=domain)
    soup = BeautifulSoup(index_path.read_text(encoding="utf-8"), "html.parser")
    page = Page.objects.get(site=site, slug="home")
    blocks = list(page.blocks.all())
    sections = soup.select("main section[id], body section[id]")
    if len(blocks) != len(sections):
        problems.append(f"{domain}: blocks {len(blocks)} != sections {len(sections)}")
    for section, block in zip(sections, blocks):
        expected = text(str(section))
        actual = text(block.body_html)
        r = ratio(expected, actual)
        if r < 0.999:
            problems.append(f"{domain}: block {block.key} coverage {r:.4f}")
    faq = list(FaqItem.objects.filter(site=site))
    details = soup.select("details")
    if len(faq) != len(details):
        problems.append(f"{domain}: faq {len(faq)} != details {len(details)}")
    for item, detail in zip(faq, details):
        expected = text(str(detail))
        actual = norm(item.question + " " + text(item.answer_html))
        if ratio(expected, actual) < 0.995:
            problems.append(f"{domain}: faq lost text: {item.question[:40]}")
    releases = list(Release.objects.filter(site=site))
    if len(releases) != 2:
        problems.append(f"{domain}: expected 2 releases, got {len(releases)}")
    plans = list(Plan.objects.filter(site=site))
    if len(plans) != 3:
        problems.append(f"{domain}: expected 3 plans, got {len(plans)}")
    legal = list(LegalDocument.objects.filter(site=site))
    if len(legal) != 5:
        problems.append(f"{domain}: expected 5 legal docs, got {len(legal)}")
    for doc in legal:
        legacy_name = {"privacy": "privacy.html", "terms": "terms.html", "offer": "offer.html", "pd": "pd.html", "requisites": "requisites.html"}[doc.kind]
        legacy = BeautifulSoup((index_path.parent / legacy_name).read_text(encoding="utf-8"), "html.parser")
        main = legacy.find("main")
        container = main.find("div", class_="container")
        expected = text(str(container))
        actual = norm(doc.title + " " + text(doc.body_html))
        if ratio(expected, actual) < 0.995:
            problems.append(f"{domain}: legal {doc.kind} lost text")
    pricing = BeautifulSoup((index_path.parent / "pricing.html").read_text(encoding="utf-8"), "html.parser")
    pricing_main = pricing.find("main").find("div", class_="container")
    pricing_h1 = pricing_main.find("h1")
    pricing_title = norm(pricing_h1.get_text(" ")) if pricing_h1 else ""
    if pricing_h1:
        pricing_h1.extract()
    pricing_page = Page.objects.get(site=site, slug="pricing")
    if ratio(text(str(pricing_main)), norm(pricing_title + " " + text(pricing_page.body_html))) < 0.995:
        problems.append(f"{domain}: pricing page lost text")
    pay = BeautifulSoup((index_path.parent / "pay.html").read_text(encoding="utf-8"), "html.parser")
    pay_main = pay.find("main").find("div", class_="container")
    pay_h1 = pay_main.find("h1")
    pay_title = norm(pay_h1.get_text(" ")) if pay_h1 else ""
    if pay_h1:
        pay_h1.extract()
    pay_page = Page.objects.get(site=site, slug="pay")
    if ratio(text(str(pay_main)), norm(pay_title + " " + text(pay_page.body_html))) < 0.995:
        problems.append(f"{domain}: pay page lost text")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="/home/maksim/vault-site")
    args = parser.parse_args()
    source = Path(args.source)
    problems = check_site("vault-msg.ru", source / "index.html") + check_site(
        "vault-msg.tech", source / "en" / "index.html"
    )
    if problems:
        print("FAIL")
        for problem in problems:
            print(" -", problem)
        return 1
    print("OK: RU and EN content imported without visible text loss.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
