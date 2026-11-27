"""Read-only bridge to the Rust public-channel vitrine.

Signatures are verified by ``social-public``; Django only proxies and caches
its JSON. This app deliberately has no key material.
"""

from __future__ import annotations

from django.db import models


class PublicChannelSource(models.Model):
    name = models.CharField(max_length=80, default="default", unique=True)
    base_url = models.URLField(max_length=500, help_text="Например http://127.0.0.1:8095")
    timeout_seconds = models.PositiveSmallIntegerField(default=5)
    is_enabled = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.name}: {self.base_url} ({'on' if self.is_enabled else 'off'})"
