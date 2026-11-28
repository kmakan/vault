"""Regression tests for importing the user guide."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

from django.contrib.sites.models import Site
from django.core.management import call_command
from django.test import TestCase

from apps.docs.models import DocPage


class SferaGuideImportTests(TestCase):
    def test_current_public_channels_heading_is_not_dropped(self):
        Site.objects.create(domain="vault-msg.ru", name="Vault")
        with TemporaryDirectory() as directory:
            source = Path(directory) / "guide.md"
            source.write_text(
                "# Guide\n\n## 9. Публичные каналы\n\n"
                "Публичный канал — открытая страница.\n\n"
                "## 10. Платные каналы и монетизация (планы)\n\nТекст.\n",
                encoding="utf-8",
            )
            call_command("import_sfera_docs", source=str(source), domain="vault-msg.ru")
        page = DocPage.objects.get(slug="public-channels", product="sfera")
        self.assertEqual(page.title, "Публичные каналы")
        self.assertIn("открытая страница", page.summary)
