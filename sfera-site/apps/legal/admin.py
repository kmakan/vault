from django.contrib import admin

from .models import LegalDocument


@admin.register(LegalDocument)
class LegalDocumentAdmin(admin.ModelAdmin):
    list_display = ("site", "kind", "version", "effective_at", "is_published", "updated_at")
    list_filter = ("site", "kind", "is_published")
    search_fields = ("title", "body_html", "version")
    ordering = ("site", "kind", "-effective_at")
