from django.shortcuts import get_object_or_404
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import DocPage
from .serializers import DocPageSerializer, DocTreeSerializer


class DocTreeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        roots = DocPage.objects.filter(site=site, parent__isnull=True, is_published=True).prefetch_related("children")
        product = request.query_params.get("product")
        if product:
            roots = roots.filter(product=product)
        return Response({"tree": DocTreeSerializer(roots, many=True).data})


class DocDetailView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, slug: str):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        page = get_object_or_404(DocPage, site=site, slug=slug, is_published=True)
        return Response(DocPageSerializer(page).data)
