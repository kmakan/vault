"""Import legacy FAQ entries as documentation pages for the Vault product.

The landing page's FAQ block is a real user guide (installation, login,
contacts, calls, relay, ...). It is kept in the landing PageBlock and
additionally exposed as Vault documentation under /vault/docs/faq-*.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup
from django.contrib.sites.models import Site
from django.core.management.base import BaseCommand
from django.db import transaction

from apps.docs.models import DocPage
from apps.faq.models import FaqItem

SLUGS = {
    "1. Установка приложения": "faq-install",
    "2. Вход: ваша почта как транспорт": "faq-login",
    "3. Ключи и добавление собеседника": "faq-contacts",
    "4. Чаты: сообщения, файлы, группы": "faq-chats",
    "Каналы: вещание для подписчиков": "faq-channels",
    "Боты (экспериментально)": "faq-bots",
    "5. Звонки (бета)": "faq-calls",
    "Режимы доставки и уведомления": "faq-delivery",
    "Резервные копии и перенос на новое устройство": "faq-backup",
    "Голосования, пересылка, черновики, гео и папки": "faq-features",
    "Почему почта? Это же медленно": "faq-email-speed",
    "Что видит почтовый провайдер?": "faq-provider",
    "Сколько это стоит?": "faq-price",
    "А если почтовый провайдер заблокирует аккаунт?": "faq-provider-block",
    "Чем это отличается от PGP?": "faq-pgp",
}

SLUGS_EN = {
    "1. Install the app": "faq-install",
    "2. Sign in: your email is the transport": "faq-login",
    "3. Keys and adding a contact": "faq-contacts",
    "4. Chats: messages, files, groups": "faq-chats",
    "Channels: broadcast to your subscribers": "faq-channels",
    "Bots (experimental)": "faq-bots",
    "5. Calls (beta)": "faq-calls",
    "Delivery modes and notifications": "faq-delivery",
    "Backups and moving to a new device": "faq-backup",
    "Polls, forwarding, drafts, location and folders": "faq-features",
    "Email? Isn't that slow?": "faq-email-speed",
    "What does my mail provider see?": "faq-provider",
    "What does it cost?": "faq-price",
    "What if my mail provider blocks the account?": "faq-provider-block",
    "How is this different from PGP?": "faq-pgp",
}

ORDER = {
    "1. Установка приложения": 101,
    "2. Вход: ваша почта как транспорт": 102,
    "3. Ключи и добавление собеседника": 103,
    "4. Чаты: сообщения, файлы, группы": 104,
    "Каналы: вещание для подписчиков": 105,
    "Боты (экспериментально)": 106,
    "5. Звонки (бета)": 107,
    "Режимы доставки и уведомления": 108,
    "Резервные копии и перенос на новое устройство": 109,
    "Голосования, пересылка, черновики, гео и папки": 110,
    "Почему почта? Это же медленно": 111,
    "Что видит почтовый провайдер?": 112,
    "Сколько это стоит?": 113,
    "А если почтовый провайдер заблокирует аккаунт?": 114,
    "Чем это отличается от PGP?": 115,
}


class Command(BaseCommand):
    help = "Import the legacy landing FAQ as Vault documentation pages."

    def add_arguments(self, parser):
        parser.add_argument("--domain", default="vault-msg.ru")

    def handle(self, *args, **options):
        site = Site.objects.get(domain=options["domain"])
        slugs = SLUGS_EN if options["domain"].endswith(".tech") else SLUGS
        imported = 0
        with transaction.atomic():
            DocPage.objects.filter(site=site, product="vault", slug__startswith="faq-").delete()
            for item in FaqItem.objects.filter(site=site, product="vault").order_by("order", "id"):
                slug = slugs.get(item.question)
                if slug is None:
                    self.stderr.write(self.style.WARNING(f"No doc slug for FAQ: {item.question}"))
                    continue
                summary = BeautifulSoup(item.answer_html or "", "html.parser").get_text(" ", strip=True)
                DocPage.objects.create(
                    site=site,
                    product="vault",
                    slug=slug,
                    title=item.question,
                    summary=re.sub(r"\s+", " ", summary)[:300],
                    body_markdown="",
                    body_html=item.answer_html,
                    version="0.1.294",
                    order=ORDER.get(item.question, item.order + 101),
                    is_published=True,
                )
                imported += 1
        self.stdout.write(self.style.SUCCESS(f"Imported {imported} legacy Vault FAQ pages."))
