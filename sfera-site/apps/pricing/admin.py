from django.contrib import admin

from .models import Plan


@admin.register(Plan)
class PlanAdmin(admin.ModelAdmin):
    list_display = ("site", "product", "name", "price", "currency", "period", "order", "is_active")
    list_filter = ("site", "product", "period", "is_active")
    search_fields = ("code", "name")
    ordering = ("site", "order", "price")
