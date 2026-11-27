"""Import the legacy static site into the Django content model.

The importer is intentionally lossless: every section of the landing page is
stored as a ``PageBlock`` with its original HTML, while FAQ, releases, plans
and legal documents are additionally extracted into their feature apps. The
blocks are the migration safety net; the structured rows are what the Vue SSR
frontend will use first.

Usage:
    python manage.py import_legacy_site --source /home/maksim/vault-site
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

from bs4 import BeautifulSoup, Tag
from django.contrib.sites.models import Site
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.core.models import NavigationItem, Redirect, SiteProfile
from apps.faq.models import FaqItem
from apps.legal.models import LegalDocument
from apps.pages.models import Page, PageBlock
from apps.pricing.models import Plan
from apps.releases.models import Release

MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11,
    "декабря": 12,
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
}

LEGAL_PAGES = {
    "privacy.html": LegalDocument.Kind.PRIVACY,
    "terms.html": LegalDocument.Kind.TERMS,
    "offer.html": LegalDocument.Kind.OFFER,
    "pd.html": LegalDocument.Kind.PERSONAL_DATA,
    "requisites.html": LegalDocument.Kind.REQUISITES,
}

REDIRECTS = {
    "/index.html": "/",
    "/pricing.html": "/pricing",
    "/pay.html": "/pay",
    "/privacy.html": "/legal/privacy",
    "/terms.html": "/legal/terms",
    "/offer.html": "/legal/offer",
    "/pd.html": "/legal/pd",
    "/requisites.html": "/legal/requisites",
}

PAGE_SLUGS = {"pricing.html": "pricing", "pay.html": "pay"}


def inner_html(tag: Tag | None) -> str:
    if tag is None:
        return ""
    return "".join(str(child) for child in tag.contents).strip()


def text_of(tag: Tag | None) -> str:
    if tag is None:
        return ""
    return " ".join(tag.get_text(" ", strip=True).split())


def parse_date(text: str) -> date | None:
    match = re.search(r"(\d{1,2})\s+([A-Za-zА-Яа-яЁё]+)\s+(\d{4})", text)
    if not match:
        return None
    month = MONTHS.get(match.group(2).lower())
    if month is None:
        return None
    return date(int(match.group(3)), month, int(match.group(1)))


def absolute(domain: str, href: str) -> str:
    if href.startswith("http://") or href.startswith("https://"):
        return href
    if href.startswith("/"):
        return f"https://{domain}{href}"
    return href


def rewrite_url(url: str) -> str:
    if url in REDIRECTS:
        return REDIRECTS[url]
    return url


class Command(BaseCommand):
    help = "Import the legacy static Vault site into Django models (RU + EN)."

    def add_arguments(self, parser):
        parser.add_argument("--source", default="/home/maksim/vault-site")
        parser.add_argument("--ru-domain", default="vault-msg.ru")
        parser.add_argument("--en-domain", default="vault-msg.tech")

    def handle(self, *args, **options):
        source = Path(options["source"])
        if not (source / "index.html").exists():
            raise CommandError(f"Legacy index.html not found under {source}")
        self.source = source
        with transaction.atomic():
            self.import_edition(options["ru_domain"], source / "index.html", "ru")
            self.import_edition(options["en_domain"], source / "en" / "index.html", "en")
        self.stdout.write(self.style.SUCCESS("Legacy site imported for RU and EN editions."))

    # ------------------------------------------------------------------
    def import_edition(self, domain: str, index_path: Path, locale: str) -> None:
        if not index_path.exists():
            raise CommandError(f"Missing edition index: {index_path}")
        site, _ = Site.objects.update_or_create(domain=domain, defaults={"name": "Vault"})
        soup = BeautifulSoup(index_path.read_text(encoding="utf-8"), "html.parser")
        title = text_of(soup.find("title"))
        description = self.meta(soup, "description")
        og_image = self.meta_property(soup, "og:image") or "/og-image.png"
        contact = self.first_mailto(soup)

        SiteProfile.objects.update_or_create(
            site=site,
            defaults={
                "locale": locale,
                "brand_name": "Vault",
                "tagline": text_of(soup.select_one(".hero .lead"))[:200],
                "contact_email": contact,
                "default_seo_title": title[:200],
                "default_seo_description": description,
                "og_image_path": og_image,
                "is_active": True,
            },
        )

        # Clean previous import for this edition, keeping unrelated admin data.
        Page.objects.filter(site=site).delete()
        NavigationItem.objects.filter(site=site).delete()
        Redirect.objects.filter(site=site).delete()
        FaqItem.objects.filter(site=site).delete()
        Release.objects.filter(site=site).delete()
        Plan.objects.filter(site=site).delete()
        LegalDocument.objects.filter(site=site).delete()

        self.import_navigation(site, soup)
        self.import_home(site, soup, title, description, og_image)
        self.import_faq(site, soup)
        self.import_releases(site, soup, domain)
        self.import_static_pages(site, index_path.parent)
        self.import_plans(site, index_path.parent / "pricing.html")
        self.import_legal(site, index_path.parent)
        self.import_redirects(site)

    # ------------------------------------------------------------------
    @staticmethod
    def meta(soup: BeautifulSoup, name: str) -> str:
        tag = soup.find("meta", attrs={"name": name})
        return (tag.get("content") or "").strip() if tag else ""

    @staticmethod
    def meta_property(soup: BeautifulSoup, prop: str) -> str:
        tag = soup.find("meta", attrs={"property": prop})
        return (tag.get("content") or "").strip() if tag else ""

    @staticmethod
    def first_mailto(soup: BeautifulSoup) -> str:
        for link in soup.select('a[href^="mailto:"]'):
            return (link.get("href") or "").removeprefix("mailto:").split("?")[0]
        return ""

    # ------------------------------------------------------------------
    def import_navigation(self, site: Site, soup: BeautifulSoup) -> None:
        header = soup.select("header .nav-links a")
        footer = soup.select("footer .foot .links a")
        for order, link in enumerate(header):
            href = (link.get("href") or "").strip()
            NavigationItem.objects.create(
                site=site,
                location=NavigationItem.Location.HEADER,
                label=text_of(link),
                url=rewrite_url(href),
                order=order,
                is_external=href.startswith("http"),
            )
        NavigationItem.objects.create(
            site=site,
            location=NavigationItem.Location.HEADER,
            label="Sfera",
            url="/sfera",
            order=len(header),
        )
        NavigationItem.objects.create(
            site=site,
            location=NavigationItem.Location.HEADER,
            label="Vault",
            url="/vault",
            order=len(header) + 1,
        )
        legal_paths = {"/privacy", "/terms", "/offer", "/legal/privacy", "/legal/terms", "/legal/offer", "/legal/pd", "/legal/requisites"}
        for order, link in enumerate(footer):
            href = (link.get("href") or "").strip()
            rewritten = rewrite_url(href)
            location = (
                NavigationItem.Location.LEGAL
                if rewritten in legal_paths or any(rewritten.startswith(p) for p in ("/legal/",))
                else NavigationItem.Location.FOOTER
            )
            NavigationItem.objects.create(
                site=site,
                location=location,
                label=text_of(link),
                url=rewritten,
                order=order,
                is_external=href.startswith("http"),
            )

    # ------------------------------------------------------------------
    def import_home(self, site: Site, soup: BeautifulSoup, title: str, description: str, og_image: str) -> None:
        page = Page.objects.create(
            site=site,
            slug="home",
            title=title,
            subtitle=description,
            seo_title=title,
            seo_description=description,
            canonical_path="/",
            og_image_path=og_image,
        )
        sections = soup.select("main section[id], body section[id]")
        for order, section in enumerate(sections):
            key = section.get("id") or f"section-{order}"
            h2 = section.find("h2")
            h1 = section.find("h1")
            sub = section.select_one("p.sub, p.lead")
            PageBlock.objects.create(
                page=page,
                key=key,
                kind="hero" if key == "top" else key,
                title=text_of(h2 or h1),
                subtitle=text_of(sub),
                body_html=inner_html(section),
                data={
                    "legacy_id": key,
                    "class": " ".join(section.get("class") or []),
                    "style": section.get("style") or "",
                },
                order=order,
            )

    # ------------------------------------------------------------------
    def import_faq(self, site: Site, soup: BeautifulSoup) -> None:
        for order, details in enumerate(soup.select("details")):
            summary = details.find("summary")
            question = text_of(summary)
            if not question:
                continue
            if summary is not None:
                summary.extract()
            FaqItem.objects.create(
                site=site,
                product="vault",
                question=question[:300],
                answer_html=inner_html(details),
                order=order,
            )

    # ------------------------------------------------------------------
    def import_releases(self, site: Site, soup: BeautifulSoup, domain: str) -> None:
        section = soup.find("section", id="download")
        if section is None:
            return
        version_match = re.search(r"\d+\.\d+\.\d+", text_of(section))
        version = version_match.group(0) if version_match else "0.1.294"
        published = parse_date(text_of(section))
        published_at = (
            datetime(published.year, published.month, published.day, tzinfo=timezone.utc)
            if published
            else None
        )
        platform_names = {
            "android": Release.Platform.ANDROID,
            "linux": Release.Platform.LINUX,
            "macos": Release.Platform.MACOS,
            "windows": Release.Platform.WINDOWS,
        }
        for order, card in enumerate(section.select(".dl-card")):
            heading = text_of(card.find("h3")).lower()
            platform = next((value for key, value in platform_names.items() if key in heading), None)
            button = card.find("a", class_="btn")
            if platform is None or button is None:
                continue
            href = (button.get("href") or "").strip()
            if not href or href.startswith("#"):
                continue
            url = absolute(domain, href)
            secondary = card.select_one(".req a")
            secondary_url = ""
            secondary_label = ""
            if secondary is not None:
                candidate = absolute(domain, (secondary.get("href") or "").strip())
                if candidate != url:
                    secondary_url = candidate
                    secondary_label = text_of(secondary)
            Release.objects.create(
                site=site,
                product="vault",
                platform=platform,
                channel=Release.Channel.APK if platform == Release.Platform.ANDROID else Release.Channel.DESKTOP,
                version=version,
                url=url,
                requirements=text_of(card.find("p"))[:200],
                cta_label=text_of(button)[:120],
                secondary_url=secondary_url,
                secondary_label=secondary_label,
                notes_html=inner_html(card),
                published_at=published_at,
                is_latest=True,
                order=order,
            )

    # ------------------------------------------------------------------
    def import_static_pages(self, site: Site, root: Path) -> None:
        """Import pricing/pay as pages; scripts are preserved but not executed."""
        for filename, slug in PAGE_SLUGS.items():
            path = root / filename
            if not path.exists():
                continue
            soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
            main = soup.find("main")
            container = main.find("div", class_="container") if main is not None else None
            if container is None:
                continue
            h1 = container.find("h1")
            title = text_of(h1) or text_of(soup.find("title"))
            if h1 is not None:
                h1.extract()
            page = Page.objects.create(
                site=site,
                slug=slug,
                title=title[:200],
                seo_title=text_of(soup.find("title"))[:200],
                seo_description=self.meta(soup, "description"),
                canonical_path=REDIRECTS.get(f"/{filename}", f"/{slug}"),
                body_html=inner_html(container),
            )
            scripts = [script.string or "" for script in soup.find_all("script") if script.string]
            if scripts:
                PageBlock.objects.create(
                    page=page,
                    key="legacy-script",
                    kind="script",
                    title="Legacy inline script",
                    body_html="\n".join(scripts),
                    data={"note": "Preserved for migration; not executed by Vue SSR."},
                    order=100,
                )

    # ------------------------------------------------------------------
    def import_plans(self, site: Site, pricing_path: Path) -> None:
        if not pricing_path.exists():
            return
        soup = BeautifulSoup(pricing_path.read_text(encoding="utf-8"), "html.parser")
        for order, plan in enumerate(soup.select(".plans .plan")):
            tag = text_of(plan.select_one(".tag")).lower() or f"plan-{order}"
            name = text_of(plan.find("h3")) or tag.title()
            price_text = text_of(plan.select_one(".price"))
            price_match = re.search(r"([\d\s]+)", price_text.replace("\xa0", " "))
            price = Decimal(price_match.group(1).replace(" ", "")) if price_match else Decimal("0")
            features = [text_of(li) for li in plan.select("ul li") if text_of(li)]
            year = text_of(plan.select_one(".year"))
            limits = {}
            for feature in features:
                lower = feature.lower()
                numbers = [int(n.replace(" ", "")) for n in re.findall(r"\d[\d\s]*", feature)]
                if not numbers:
                    continue
                n = numbers[0]
                if "действ" in lower:
                    limits["relay_actions_per_day"] = n
                elif "устройств" in lower:
                    limits["devices"] = n
                elif "пост" in lower:
                    limits["posts_per_day"] = n
            foot = plan.select_one(".foot")
            cta = foot.find("a") if foot is not None else None
            Plan.objects.create(
                site=site,
                product="vault",
                code=tag,
                name=name,
                price=price,
                period=Plan.Period.MONTH if price > 0 else Plan.Period.ONCE,
                limits=limits,
                features=features,
                cta_label=text_of(cta)[:120] if cta is not None else "",
                cta_url=rewrite_url((cta.get("href") or "").strip()) if cta is not None else "",
                order=order,
            )

    # ------------------------------------------------------------------
    def import_legal(self, site: Site, root: Path) -> None:
        for filename, kind in LEGAL_PAGES.items():
            path = root / filename
            if not path.exists():
                continue
            soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
            main = soup.find("main")
            container = main.find("div", class_="container") if main is not None else None
            if container is None:
                continue
            h1 = container.find("h1")
            title = text_of(h1) or text_of(soup.find("title"))
            if h1 is not None:
                h1.extract()
            updated_text = text_of(container.select_one(".updated"))
            effective = parse_date(updated_text) or date.fromtimestamp(path.stat().st_mtime)
            LegalDocument.objects.create(
                site=site,
                kind=kind,
                version=effective.isoformat(),
                effective_at=effective,
                title=title[:200],
                body_html=inner_html(container),
            )
            # Also keep a page-level copy for the migration period.
            Page.objects.create(
                site=site,
                slug=str(kind),
                title=title[:200],
                seo_title=title[:200],
                canonical_path=REDIRECTS.get(f"/{filename}", f"/legal/{kind}"),
                body_html=inner_html(container),
            )

    # ------------------------------------------------------------------
    def import_redirects(self, site: Site) -> None:
        for old, new in REDIRECTS.items():
            Redirect.objects.create(site=site, old_path=old, new_path=new, status_code=301)
