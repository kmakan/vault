"""Integration tests for host routing, API shape and migration safety."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.test import TestCase

from apps.faq.models import FaqItem
from apps.legal.models import LegalDocument
from apps.pages.models import Page, PageBlock
from apps.pricing.models import Plan
from apps.releases.models import Release

from .models import NavigationItem, Redirect, SiteProfile


class SiteRoutingTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.ru = Site.objects.create(domain="vault-msg.ru", name="Vault")
        cls.en = Site.objects.create(domain="vault-msg.tech", name="Vault")
        SiteProfile.objects.create(site=cls.ru, locale="ru", brand_name="Vault RU")
        SiteProfile.objects.create(site=cls.en, locale="en", brand_name="Vault EN")
        NavigationItem.objects.create(
            site=cls.ru, location=NavigationItem.Location.HEADER, label="Тарифы", url="/pricing", order=1
        )
        Page.objects.create(site=cls.ru, slug="home", title="Главная", body_html="<p>RU</p>")
        Page.objects.create(site=cls.en, slug="home", title="Home", body_html="<p>EN</p>")

    def test_host_selects_site_and_locale(self):
        ru = self.client.get("/api/v1/site/", HTTP_HOST="vault-msg.ru")
        en = self.client.get("/api/v1/site/", HTTP_HOST="vault-msg.tech")
        self.assertEqual(ru.status_code, 200)
        self.assertEqual(ru.json()["site"]["locale"], "ru")
        self.assertEqual(ru.json()["site"]["brand"], "Vault RU")
        self.assertEqual(en.json()["site"]["locale"], "en")
        self.assertEqual(en.json()["site"]["brand"], "Vault EN")
        self.assertEqual(ru.json()["navigation"]["header"][0]["url"], "/pricing")

    def test_internal_site_header_selects_edition(self):
        response = self.client.get(
            "/api/v1/site/",
            HTTP_HOST="testserver",
            HTTP_X_SITE_HOST="vault-msg.tech",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["site"]["locale"], "en")
        self.assertEqual(response.json()["site"]["brand"], "Vault EN")

    def test_pages_are_scoped_to_host(self):
        ru = self.client.get("/api/v1/pages/home/", HTTP_HOST="vault-msg.ru")
        en = self.client.get("/api/v1/pages/home/", HTTP_HOST="vault-msg.tech")
        self.assertEqual(ru.json()["title"], "Главная")
        self.assertEqual(en.json()["title"], "Home")

    def test_health(self):
        response = self.client.get("/api/v1/health/", HTTP_HOST="vault-msg.ru")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_sitemap_and_robots_are_host_aware(self):
        sitemap = self.client.get("/sitemap.xml", HTTP_HOST="vault-msg.tech")
        self.assertEqual(sitemap.status_code, 200)
        body = sitemap.content.decode()
        self.assertIn("vault-msg.tech", body)
        robots = self.client.get("/robots.txt", HTTP_HOST="vault-msg.tech")
        self.assertIn("https://vault-msg.tech/sitemap.xml", robots.content.decode())

    def test_legacy_redirect_is_data_driven(self):
        Redirect.objects.create(site=self.ru, old_path="/privacy.html", new_path="/legal/privacy")
        response = self.client.get("/privacy.html", HTTP_HOST="vault-msg.ru")
        self.assertEqual(response.status_code, 301)
        self.assertEqual(response["Location"], "/legal/privacy")

    def test_public_channel_without_source_is_503(self):
        response = self.client.get("/api/v1/public/channels/demo/", HTTP_HOST="vault-msg.ru")
        self.assertEqual(response.status_code, 503)

    def test_public_channel_rejects_unsafe_id(self):
        response = self.client.get("/api/v1/public/channels/../secret/", HTTP_HOST="vault-msg.ru")
        self.assertEqual(response.status_code, 404)


class ContentApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.site = Site.objects.create(domain="vault-msg.ru", name="Vault")
        SiteProfile.objects.create(site=cls.site, locale="ru", brand_name="Vault")
        cls.home = Page.objects.create(
            site=cls.site,
            slug="home",
            title="Vault",
            seo_title="Vault — мессенджер",
            body_html="<p>Тело</p>",
        )
        PageBlock.objects.create(
            page=cls.home,
            key="hero",
            kind="hero",
            title="Герой",
            body_html="<h1>Герой</h1>",
            order=0,
        )
        FaqItem.objects.create(site=cls.site, question="Вопрос?", answer_html="<p>Ответ</p>")
        Release.objects.create(
            site=cls.site,
            platform=Release.Platform.ANDROID,
            channel=Release.Channel.APK,
            version="0.1.294",
            url="https://vault-msg.ru/releases/app.apk",
            is_latest=True,
        )
        Plan.objects.create(
            site=cls.site, code="free", name="Free", price=0, limits={"devices": 1}
        )
        LegalDocument.objects.create(
            site=cls.site,
            kind=LegalDocument.Kind.PRIVACY,
            version="2026-11-10",
            effective_at="2026-11-10",
            title="Политика",
            body_html="<p>Текст</p>",
        )

    def test_page_detail_contains_blocks(self):
        response = self.client.get("/api/v1/pages/home/", HTTP_HOST="vault-msg.ru")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["seo_title"], "Vault — мессенджер")
        self.assertEqual(len(data["blocks"]), 1)
        self.assertEqual(data["blocks"][0]["key"], "hero")

    def test_feature_endpoints(self):
        host = {"HTTP_HOST": "vault-msg.ru"}
        self.assertEqual(self.client.get("/api/v1/faq/", **host).json()["items"][0]["question"], "Вопрос?")
        self.assertEqual(self.client.get("/api/v1/releases/latest/", **host).json()["version"], "0.1.294")
        self.assertEqual(self.client.get("/api/v1/plans/", **host).json()["plans"][0]["code"], "free")
        legal = self.client.get("/api/v1/legal/privacy/", **host)
        self.assertEqual(legal.status_code, 200)
        self.assertEqual(legal.json()["title"], "Политика")

    def test_feedback_creates_and_honeypot_ignores(self):
        payload = {"message": "Здравствуйте, это тестовое сообщение.", "email": "a@example.com"}
        created = self.client.post(
            "/api/v1/feedback/",
            data=payload,
            content_type="application/json",
            HTTP_HOST="vault-msg.ru",
        )
        self.assertEqual(created.status_code, 201)
        from apps.feedback.models import Feedback

        self.assertEqual(Feedback.objects.count(), 1)
        honeypot = self.client.post(
            "/api/v1/feedback/",
            data={**payload, "website": "spam"},
            content_type="application/json",
            HTTP_HOST="vault-msg.ru",
        )
        self.assertEqual(honeypot.status_code, 201)
        self.assertEqual(Feedback.objects.count(), 1)
