"""Import the Sfera user guide markdown into DocPage rows.

The guide stays in git as the source of truth. This command splits it by
level-2 headings, turns each section into a documentation page, and keeps the
original markdown for future exports.

Usage:
    python manage.py import_sfera_docs \
        --source ../sfera/docs/USER-GUIDE-DRAFT.md
"""

from __future__ import annotations

import re
from pathlib import Path

import markdown
from django.contrib.sites.models import Site
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.core.models import NavigationItem
from apps.docs.models import DocPage
from apps.pages.models import Page

SLUGS = {
    "1. Что такое Sfera": "what-is-sfera",
    "2. Установка и первый запуск": "getting-started",
    "3. Где Sfera хранит данные": "data-and-backup",
    "4. Настройка почты": "email",
    "5. Интерфейс": "interface",
    "6. Контакты и сферы": "contacts-and-spheres",
    "7. Публикации, лента и обсуждения": "posts-and-feed",
    "8. Профиль и хранилище": "profile-and-storage",
    "9. Публичные каналы (в разработке)": "public-channels",
    "10. Платные каналы и монетизация (планы)": "paid-channels",
    "11. Приватность и безопасность": "privacy",
    "12. Ограничения текущей версии": "limitations",
    "13. Если что-то не работает": "troubleshooting",
    "14. Словарь": "glossary",
}

# Section 15 is an internal checklist for publishing this very guide; it is
# not user documentation and must not appear on the public site.
EXCLUDED = {"15. Что нужно для публикации этого руководства на сайте"}


def first_paragraph(text: str) -> str:
    for block in re.split(r"\n\s*\n", text):
        clean = block.strip()
        if not clean or clean.startswith(("#", "```", "|", "-", ">", "|")):
            continue
        clean = re.sub(r"[*_`]", "", clean)
        clean = re.sub(r"\s+", " ", clean).strip()
        if clean:
            return clean[:300]
    return ""


class Command(BaseCommand):
    help = "Import the Sfera user guide into documentation pages."

    def add_arguments(self, parser):
        parser.add_argument(
            "--source",
            default=str(Path(__file__).resolve().parents[4] / "sfera/docs/USER-GUIDE-DRAFT.md"),
        )
        parser.add_argument("--domain", default="vault-msg.ru")
        parser.add_argument("--locale", default="ru")

    def handle(self, *args, **options):
        source = Path(options["source"]).resolve()
        if not source.exists():
            raise CommandError(f"Guide not found: {source}")
        text = source.read_text(encoding="utf-8")
        site = Site.objects.get(domain=options["domain"])
        sections = re.split(r"^## ", text, flags=re.MULTILINE)
        imported = 0
        with transaction.atomic():
            DocPage.objects.filter(site=site, product="sfera").delete()
            for order, chunk in enumerate(sections[1:], start=1):
                lines = chunk.splitlines()
                title = lines[0].strip()
                if title in EXCLUDED or not title:
                    continue
                body_md = "\n".join(lines[1:]).strip()
                slug = SLUGS.get(title)
                if not slug:
                    continue
                body_html = markdown.markdown(
                    body_md,
                    extensions=["extra", "sane_lists"],
                    output_format="html",
                )
                DocPage.objects.create(
                    site=site,
                    product="sfera",
                    slug=slug,
                    title=title.split(". ", 1)[-1],
                    summary=first_paragraph(body_md),
                    body_markdown=body_md,
                    body_html=body_html,
                    version="0.1.0",
                    order=order,
                    is_published=True,
                )
                imported += 1
        self.stdout.write(
            self.style.SUCCESS(f"Imported {imported} Sfera documentation pages for {site.domain}.")
        )
        self.create_landing(site)

    def create_landing(self, site: Site) -> None:
        Page.objects.update_or_create(
            site=site,
            slug="sfera",
            defaults={
                "title": "Sfera",
                "subtitle": "Распределённая социальная сеть на вашей почте",
                "seo_title": "Sfera — социальная сеть на вашей почте",
                "seo_description": "Лента, сферы и публичные каналы Sfera. Личные посты шифруются, данные остаются у вас.",
                "canonical_path": "/sfera",
                "body_html": (
                    '<p class="lead">Sfera — отдельное приложение: лента, круги получателей '
                    "и публичные страницы. Личные посты шифруются для выбранной аудитории, "
                    "публичные — открыты по замыслу. Это не замена чатам Vault.</p>"
                    '<div class="cards">'
                    '<div class="card"><h3>Начало работы</h3><p>Установка, первый запуск, '
                    'ключ устройства и резервная копия.</p><p><a class="btn btn-primary" '
                    'href="/docs/getting-started">Открыть руководство</a></p></div>'
                    '<div class="card"><h3>Почта и контакты</h3><p>SMTP/IMAP, приглашения, '
                    'сферы и роли.</p><p><a class="btn btn-ghost" href="/docs/email">Настроить почту</a></p></div>'
                    '<div class="card"><h3>Публичные каналы</h3><p>Что уже готово в ядре и '
                    'чего ещё нет в интерфейсе.</p><p><a class="btn btn-ghost" '
                    'href="/docs/public-channels">Подробнее</a></p></div>'
                    "</div>"
                    '<p><a class="btn btn-primary" href="/docs">Все разделы руководства</a></p>'
                ),
            },
        )
        NavigationItem.objects.get_or_create(
            site=site,
            location=NavigationItem.Location.HEADER,
            label="Sfera",
            defaults={"url": "/sfera", "order": 100},
        )

