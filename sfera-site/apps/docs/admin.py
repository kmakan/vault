from django.contrib import admin

from .models import DocPage


@admin.register(DocPage)
class DocPageAdmin(admin.ModelAdmin):
    list_display = ("site", "product", "slug", "title", "version", "order", "is_published", "updated_at")
    list_filter = ("site", "product", "is_published", "version")
    search_fields = ("slug", "title", "body_markdown", "body_html")
    ordering = ("site", "order", "slug")
    readonly_fields = ("updated_at", "created_at")
