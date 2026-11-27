from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Plan
from .serializers import PlanSerializer


class PlanListView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        site = getattr(request, "site", None)
        if site is None:
            return Response({"error": {"code": "site_not_found", "message": "Host is not configured"}}, status=404)
        qs = Plan.objects.filter(site=site, is_active=True)
        product = request.query_params.get("product")
        if product:
            qs = qs.filter(product=product)
        return Response({"plans": PlanSerializer(qs, many=True).data})
