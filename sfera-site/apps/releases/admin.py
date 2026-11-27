from django.contrib import admin

from .models import Release


@admin.register(Release)
class ReleaseAdmin(admin.ModelAdmin):
    list_display = ("site", "product", "platform", "version", "channel", "is_latest", "published_at")
    list_filter = ("site", "product", "platform", "channel", "is_latest", "is_active")
    search_fields = ("version", "url", "sha256")
    ordering = ("site", "order", "platform", "-published_at")
