"""Contract tests for the public-channel proxy."""

from __future__ import annotations

from unittest.mock import patch

from django.contrib.sites.models import Site
from django.test import TestCase

from .models import PublicChannelSource


class PublicChannelApiTests(TestCase):
    def setUp(self):
        Site.objects.create(domain="vault-msg.ru", name="Vault")
        self.source = PublicChannelSource.objects.create(
            name="test",
            base_url="http://127.0.0.1:8095",
            is_enabled=True,
        )

    @patch("apps.public_channels.views.fetch_verified")
    def test_list_returns_verified_channel_summaries(self, fetch):
        fetch.return_value = {
            "channels": [
                {
                    "id": "news",
                    "title": "Новости",
                    "description": "Описание",
                    "creator_fp": "aa:bb",
                    "created_at": 100,
                    "posts": 1,
                    "latest_ts": 200,
                }
            ]
        }
        response = self.client.get("/api/v1/public/channels/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["channels"][0]["id"], "news")
        fetch.assert_called_once_with("/sfera/public/channels")

    @patch("apps.public_channels.views.fetch_verified")
    def test_detail_returns_signed_feed_shape(self, fetch):
        fetch.return_value = {
            "v": 1,
            "channel": {"id": "news", "title": "Новости", "description": ""},
            "posts": [{"id": "post-1", "ts": 200, "body": "Привет"}],
        }
        response = self.client.get("/api/v1/public/channels/news/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["posts"][0]["body"], "Привет")
        fetch.assert_called_once_with("/sfera/public/channels/news")

    @patch("apps.public_channels.views.fetch_verified", side_effect=ConnectionError)
    def test_upstream_failure_is_not_an_empty_catalog(self, _fetch):
        response = self.client.get("/api/v1/public/channels/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "unavailable")

    @patch("apps.core.sitemaps.fetch_verified")
    def test_sitemap_contains_public_channel(self, fetch):
        fetch.return_value = {"channels": [{"id": "news", "title": "Новости"}]}
        response = self.client.get("/sitemap.xml", HTTP_HOST="vault-msg.ru")
        self.assertEqual(response.status_code, 200)
        self.assertIn("/sfera/channels/news", response.content.decode())
