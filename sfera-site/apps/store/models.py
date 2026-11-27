"""App-store listing copy kept next to the site content."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.db import models


class StoreListing(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Черновик"
        READY = "ready", "Готово"
        PUBLISHED = "published", "Опубликовано"

    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="store_listings")
    product = models.CharField(max_length=40, default="vault")
    title = models.CharField(max_length=120)
    short_description = models.CharField(max_length=200)
    full_description = models.TextField(blank=True)
    keywords = models.CharField(max_length=500, blank=True)
    category = models.CharField(max_length=120, blank=True)
    age_rating = models.CharField(max_length=40, blank=True)
    screenshots = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.DRAFT)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["site_id", "product"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "product"], name="uniq_store_listing_site_product"
            )
        ]

    def __str__(self) -> str:
        return f"{self.product}: {self.title}"
