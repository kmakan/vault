"""Download releases and platform cards."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.db import models


class Release(models.Model):
    class Platform(models.TextChoices):
        ANDROID = "android", "Android"
        LINUX = "linux", "Linux"
        MACOS = "macos", "macOS"
        WINDOWS = "windows", "Windows"

    class Channel(models.TextChoices):
        APK = "apk", "APK"
        AAB = "aab", "AAB"
        DESKTOP = "desktop", "Desktop"
        DIRECT = "direct", "Direct"
        GITHUB = "github", "GitHub"

    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="releases")
    product = models.CharField(max_length=40, default="vault")
    platform = models.CharField(max_length=20, choices=Platform.choices)
    channel = models.CharField(max_length=20, choices=Channel.choices, default=Channel.DIRECT)
    version = models.CharField(max_length=40)
    url = models.URLField(max_length=1000)
    sha256 = models.CharField(max_length=64, blank=True)
    size = models.PositiveBigIntegerField(null=True, blank=True)
    requirements = models.CharField(max_length=200, blank=True)
    cta_label = models.CharField(max_length=120, blank=True)
    secondary_url = models.URLField(max_length=1000, blank=True)
    secondary_label = models.CharField(max_length=120, blank=True)
    notes_html = models.TextField(blank=True)
    published_at = models.DateTimeField(null=True, blank=True)
    is_latest = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["site_id", "order", "platform", "-published_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "product", "platform", "channel", "version"],
                name="uniq_release_site_product_platform_version",
            )
        ]

    def __str__(self) -> str:
        return f"{self.product} {self.version} ({self.platform})"
