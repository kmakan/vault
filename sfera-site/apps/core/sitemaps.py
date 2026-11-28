"""Sitemap entries scoped to the current public site."""

from __future__ import annotations

from django.contrib.sitemaps import Sitemap
from django.contrib.sites.models import Site

from apps.docs.models import DocPage
from apps.public_channels.views import CHANNEL_ID, configured_source, fetch_verified
from apps.legal.models import LegalDocument
from apps.pages.models import Page


def current_site(site: Site | None) -> Site:
    if site is not None:
        return site
    site = Site.objects.order_by("id").first()
    if site is None:
        raise Site.DoesNotExist("No Site rows; run bootstrap/migrations first")
    return site


class SiteSitemap(Sitemap):
    changefreq = "weekly"
    priority = 0.7
    protocol = "https"

    def get_urls(self, page=1, site=None, protocol=None):
        self._site = current_site(site)
        return super().get_urls(page, site, "https")

    @property
    def site(self) -> Site:
        return getattr(self, "_site", None) or current_site(None)


class PageSitemap(SiteSitemap):
    priority = 0.9

    def items(self):
        return Page.objects.filter(
            site=self.site,
            is_published=True,
            slug__in=("home", "pricing", "pay", "sfera"),
        )

    def location(self, item: Page) -> str:
        return "/" if item.slug == "home" else f"/{item.slug}"

    def lastmod(self, item: Page):
        return item.updated_at


class DocSitemap(SiteSitemap):
    priority = 0.8

    def items(self):
        return DocPage.objects.filter(site=self.site, is_published=True)

    def location(self, item: DocPage) -> str:
        prefix = "/vault/docs" if item.product == "vault" else "/sfera/docs"
        return f"{prefix}/{item.slug}"

    def lastmod(self, item: DocPage):
        return item.updated_at


class PublicChannelSitemap(SiteSitemap):
    priority = 0.8

    def items(self):
        if configured_source() is None:
            return []
        try:
            payload = fetch_verified("/sfera/public/channels")
        except (LookupError, ConnectionError):
            # SEO discovery must not fail when the optional vitrine is down.
            return []
        return [
            channel
            for channel in payload.get("channels", [])
            if isinstance(channel, dict)
            and isinstance(channel.get("id"), str)
            and CHANNEL_ID.fullmatch(channel["id"])
        ]

    def location(self, item: dict) -> str:
        return f"/sfera/channels/{item['id']}"


class LegalSitemap(SiteSitemap):
    priority = 0.5

    def items(self):
        # One latest version per kind.
        seen = set()
        result = []
        for doc in LegalDocument.objects.filter(site=self.site, is_published=True).order_by(
            "kind", "-effective_at", "-id"
        ):
            if doc.kind in seen:
                continue
            seen.add(doc.kind)
            result.append(doc)
        return result

    def location(self, item: LegalDocument) -> str:
        return f"/legal/{item.kind}"

    def lastmod(self, item: LegalDocument):
        return item.updated_at
