"""Pricing plans and their limits."""

from __future__ import annotations

from decimal import Decimal

from django.contrib.sites.models import Site
from django.db import models


class Plan(models.Model):
    class Period(models.TextChoices):
        MONTH = "month", "Месяц"
        YEAR = "year", "Год"
        ONCE = "once", "Разово"

    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="plans")
    product = models.CharField(max_length=40, default="vault")
    code = models.SlugField(max_length=60)
    name = models.CharField(max_length=120)
    price = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0"))
    currency = models.CharField(max_length=8, default="RUB")
    period = models.CharField(max_length=16, choices=Period.choices, default=Period.MONTH)
    limits = models.JSONField(default=dict, blank=True)
    features = models.JSONField(default=list, blank=True)
    cta_label = models.CharField(max_length=120, blank=True)
    cta_url = models.CharField(max_length=500, blank=True)
    order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["site_id", "order", "price"]
        constraints = [
            models.UniqueConstraint(fields=["site", "product", "code"], name="uniq_plan_site_code")
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.price} {self.currency}/{self.period})"
