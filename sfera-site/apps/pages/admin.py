from django.contrib import admin

from .models import Page, PageBlock


class PageBlockInline(admin.TabularInline):
    model = PageBlock
    extra = 0
    fields = ("key", "kind", "title", "order", "is_published")
    ordering = ("order",)


@admin.register(Page)
class PageAdmin(admin.ModelAdmin):
    list_display = ("site", "slug", "title", "is_published", "updated_at")
    list_filter = ("site", "is_published")
    search_fields = ("slug", "title", "body_html")
    inlines = [PageBlockInline]


@admin.register(PageBlock)
class PageBlockAdmin(admin.ModelAdmin):
    list_display = ("page", "key", "kind", "title", "order", "is_published")
    list_filter = ("kind", "is_published", "page__site")
    search_fields = ("key", "title", "body_html")
