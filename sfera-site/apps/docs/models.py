"""Documentation tree for the public sites."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.db import models


class DocPage(models.Model):
    """One documentation page, with an explicit parent for the tree."""

    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="doc_pages")
    product = models.CharField(max_length=40, default="vault")
    parent = models.ForeignKey(
        "self", on_delete=models.CASCADE, null=True, blank=True, related_name="children"
    )
    slug = models.SlugField(max_length=160)
    title = models.CharField(max_length=200)
    summary = models.TextField(blank=True)
    body_markdown = models.TextField(blank=True)
    body_html = models.TextField(blank=True)
    version = models.CharField(max_length=40, blank=True)
    order = models.PositiveIntegerField(default=0)
    is_published = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["site_id", "order", "slug"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "product", "slug"], name="uniq_doc_site_product_slug"
            )
        ]

    def __str__(self) -> str:
        return f"{self.site.domain}/docs/{self.slug}"

    def path(self) -> str:
        return f"/docs/{self.slug}"
