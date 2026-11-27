from django.contrib import admin

from .models import Feedback


@admin.register(Feedback)
class FeedbackAdmin(admin.ModelAdmin):
    list_display = ("created_at", "site", "product", "name", "email", "status")
    list_filter = ("site", "product", "status", "created_at")
    search_fields = ("name", "email", "message")
    readonly_fields = ("ip_hash", "user_agent", "created_at")
    ordering = ("-created_at",)
