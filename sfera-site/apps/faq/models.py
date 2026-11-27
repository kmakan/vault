"""FAQ items extracted from the landing page and editable in admin."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.db import models


class FaqItem(models.Model):
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="faq_items")
    product = models.CharField(max_length=40, default="vault")
    question = models.CharField(max_length=300)
    answer_html = models.TextField()
    order = models.PositiveIntegerField(default=0)
    is_published = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["site_id", "product", "order", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "product", "question"], name="uniq_faq_site_product_question"
            )
        ]

    def __str__(self) -> str:
        return self.question
