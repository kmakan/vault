"""Import the Vault user guide from docs/USER-GUIDE.md into DocPage rows."""

from __future__ import annotations

import re
from pathlib import Path

import markdown
from django.contrib.sites.models import Site
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.docs.models import DocPage

SLUGS = {
    "1. Установка": "install",
    "2. Вход": "login",
    "3. Профиль и ID": "profile-and-id",
    "4. Добавление контакта (обмен ключами)": "contacts",
    "5. Чаты и сообщения": "chats",
    "6. Группы": "groups",
    "7. Звонки": "calls",
    "8. Релей (ускоренная доставка)": "relay",
    "9. Экономный режим (батарея)": "battery",
    "10. Приватность и защита": "privacy",
    "11. Почтовые папки": "mail-folders",
    "12. Частые вопросы": "faq",
    "13. Устранение неполадок": "troubleshooting",
}


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
    help = "Import the Vault user guide into documentation pages."

    def add_arguments(self, parser):
        parser.add_argument(
            "--source",
            default=str(Path(__file__).resolve().parents[4] / "docs/USER-GUIDE.md"),
        )
        parser.add_argument("--domain", default="vault-msg.ru")
        parser.add_argument("--locale", default="ru")

    def handle(self, *args, **options):
        source = Path(options["source"]).resolve()
        if not source.exists():
            raise CommandError(f"Vault guide not found: {source}")
        text = source.read_text(encoding="utf-8")
        site = Site.objects.get(domain=options["domain"])
        version_match = re.search(r"Версия руководства:\s*([0-9.]+)", text)
        version = version_match.group(1) if version_match else ""
        sections = re.split(r"^## ", text, flags=re.MULTILINE)
        imported = 0
        with transaction.atomic():
            DocPage.objects.filter(site=site, product="vault").delete()
            for order, chunk in enumerate(sections[1:], start=1):
                lines = chunk.splitlines()
                title = lines[0].strip()
                slug = SLUGS.get(title)
                if not slug:
                    continue
                body_md = "\n".join(lines[1:]).strip()
                DocPage.objects.create(
                    site=site,
                    product="vault",
                    slug=slug,
                    title=title.split(". ", 1)[-1],
                    summary=first_paragraph(body_md),
                    body_markdown=body_md,
                    body_html=markdown.markdown(
                        body_md,
                        extensions=["extra", "sane_lists"],
                        output_format="html",
                    ),
                    version=version,
                    order=order,
                    is_published=True,
                )
                imported += 1
        self.stdout.write(
            self.style.SUCCESS(f"Imported {imported} Vault documentation pages for {site.domain}.")
        )
