"""Editable pages and their narrative blocks."""

from __future__ import annotations

from django.contrib.sites.models import Site
from django.db import models


class Page(models.Model):
    """A top-level public page (landing, pricing, pay, ...).

    ``body_html`` is the compatibility body for pages that are not yet split
    into structured blocks. It is trusted admin content, never user input.
    """

    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="pages")
    slug = models.SlugField(max_length=120)
    title = models.CharField(max_length=200)
    subtitle = models.TextField(blank=True)
    seo_title = models.CharField(max_length=200, blank=True)
    seo_description = models.TextField(blank=True)
    canonical_path = models.CharField(max_length=500, blank=True)
    og_image_path = models.CharField(max_length=500, blank=True)
    body_html = models.TextField(blank=True)
    is_published = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["site_id", "slug"]
        constraints = [
            models.UniqueConstraint(fields=["site", "slug"], name="uniq_page_site_slug")
        ]

    def __str__(self) -> str:
        return f"{self.site.domain}/{self.slug}"


class PageBlock(models.Model):
    """A section of a page, kept in source order.

    ``kind`` is a presentation hint (hero, features, guide, ...). Data needed
    by a feature app (FAQ, releases, plans) lives in that app, not here.
    """

    page = models.ForeignKey(Page, on_delete=models.CASCADE, related_name="blocks")
    key = models.SlugField(max_length=80)
    kind = models.CharField(max_length=40, default="section")
    title = models.CharField(max_length=200, blank=True)
    subtitle = models.TextField(blank=True)
    body_html = models.TextField(blank=True)
    data = models.JSONField(default=dict, blank=True)
    order = models.PositiveIntegerField(default=0)
    is_published = models.BooleanField(default=True)

    class Meta:
        ordering = ["page_id", "order", "id"]
        constraints = [
            models.UniqueConstraint(fields=["page", "key"], name="uniq_page_block_key")
        ]

    def __str__(self) -> str:
        return f"{self.page.slug}#{self.key}"
