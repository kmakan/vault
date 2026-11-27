from django.contrib import admin

from .models import FaqItem


@admin.register(FaqItem)
class FaqItemAdmin(admin.ModelAdmin):
    list_display = ("site", "product", "question", "order", "is_published", "updated_at")
    list_filter = ("site", "product", "is_published")
    search_fields = ("question", "answer_html")
    ordering = ("site", "product", "order")
