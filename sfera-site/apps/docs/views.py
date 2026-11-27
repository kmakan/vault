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
        qs = DocPage.objects.filter(site=site, slug=slug, is_published=True)
        product = request.query_params.get("product")
        if product:
            qs = qs.filter(product=product)
        elif qs.count() > 1:
            return Response(
                {"error": {"code": "product_required", "message": "Pass ?product=vault|sfera"}},
                status=400,
            )
        page = get_object_or_404(qs)
        return Response(DocPageSerializer(page).data)
