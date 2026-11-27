from django.shortcuts import get_object_or_404
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Page
from .serializers import PageSerializer, PageSummarySerializer


class PageListView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        pages = Page.objects.filter(site=site, is_published=True)
        return Response({"pages": PageSummarySerializer(pages, many=True).data})


class PageDetailView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, slug: str):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        page = get_object_or_404(
            Page.objects.prefetch_related("blocks"),
            site=site,
            slug=slug,
            is_published=True,
        )
        return Response(PageSerializer(page).data)
