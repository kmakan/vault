from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import StoreListing
from .serializers import StoreListingSerializer


class StoreListingView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        qs = StoreListing.objects.filter(site=site, status=StoreListing.Status.PUBLISHED)
        product = request.query_params.get("product")
        if product:
            qs = qs.filter(product=product)
        return Response({"listings": StoreListingSerializer(qs, many=True).data})
