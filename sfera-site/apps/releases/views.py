from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Release
from .serializers import ReleaseSerializer


def _queryset(request):
    site = getattr(request, "site", None)
    if site is None:
        return None
    qs = Release.objects.filter(site=site, is_active=True)
    product = request.query_params.get("product")
    if product:
        qs = qs.filter(product=product)
    platform = request.query_params.get("platform")
    if platform:
        qs = qs.filter(platform=platform)
    return qs


class ReleaseListView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        qs = _queryset(request)
        if qs is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        return Response({"releases": ReleaseSerializer(qs, many=True).data})


class LatestReleaseView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        qs = _queryset(request)
        if qs is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        latest = qs.filter(is_latest=True).order_by("order", "platform").first()
        if latest is None:
            return Response({"error": {"code": "not_found", "message": "No release"}}, status=404)
        return Response(ReleaseSerializer(latest).data)
