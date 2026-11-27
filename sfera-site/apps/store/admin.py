from django.contrib import admin

from .models import StoreListing


@admin.register(StoreListing)
class StoreListingAdmin(admin.ModelAdmin):
    list_display = ("site", "product", "title", "status", "updated_at")
    list_filter = ("site", "product", "status")
    search_fields = ("title", "short_description", "full_description")
