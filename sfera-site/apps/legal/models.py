"""Versioned legal documents."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.db import models


class LegalDocument(models.Model):
    class Kind(models.TextChoices):
        PRIVACY = "privacy", "Политика конфиденциальности"
        TERMS = "terms", "Условия использования"
        OFFER = "offer", "Публичная оферта"
        PERSONAL_DATA = "pd", "Обработка персональных данных"
        REQUISITES = "requisites", "Реквизиты"

    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="legal_documents")
    kind = models.CharField(max_length=20, choices=Kind.choices)
    version = models.CharField(max_length=20)
    effective_at = models.DateField()
    title = models.CharField(max_length=200)
    body_html = models.TextField()
    is_published = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["site_id", "kind", "-effective_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "kind", "version"], name="uniq_legal_site_kind_version"
            )
        ]

    def __str__(self) -> str:
        return f"{self.get_kind_display()} v{self.version} ({self.site.domain})"
