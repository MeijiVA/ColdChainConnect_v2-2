import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { MfaChallengeResponse, MfaSetupResponse } from "@shared/api";
import { MfaStep } from "../components/auth/MfaStep";

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [challenge, setChallenge] = useState<MfaChallengeResponse | null>(null);
  const [setupInfo, setSetupInfo] = useState<MfaSetupResponse | null>(null);
  const login = useAuth((state) => state.login);
  const setupMfa = useAuth((state) => state.setupMfa);
  const verifyMfa = useAuth((state) => state.verifyMfa);
  const navigate = useNavigate();

  const resetToCredentials = () => {
    setChallenge(null);
    setSetupInfo(null);
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError("Username and password are required");
      return;
    }

    setError("");
    setIsLoading(true);

    try {
      const next = await login({ username, password });
      if (!next) {
        navigate("/");
        return;
      }
      if (next.mfa === "setup") {
        setSetupInfo(await setupMfa(next.challenge_token));
      }
      setChallenge(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (/^Sign-in expired\./i.test(message)) {
        setError("Your sign-in expired. Please enter your credentials again.");
      } else if (message === "Invalid credentials") {
        setError("Invalid username or password");
      } else if (message === "Internal server error" || message === "Login failed") {
        setError("Sign-in is temporarily unavailable. Please try again later.");
      } else {
        setError(message || "Login failed");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleMfaSubmit = async (code: string) => {
    if (!challenge) return;

    setError("");
    setIsLoading(true);

    try {
      const user = await verifyMfa({ challenge_token: challenge.challenge_token, code });
      const destination = user.role === "agent"
        ? "/booking-dispatch/order-summary"
        : user.role === "driver"
          ? "/driver-schedule"
          : "/";
      navigate(destination, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Verification failed";
      if (/^Sign-in expired\./i.test(message)) {
        setChallenge(null);
        setSetupInfo(null);
        setError("Your sign-in expired. Please enter your credentials again.");
      } else {
        setError(message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[1.05fr_1fr]">
      {/* Brand side: solid brand blue so the split is unmistakable */}
      <aside className="login-brand relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex xl:p-16">
        <div className="flex items-center gap-3">
          <span className="h-11 w-11 overflow-hidden rounded-full ring-2 ring-white/30">
            <img src="https://cdn.builder.io/api/v1/image/assets%2Feac2d0d867f54007b4538c37b7be16a7%2F29275c5234184b8a9c0e21283e9dec28?format=webp&width=800&height=1200" alt="ACDP logo" className="h-full w-full object-cover" style={{ borderStyle: "none", borderWidth: "1px" }} />
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

      {/* Form side */}
      <main className="flex flex-col px-6 py-8 sm:px-12">
        <div className="flex items-center gap-3 lg:hidden">
          <span className="h-10 w-10 overflow-hidden rounded-full ring-1 ring-border">
            <img src="https://cdn.builder.io/api/v1/image/assets%2Feac2d0d867f54007b4538c37b7be16a7%2F29275c5234184b8a9c0e21283e9dec28?format=webp&width=800&height=1200" alt="ACDP logo" className="h-full w-full object-cover" />
          </span>
          <span className="font-rajdhani text-lg font-bold text-foreground">Cold Chain Connect</span>
        </div>

        <div className="mx-auto flex w-full max-w-[24rem] flex-1 flex-col justify-center py-10 login-rise">
          <h2 className="font-rajdhani text-4xl font-bold tracking-tight text-foreground">Sign in</h2>
          <p className="mb-9 mt-2 text-base text-muted-foreground">Welcome back. Enter your details to continue.</p>

          {challenge ? (
            <MfaStep
              mode={challenge.mfa}
              setupInfo={setupInfo}
              error={error}
              isLoading={isLoading}
              onSubmit={handleMfaSubmit}
              onBack={resetToCredentials}
            />
          ) : (
            <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
              {error && (
                <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive-soft px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="login-username" className="text-sm">Username</Label>
                <Input
                  id="login-username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={isLoading}
                  aria-invalid={Boolean(error) || undefined}
                  className="h-12 text-base"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="login-password" className="text-sm">Password</Label>
                <div className="relative">
                  <Input
                    id="login-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isLoading}
                    aria-invalid={Boolean(error) || undefined}
                    className="h-12 pr-12 text-base"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((visible) => !visible)}
                    disabled={isLoading}
                    className="absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </div>
              </div>

              <Button type="submit" size="lg" disabled={isLoading} className="mt-2 h-12 w-full text-base">
                {isLoading ? (<><Loader2 className="animate-spin" aria-hidden="true" /> Signing in…</>) : "Sign in"}
              </Button>

              <p className="text-center text-sm text-muted-foreground">Forgot your password? Ask an administrator.</p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

/** A cold chain drawn as a route: a pulse travels storage → customer. Decorative; stills under reduced motion. */
export function ColdRoute() {
  return (
    <svg viewBox="0 0 480 90" className="w-full" fill="none" aria-hidden="true">
      <path id="login-route" d="M12 60 C 90 60, 100 22, 170 22 S 270 68, 330 52 S 420 24, 468 24" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" strokeLinecap="round" strokeDasharray="2 8" />
      {[[12, 60], [170, 22], [330, 52], [468, 24]].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="6" fill="#1e2f9e" stroke="currentColor" strokeWidth="2" />
      ))}
      <circle r="5" fill="white" className="login-pulse">
        <animateMotion dur="6s" repeatCount="indefinite" rotate="auto">
          <mpath href="#login-route" />
        </animateMotion>
      </circle>
    </svg>
  );
}
