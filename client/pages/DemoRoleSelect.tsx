import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Briefcase, Loader2, Store } from "lucide-react";
import type { DemoLoginRequest } from "@shared/api";
import { useAuth } from "../hooks/useAuth";
import { ColdRoute } from "./Login";

type DemoRole = DemoLoginRequest["role"];

const OPTIONS: ReadonlyArray<{ role: DemoRole; title: string; description: string; icon: typeof Briefcase }> = [
  {
    role: "staff",
    title: "Staff account",
    description: "Back office: orders, inventory, deliveries, accounting and reports.",
    icon: Briefcase,
  },
  {
    role: "agent",
    title: "Agent account",
    description: "Field sales: book orders for your customers and track pallets and deliveries.",
    icon: Store,
  },
];

/** Demo deployment entry screen: pick a kind of account instead of signing in. */
export function DemoRoleSelect() {
  const [pendingRole, setPendingRole] = useState<DemoRole | null>(null);
  const [error, setError] = useState("");
  const demoLogin = useAuth((state) => state.demoLogin);
  const navigate = useNavigate();

  const choose = async (role: DemoRole) => {
    if (pendingRole) return;
    setError("");
    setPendingRole(role);
    try {
      const user = await demoLogin(role);
      navigate(user.role === "agent" ? "/booking-dispatch/order-summary" : "/", { replace: true });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not start the demo");
      setPendingRole(null);
    }
  };

  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[1.05fr_1fr]">
      <aside className="login-brand relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex xl:p-16">
        <div className="flex items-center gap-3">
          <span className="h-11 w-11 overflow-hidden rounded-full ring-2 ring-white/30">
            <img src="https://cdn.builder.io/api/v1/image/assets%2Feac2d0d867f54007b4538c37b7be16a7%2F29275c5234184b8a9c0e21283e9dec28?format=webp&width=800&height=1200" alt="ACDP logo" className="h-full w-full object-cover" />
          </span>
          <span className="font-rajdhani text-lg font-bold tracking-wide">ACDP</span>
        </div>

        <div className="max-w-xl">
          <h1 className="font-rajdhani text-6xl font-bold leading-[0.95] tracking-tight text-white xl:text-7xl">
            Cold Chain
            <br />
            Connect
          </h1>
          <p className="mt-5 text-lg text-chrome-foreground/75">From cold storage to the customer's door.</p>
        </div>

        <ColdRoute />
      </aside>

      <main className="flex flex-col px-6 py-8 sm:px-12">
        <div className="flex items-center gap-3 lg:hidden">
          <span className="h-10 w-10 overflow-hidden rounded-full ring-1 ring-border">
            <img src="https://cdn.builder.io/api/v1/image/assets%2Feac2d0d867f54007b4538c37b7be16a7%2F29275c5234184b8a9c0e21283e9dec28?format=webp&width=800&height=1200" alt="ACDP logo" className="h-full w-full object-cover" />
          </span>
          <span className="font-rajdhani text-lg font-bold text-foreground">Cold Chain Connect</span>
        </div>

        <div className="mx-auto flex w-full max-w-[24rem] flex-1 flex-col justify-center py-10 login-rise">
          <span className="mb-4 w-fit rounded-full border border-border px-3 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Demo
          </span>
          <h2 className="font-rajdhani text-4xl font-bold tracking-tight text-foreground">Choose an account</h2>
          <p className="mb-9 mt-2 text-base text-muted-foreground">
            Explore Cold Chain Connect as one of these roles. No password needed.
          </p>

          {error && (
            <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive-soft px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-4">
            {OPTIONS.map(({ role, title, description, icon: Icon }) => {
              const isPending = pendingRole === role;
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => choose(role)}
                  disabled={pendingRole !== null}
                  className="flex w-full items-start gap-4 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    {isPending ? <Loader2 className="animate-spin" size={22} aria-hidden="true" /> : <Icon size={22} aria-hidden="true" />}
                  </span>
                  <span className="flex flex-col gap-1">
                    <span className="font-rajdhani text-xl font-bold text-foreground">
                      {isPending ? "Opening…" : title}
                    </span>
                    <span className="text-sm text-muted-foreground">{description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
