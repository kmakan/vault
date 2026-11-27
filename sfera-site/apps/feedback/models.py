"""Feedback submissions from the public site."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.db import models


class Feedback(models.Model):
    class Status(models.TextChoices):
        NEW = "new", "Новое"
        READ = "read", "Прочитано"
        CLOSED = "closed", "Закрыто"
        SPAM = "spam", "Спам"

    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="feedback")
    product = models.CharField(max_length=40, default="vault")
    name = models.CharField(max_length=120, blank=True)
    email = models.EmailField(blank=True)
    message = models.TextField()
    page_url = models.URLField(max_length=1000, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.NEW)
    ip_hash = models.CharField(max_length=64, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["site", "status", "-created_at"])]

    def __str__(self) -> str:
        return f"{self.email or self.name or 'anonymous'} @ {self.created_at:%Y-%m-%d %H:%M}"
