import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { DriverSchedule, DriverScheduleRun, DriverScheduleStop } from "@shared/api";
import { DriverStopCard } from "./DriverStopCard";

function toIsoDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shiftDate(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return toIsoDate(new Date(year, month - 1, day + days));
}

function byScheduledDate(a: DriverScheduleRun, b: DriverScheduleRun) {
  return (a.scheduled_date ?? "").localeCompare(b.scheduled_date ?? "");
}

export function DriverScheduleView({ driverId }: { driverId?: string }) {
  const token = useAuth((state) => state.token);
  const finishPostLoginLoading = useAuth((state) => state.finishPostLoginLoading);
  const [date, setDate] = useState(() => toIsoDate(new Date()));
  const [showUnconfirmed, setShowUnconfirmed] = useState(false);
  const [schedule, setSchedule] = useState<DriverSchedule | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a stop is confirmed or paid so the effect below fetches the schedule again.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!token) return;
    const params = showUnconfirmed
      ? new URLSearchParams({ scope: "unconfirmed" })
      : new URLSearchParams({ date });
    if (driverId) params.set("driver_id", driverId);

    setIsLoading(true);
    fetch(`/api/driver-schedule?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? "Could not load schedule");
        }
        return response.json() as Promise<DriverSchedule>;
      })
      .then((data) => {
        setSchedule(data);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        setIsLoading(false);
        finishPostLoginLoading();
      });
  }, [token, date, driverId, showUnconfirmed, reloadKey]);

  const toggleUnconfirmed = () => {
    setSchedule(null);
    setShowUnconfirmed((current) => !current);
  };

  const stops: DriverScheduleStop[] = schedule?.deliveries.flatMap((run) => run.delivery_items) ?? [];
  const unconfirmedRuns = [...(schedule?.deliveries ?? [])].sort(byScheduledDate);
  const onChanged = () => setReloadKey((key) => key + 1);

  return (
    <div className="space-y-4">
      {showUnconfirmed ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">Unconfirmed deliveries, all dates</p>
          <Button type="button" onClick={toggleUnconfirmed} variant="outline" size="sm">
            Back to day
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={() => setDate((current) => shiftDate(current, -1))}
            variant="outline" size="sm"
          >
            Previous
          </Button>
          <Input
            type="date"
            value={date}
            onChange={(event) => event.target.value && setDate(event.target.value)}
            className="flex-1"
          />
          <Button
            type="button"
            onClick={() => setDate((current) => shiftDate(current, 1))}
            variant="outline" size="sm"
          >
            Next
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-red">{error}</p>}
      {isLoading && !schedule && <LoadingSpinner className="min-h-24" />}

      {schedule && !error && !showUnconfirmed && (
        <>
          <p className="text-xs text-muted-foreground">
            {stops.length} {stops.length === 1 ? "stop" : "stops"} scheduled for {date}
          </p>
          {stops.length === 0 ? (
            <div className="bg-card border border-border rounded-2xl p-8 text-center text-sm text-muted-foreground">
              No deliveries scheduled for this day.
            </div>
          ) : (
            <div className="space-y-3">
              {stops.map((stop, index) => (
                <DriverStopCard key={stop.id} stop={stop} index={index + 1} onChanged={onChanged} />
              ))}
            </div>
          )}
        </>
      )}

      {schedule && !error && showUnconfirmed && (
        unconfirmedRuns.length === 0 ? (
          <div className="bg-card border border-border rounded-2xl p-8 text-center text-sm text-muted-foreground">
            No unconfirmed deliveries.
          </div>
        ) : (
          <div className="space-y-5">
            {unconfirmedRuns.map((run) => (
              <section key={run.id} className="space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {run.scheduled_date ?? "No date"}
                </h2>
                {run.delivery_items.map((stop, index) => (
                  <DriverStopCard key={stop.id} stop={stop} index={index + 1} onChanged={onChanged} />
                ))}
              </section>
            ))}
          </div>
        )
      )}

      {!showUnconfirmed && (
        <Button type="button" onClick={toggleUnconfirmed} variant="outline" className="w-full">
          Show all unconfirmed deliveries
        </Button>
      )}
    </div>
  );
}
