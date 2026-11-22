import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useQuery } from "@tanstack/react-query";
import { Minus, TrendingDown, TrendingUp, X } from "lucide-react";
import { SalesForecastResponse } from "@shared/api";
import { useAuth } from "@/hooks/useAuth";
import { SalesForecastChart } from "./SalesForecastChart";
import { SalesForecastProducts } from "./SalesForecastProducts";

const fetchSalesForecast = async (token: string): Promise<SalesForecastResponse> => {
  const response = await fetch("/api/sales/forecast", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error("Failed to load forecast");
  }
  return response.json();
};

const formatPeso = (value: number) =>
  `₱${value.toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;

const TREND_STYLES = {
  up: { icon: TrendingUp, className: "text-success", label: "Upward" },
  down: { icon: TrendingDown, className: "text-destructive", label: "Downward" },
  flat: { icon: Minus, className: "text-muted-foreground", label: "Flat" },
} as const;

function ForecastSummary({ data }: { data: SalesForecastResponse }) {
  const trend = TREND_STYLES[data.trend];
  const TrendIcon = trend.icon;

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="rounded-md border p-3">
        <p className="text-xs text-muted-foreground">Projected next 7 days</p>
        <p className="text-lg font-semibold">{formatPeso(data.projected_7_day_total)}</p>
      </div>
      <div className="rounded-md border p-3">
        <p className="text-xs text-muted-foreground">Weekly trend</p>
        <p className={`flex items-center gap-1 text-lg font-semibold ${trend.className}`}>
          <TrendIcon className="h-4 w-4" />
          {trend.label} {data.trend_percent > 0 ? "+" : ""}
          {data.trend_percent}%
        </p>
      </div>
    </div>
  );
}

function ForecastBody({ isLoading, isError, data }: {
  isLoading: boolean;
  isError: boolean;
  data: SalesForecastResponse | undefined;
}) {
  if (isLoading) {
    return <LoadingSpinner className="py-10" />;
  }
  if (isError || !data) {
    return <p className="py-10 text-center text-sm text-destructive">Could not load the forecast.</p>;
  }
  if (!data.has_enough_data) {
    return (
      <div className="space-y-4">
        <p className="py-6 text-center text-sm text-muted-foreground">{data.note}</p>
        <SalesForecastProducts insights={data.product_insights} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <SalesForecastChart data={data} />
      <ForecastSummary data={data} />
      <p className="text-xs text-muted-foreground">{data.note}</p>
      {data.ai_summary && (
        <div className="rounded-md border bg-muted p-3">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">AI summary</p>
          <p className="text-sm">{data.ai_summary}</p>
        </div>
      )}
      <SalesForecastProducts insights={data.product_insights} />
    </div>
  );
}

export function SalesForecastWidget() {
  const token = useAuth((state) => state.token);
  const role = useAuth((state) => state.user?.role);
  const [isOpen, setIsOpen] = useState(false);
  const [hasPopup, setHasPopup] = useState(false);

  useEffect(() => {
    const updatePopupVisibility = () => {
      const popupIsOpen = Boolean(document.querySelector(
        '[data-popup-open="true"], [role="dialog"][aria-modal="true"], [role="alertdialog"], [class~="fixed"][class~="inset-0"]'
      ));
      setHasPopup(popupIsOpen);
    };

    updatePopupVisibility();
    const observer = new MutationObserver(updatePopupVisibility);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "data-popup-open", "role", "aria-modal"],
    });
    return () => observer.disconnect();
  }, []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sales-forecast", token],
    queryFn: () => fetchSalesForecast(token as string),
    enabled: Boolean(token) && isOpen,
    staleTime: 5 * 60 * 1000,
  });

  if (!token || role !== "admin" || hasPopup) return null;

  if (!isOpen) {
    return (
      <div className="fixed bottom-24 right-4 z-50 md:bottom-6 md:right-6">
        <Button
          type="button"
          onClick={() => setIsOpen(true)}
          variant="default"
          aria-label="Open sales forecast"
          className="shadow-lg"
        >
          <TrendingUp className="h-4 w-4" />
          <span>Sales Forecast</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-24 right-4 z-50 max-h-[min(75vh,640px)] w-[min(440px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-xl animate-fade-in-up md:bottom-6 md:right-6">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Sales Forecast</h2>
          <p className="text-xs text-muted-foreground">Estimate based on recent invoices</p>
        </div>
        <Button
          type="button"
          onClick={() => setIsOpen(false)}
          aria-label="Close sales forecast" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ForecastBody isLoading={isLoading} isError={isError} data={data} />
    </div>
  );
}
