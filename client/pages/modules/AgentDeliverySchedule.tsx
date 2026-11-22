import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PageDialog } from "@/components/shared/PageDialog";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { AgentStopRow } from "@/components/AgentStopRow";
import {
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Clock3,
  History,
  Search,
  Truck as TruckIcon,
  UserRound,
} from "lucide-react";
import type {
  AgentScheduleDelivery,
  MyCashPayment,
  AgentScheduleResponse,
  AgentScheduleStop,
} from "@shared/api";
import { useAuth } from "../../hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { optimizeRouteOrder } from "@/lib/routeOrder";
import { localScheduleDate, statusClasses } from "@/lib/agentSchedule";
import { DeliveryRouteMap, type MapFocus } from "@/components/DeliveryRouteMap";
import { AgentStopDetailDialog } from "@/components/AgentStopDetailDialog";
import { DeliveryPaymentPrompt } from "@/components/shared/DeliveryPaymentPrompt";
import { formatPeso } from "@/lib/format";

function formatScheduleDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

function formatScheduleTime(value?: string | null) {
  if (!value) return "Time not set";
  const [hours, minutes] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2000, 0, 1, hours, minutes));
}

function filterRuns(
  deliveries: AgentScheduleDelivery[],
  dateFilter: string,
  fromTime: string,
  search: string,
) {
  const query = search.trim().toLowerCase();
  return deliveries.flatMap((delivery) => {
    const date =
      delivery.scheduled_date ??
      localScheduleDate(new Date(delivery.created_at));
    if (dateFilter && date !== dateFilter) return [];
    if (
      fromTime &&
      (!delivery.scheduled_time || delivery.scheduled_time < fromTime)
    )
      return [];

    const runDetails = [
      date,
      formatScheduleDate(date),
      delivery.scheduled_time,
      formatScheduleTime(delivery.scheduled_time),
      delivery.truck?.license_plate,
      delivery.truck?.district,
      delivery.agent?.full_name,
      delivery.driver?.full_name,
      delivery.status,
    ]
      .join(" ")
      .toLowerCase();
    if (!query || runDetails.includes(query)) return [delivery];

    const matchingStops = (delivery.delivery_items ?? []).filter((stop) =>
      [
        stop.destination_customer?.store_name,
        stop.invoice?.receipt_number,
        stop.invoice_id,
        stop.status,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
    return matchingStops.length
      ? [{ ...delivery, delivery_items: matchingStops }]
      : [];
  });
}

function orderRunStops(stops: AgentScheduleStop[]) {
  const points = stops.map((stop) => ({
    id: stop.id,
    latitude: stop.destination_customer?.latitude,
    longitude: stop.destination_customer?.longitude,
    stop,
  }));
  const completed = points.filter((point) => point.stop.status === "completed");
  const pending = points.filter((point) => point.stop.status !== "completed");
  return [...completed, ...optimizeRouteOrder(pending)].map(
    (point) => point.stop,
  );
}

export function AgentDeliverySchedule() {
  const { token } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [deliveries, setDeliveries] = useState<AgentScheduleDelivery[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<"today" | "history">("today");
  const [search, setSearch] = useState("");
  const [scheduleDate, setScheduleDate] = useState(() =>
    localScheduleDate(new Date()),
  );
  const [scheduleTime, setScheduleTime] = useState("");
  const [historyDate, setHistoryDate] = useState("");
  const [historyTime, setHistoryTime] = useState("");
  const [paymentStop, setPaymentStop] = useState<{
    delivery: AgentScheduleDelivery;
    stop: AgentScheduleStop;
    mode: "confirm" | "payment";
  } | null>(null);
  const [confirmingStopId, setConfirmingStopId] = useState<string | null>(null);
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  const [detailTarget, setDetailTarget] = useState<{
    delivery: AgentScheduleDelivery;
    stop: AgentScheduleStop;
  } | null>(null);
  const [showUnconfirmed, setShowUnconfirmed] = useState(false);
  const [myCashPayments, setMyCashPayments] = useState<MyCashPayment[]>([]);
  const [showPartiallyUnpaid, setShowPartiallyUnpaid] = useState(false);

  const fetchSchedule = async () => {
    if (!token) return;
    setError("");

    try {
      const response = await fetch("/api/agent-schedule", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok)
        throw new Error("Could not load your delivery schedule.");

      const schedule = (await response.json()) as AgentScheduleResponse;
      setDeliveries(schedule.deliveries);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Could not load your delivery schedule.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchSchedule();
  }, [token]);
  useAutoRefresh(fetchSchedule, { enabled: Boolean(token) });

  // Pallet Tracking sends us here after the last pallet ships; open the payment prompt for that order's stop.
  const confirmOrderId = (
    location.state as { confirmPaymentOrderId?: string } | null
  )?.confirmPaymentOrderId;
  useEffect(() => {
    if (!confirmOrderId || isLoading) return;
    for (const delivery of deliveries) {
      const stop = (delivery.delivery_items ?? []).find(
        (item) =>
          item.invoice?.booking_id === confirmOrderId &&
          item.status !== "completed",
      );
      if (!stop) continue;
      if (
        stop.pallets.length > 0 &&
        stop.pallets.every((pallet) => pallet.status === "shipped")
      ) {
        setPaymentStop({ delivery, stop, mode: "confirm" });
      }
      break;
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [confirmOrderId, isLoading, deliveries]);

  const today = localScheduleDate(new Date());
  const currentDeliveries = deliveries.filter(
    (delivery) => delivery.status !== "completed",
  );
  const todayDeliveries = currentDeliveries.filter(
    (delivery) =>
      (delivery.scheduled_date ??
        localScheduleDate(new Date(delivery.created_at))) === today,
  );
  const historyDeliveries = deliveries.filter(
    (delivery) => delivery.status === "completed",
  );
  const filteredTodayDeliveries = useMemo(
    () => filterRuns(currentDeliveries, scheduleDate, scheduleTime, search),
    [deliveries, scheduleDate, scheduleTime, search],
  );
  const filteredHistoryDeliveries = useMemo(
    () => filterRuns(historyDeliveries, historyDate, historyTime, search),
    [deliveries, historyDate, historyTime, search],
  );
  const visibleDeliveries =
    view === "today" ? filteredTodayDeliveries : filteredHistoryDeliveries;
  const scheduledDays = useMemo(() => {
    const groups = new Map<string, AgentScheduleDelivery[]>();
    for (const delivery of visibleDeliveries) {
      const date =
        delivery.scheduled_date ??
        localScheduleDate(new Date(delivery.created_at));
      groups.set(date, [...(groups.get(date) ?? []), delivery]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) =>
        view === "today" ? a.localeCompare(b) : b.localeCompare(a),
      )
      .map(
        ([date, runs]) =>
          [
            date,
            [...runs].sort((a, b) =>
              (a.scheduled_time ?? "99:99").localeCompare(
                b.scheduled_time ?? "99:99",
              ),
            ),
          ] as const,
      );
  }, [view, visibleDeliveries]);

  useEffect(() => {
    if (!token) return;
    fetch("/api/cash-remittances/mine", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => (response.ok ? response.json() : []))
      .then((payments: MyCashPayment[]) => setMyCashPayments(payments))
      .catch(() => setMyCashPayments([]));
  }, [token, showUnconfirmed]);

  const unconfirmedTotal = myCashPayments.reduce(
    (total, payment) => total + Number(payment.amount),
    0,
  );

  const partiallyUnpaidStops = deliveries.flatMap((delivery) =>
    (delivery.delivery_items ?? [])
      .filter(
        (stop) =>
          stop.status === "completed" &&
          !stop.is_paid &&
          (stop.outstanding_amount ?? 0) > 0,
      )
      .map((stop) => ({ delivery, stop })),
  );
  const partiallyUnpaidTotal = partiallyUnpaidStops.reduce(
    (total, { stop }) => total + (stop.outstanding_amount ?? 0),
    0,
  );

  const confirmDelivery = async (
    isPaid: boolean,
    paymentAmount?: number,
    paymentMethod?: string,
    paymentReference?: string,
    paymentId?: string,
    notes?: string,
  ) => {
    if (!token || !paymentStop) return;
    const { delivery, stop, mode } = paymentStop;
    setConfirmingStopId(stop.id);
    try {
      const response = await fetch(
        `/api/deliveries/${delivery.id}/items/${stop.id}/${mode === "payment" ? "payment" : "confirm"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(
            mode === "payment"
              ? {
                  payment_amount: paymentAmount,
                  payment_method: paymentMethod,
                  payment_reference: paymentReference,
                  payment_id: paymentId,
                  notes,
                }
              : {
                  is_paid: isPaid,
                  payment_amount: paymentAmount,
                  payment_method: paymentMethod,
                  payment_reference: paymentReference,
                  payment_id: paymentId,
                  notes,
                },
          ),
        },
      );
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Could not confirm delivery.");
      }
      setPaymentStop(null);
      await fetchSchedule();
    } catch (confirmError) {
      setError(
        confirmError instanceof Error
          ? confirmError.message
          : "Could not confirm delivery.",
      );
    } finally {
      setConfirmingStopId(null);
    }
  };

  if (isLoading) return <LoadingSpinner />;

  const showStopOnMap = (deliveryId: string, stopId: string) => {
    setMapFocus({ stopId, requestedAt: Date.now() });
    document
      .getElementById(`run-map-${deliveryId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (detailTarget) {
    const { delivery, stop } = detailTarget;
    const hasMapLocation =
      stop.destination_customer?.latitude != null &&
      stop.destination_customer?.longitude != null;
    return (
      <AgentStopDetailDialog
        stop={stop}
        onBack={() => setDetailTarget(null)}
        onShowOnMap={
          view === "today" && hasMapLocation
            ? () => {
                setDetailTarget(null);
                window.setTimeout(() => showStopOnMap(delivery.id, stop.id), 0);
              }
            : undefined
        }
      />
    );
  }

  return (
    <>
      <div className="flex-1 flex flex-col gap-5 p-4 pb-24 md:p-6 md:pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="page-title">My Delivery Schedule</h1>
            <p className="page-subtitle">
              Your assigned delivery runs, destinations, and stop details
            </p>
          </div>
        </div>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <button
            type="button"
            aria-expanded={showUnconfirmed}
            onClick={() => setShowUnconfirmed((shown) => !shown)}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="text-sm font-bold text-foreground">
              Unconfirmed payments
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {formatPeso(unconfirmedTotal)}
              </span>
              · {myCashPayments.length}{" "}
              {myCashPayments.length === 1 ? "payment" : "payments"}
              {showUnconfirmed ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </span>
          </button>
          {showUnconfirmed &&
            (myCashPayments.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No cash waiting to be handed over.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {myCashPayments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {payment.customer_name ?? "Customer"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Order {payment.order_number} · {payment.business_date}
                      </p>
                    </div>
                    <span className="text-sm font-semibold text-foreground">
                      {formatPeso(Number(payment.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            ))}
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <button
            type="button"
            aria-expanded={showPartiallyUnpaid}
            onClick={() => setShowPartiallyUnpaid((shown) => !shown)}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="text-sm font-bold text-foreground">
              Partially unpaid
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {formatPeso(partiallyUnpaidTotal)}
              </span>
              · {partiallyUnpaidStops.length} stops
              {showPartiallyUnpaid ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </span>
          </button>
          {showPartiallyUnpaid &&
            (partiallyUnpaidStops.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No partially unpaid deliveries.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {partiallyUnpaidStops.map(({ delivery, stop }) => (
                  <li
                    key={stop.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {stop.destination_customer?.store_name ?? "Customer"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Order {stop.invoice?.booking_id?.slice(0, 8).toUpperCase() ?? "—"}
                        {stop.invoice?.receipt_number
                          ? ` · Invoice ${stop.invoice.receipt_number}`
                          : ""}
                        {" · "}
                        {formatPeso(stop.outstanding_amount ?? 0)} remaining
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="success"
                      className="min-h-10"
                      disabled={confirmingStopId === stop.id}
                      onClick={() =>
                        setPaymentStop({ delivery, stop, mode: "payment" })
                      }
                    >
                      Record payment
                    </Button>
                  </li>
                ))}
              </ul>
            ))}
        </section>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            aria-pressed={view === "today"}
            onClick={() => setView("today")}
            className={`rounded-xl border p-3 text-left transition ${view === "today" ? "border-accent-2 bg-accent-2/5 shadow-sm" : "border-border bg-card hover:border-accent-2/50"}`}
          >
            <span className="flex items-center gap-2 text-sm font-bold text-foreground">
              <CalendarDays size={17} /> Today
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {todayDeliveries.length} scheduled runs
            </span>
          </button>
          <button
            type="button"
            aria-pressed={view === "history"}
            onClick={() => setView("history")}
            className={`rounded-xl border p-3 text-left transition ${view === "history" ? "border-accent-2 bg-accent-2/5 shadow-sm" : "border-border bg-card hover:border-accent-2/50"}`}
          >
            <span className="flex items-center gap-2 text-sm font-bold text-foreground">
              <History size={17} /> History
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {historyDeliveries.length} completed runs
            </span>
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red/30 bg-red/10 px-4 py-3 text-sm text-red"
          >
            {error}
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold text-muted-foreground">
            <Search size={15} /> Search and filter{" "}
            {view === "today" ? "schedule" : "history"}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(150px,auto)_minmax(130px,auto)]">
            <label className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-muted-foreground focus-within:border-accent-2">
              <Search size={16} aria-hidden="true" />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Truck, agent, store, or invoice"
                aria-label={`Search delivery ${view}`}
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/80 dark:placeholder:text-foreground/70"
              />
            </label>
            <label className="flex flex-col justify-center rounded-lg border border-border px-3 py-1 text-2xs font-semibold text-muted-foreground focus-within:border-accent-2">
              {view === "today" ? "Schedule date" : "History date"}
              <Input
                type="date"
                value={view === "today" ? scheduleDate : historyDate}
                onChange={(event) =>
                  view === "today"
                    ? setScheduleDate(event.target.value || today)
                    : setHistoryDate(event.target.value)
                }
                aria-label={
                  view === "today"
                    ? "Filter schedule by date"
                    : "Filter history by scheduled date"
                }
                className="w-full bg-transparent text-sm font-normal text-foreground outline-none"
              />
            </label>
            <label className="flex flex-col justify-center rounded-lg border border-border px-3 py-1 text-2xs font-semibold text-muted-foreground focus-within:border-accent-2">
              <span className="flex items-center gap-1">
                <Clock3 size={12} /> From time
              </span>
              <Input
                type="time"
                value={view === "today" ? scheduleTime : historyTime}
                onChange={(event) =>
                  view === "today"
                    ? setScheduleTime(event.target.value)
                    : setHistoryTime(event.target.value)
                }
                aria-label={`Filter delivery ${view} from time`}
                className="w-full bg-transparent text-sm font-normal text-foreground outline-none"
              />
            </label>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {view === "history" && !historyDate
                ? "History date is optional; time filters show runs scheduled at or after that time."
                : "Time filters show runs scheduled at or after the selected time."}{" "}
              Runs without a saved time will not match a time filter.
            </span>
            <Button
              type="button"
              onClick={() => {
                setSearch("");
                if (view === "today") {
                  setScheduleDate(today);
                  setScheduleTime("");
                } else {
                  setHistoryDate("");
                  setHistoryTime("");
                }
              }}
              variant="link"
              className="h-auto p-0 shrink-0"
            >
              Clear filters
            </Button>
          </div>
        </div>

        {visibleDeliveries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
            <CalendarDays
              size={32}
              className="mx-auto mb-3 text-muted-foreground opacity-50"
            />
            <h2 className="font-semibold text-foreground">
              {view === "today"
                ? "No matching runs"
                : historyDeliveries.length
                  ? "No matching history"
                  : "No delivery history yet"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {view === "today"
                ? "Adjust the date, time, or search to find scheduled runs."
                : historyDeliveries.length
                  ? "Adjust the date, time, or search to find completed runs."
                  : "Completed delivery runs will be saved here."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {scheduledDays.map(([date, dayDeliveries]) => (
              <section key={date} className="space-y-3">
                <div className="flex items-center gap-2 text-foreground">
                  <CalendarDays size={18} />
                  <h2 className="font-rajdhani text-xl font-bold">
                    {formatScheduleDate(date)}
                  </h2>
                </div>
                {dayDeliveries.map((delivery) => {
                  const stops = orderRunStops(delivery.delivery_items ?? []);
                  return (
                    <article
                      key={delivery.id}
                      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted px-4 py-3">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                          <span className="inline-flex items-center gap-2 font-semibold text-foreground">
                            <TruckIcon size={17} />
                            {delivery.truck?.license_plate ??
                              "Truck not assigned"}
                          </span>
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Clock3 size={14} />{" "}
                            {formatScheduleTime(delivery.scheduled_time)}
                          </span>
                          {delivery.truck?.district && (
                            <span className="text-muted-foreground">
                              {delivery.truck.district}
                            </span>
                          )}
                          {delivery.agent && (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              <UserRound size={14} /> Agent:{" "}
                              {delivery.agent.full_name || "Assigned"}
                            </span>
                          )}
                          {delivery.driver && (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              <UserRound size={14} /> Driver:{" "}
                              {delivery.driver.full_name || "Assigned"}
                            </span>
                          )}
                        </div>
                        <span
                          className={`rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${statusClasses(delivery.status)}`}
                        >
                          {delivery.status.replace("_", " ")}
                        </span>
                      </div>

                      {view === "today" && (
                        <DeliveryRouteMap
                          key={delivery.id}
                          deliveryId={delivery.id}
                          stops={stops}
                          focus={mapFocus}
                        />
                      )}

                      <ol className="divide-y divide-border">
                        {stops.map((stop, index) => (
                          <AgentStopRow
                            key={stop.id}
                            index={index}
                            stop={stop}
                            isConfirming={confirmingStopId === stop.id}
                            onOpenDetails={() =>
                              setDetailTarget({ delivery, stop })
                            }
                            onConfirmPayment={() =>
                              setPaymentStop({
                                delivery,
                                stop,
                                mode: "confirm",
                              })
                            }
                            onRecordPayment={() =>
                              setPaymentStop({
                                delivery,
                                stop,
                                mode: "payment",
                              })
                            }
                          />
                        ))}
                      </ol>
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>

      {paymentStop && (
        <PageDialog onClose={() => setPaymentStop(null)}>
          <DeliveryPaymentPrompt
            stop={paymentStop.stop}
            mode={paymentStop.mode}
            isConfirming={confirmingStopId === paymentStop.stop.id}
            onClose={() => setPaymentStop(null)}
            onConfirm={confirmDelivery}
          />
        </PageDialog>
      )}
    </>
  );
}
