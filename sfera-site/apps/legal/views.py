from django.shortcuts import get_object_or_404
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import LegalDocument
from .serializers import LegalDocumentSerializer


class LegalDetailView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, kind: str):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        document = get_object_or_404(
            LegalDocument.objects.filter(site=site, kind=kind, is_published=True).order_by(
                "-effective_at", "-id"
            )
        )
        return Response(LegalDocumentSerializer(document).data)


class LegalListView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        documents = LegalDocument.objects.filter(site=site, is_published=True).order_by("kind", "-effective_at")
        return Response({"documents": LegalDocumentSerializer(documents, many=True).data})
