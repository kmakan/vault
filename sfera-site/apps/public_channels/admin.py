from django.contrib import admin

from .models import PublicChannelSource


@admin.register(PublicChannelSource)
class PublicChannelSourceAdmin(admin.ModelAdmin):
    list_display = ("name", "base_url", "is_enabled", "timeout_seconds", "updated_at")
    list_filter = ("is_enabled",)
