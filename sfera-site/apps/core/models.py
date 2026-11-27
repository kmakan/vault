"""Core site features: site profile, navigation, redirects, health."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.db import models


class Locale(models.TextChoices):
    RU = "ru", "Русский"
    EN = "en", "English"
    ZH = "zh", "中文"


class SiteProfile(models.Model):
    """Editorial and branding profile for one public host."""

    site = models.OneToOneField(Site, on_delete=models.CASCADE, related_name="profile")
    locale = models.CharField(max_length=8, choices=Locale.choices, default=Locale.RU)
    brand_name = models.CharField(max_length=80, default="Vault")
    tagline = models.CharField(max_length=200, blank=True)
    contact_email = models.EmailField(blank=True)
    default_seo_title = models.CharField(max_length=200, blank=True)
    default_seo_description = models.TextField(blank=True)
    og_image_path = models.CharField(max_length=500, blank=True)
    theme_color = models.CharField(max_length=32, default="#f59e0b")
    is_active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["site__domain"]

    def __str__(self) -> str:
        return f"{self.site.domain} ({self.locale})"


class NavigationItem(models.Model):
    class Location(models.TextChoices):
        HEADER = "header", "Header"
        FOOTER = "footer", "Footer"
        LEGAL = "legal", "Legal"

    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="navigation_items")
    location = models.CharField(max_length=16, choices=Location.choices, default=Location.HEADER)
    label = models.CharField(max_length=120)
    url = models.CharField(max_length=500)
    order = models.PositiveIntegerField(default=0)
    is_external = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["location", "order", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "location", "label", "url"],
                name="uniq_navigation_item",
            )
        ]

    def __str__(self) -> str:
        return f"{self.location}: {self.label}"


class Redirect(models.Model):
    """Data-driven 301/302 rules for legacy .html URLs."""

    site = models.ForeignKey(
        Site, on_delete=models.CASCADE, related_name="redirects", null=True, blank=True
    )
    old_path = models.CharField(max_length=500)
    new_path = models.CharField(max_length=500)
    status_code = models.PositiveSmallIntegerField(default=301)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["old_path"]
        constraints = [
            models.UniqueConstraint(fields=["site", "old_path"], name="uniq_redirect_site_old_path")
        ]

    def __str__(self) -> str:
        return f"{self.old_path} -> {self.new_path}"
