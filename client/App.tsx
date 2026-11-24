import "./global.css";
import { lazy, Suspense } from "react";

import { Toaster } from "@/components/ui/toaster";
import { createRoot } from "react-dom/client";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { ConfirmDialogHost } from "@/lib/confirm";
import { installSessionGuard } from "@/lib/session-guard";

installSessionGuard();
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from "react-router-dom";
import type { ModulePermission } from "@shared/api";
import { useAuth } from "./hooks/useAuth";
import { DemoRoleSelect } from "./pages/DemoRoleSelect";
import { Topbar } from "./components/Topbar";
import { AdminMobileNavigation, AdminNavigation } from "./components/AdminNavigation";
import { PostLoginLoadingScreen } from "./components/auth/PostLoginLoadingScreen";
import { BottomNavBar } from "./components/BottomNavBar";
import { DriverBottomNav } from "./components/driver/DriverBottomNav";
import NotFound from "./pages/NotFound";
import { PageSkeleton, RouteBoundary } from "./components/shared/RouteBoundary";

// Route-level code splitting: each role downloads only the screens it opens.
const named = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, key: K) =>
  lazy(() => load().then((module) => ({ default: module[key] })));
const Dashboard = named(() => import("./pages/Dashboard"), "Dashboard");
const InformationManagement = named(() => import("./pages/InformationManagement"), "InformationManagement");
const ManageAccounts = named(() => import("./pages/ManageAccounts"), "ManageAccounts");
const BookingDispatch = named(() => import("./pages/BookingDispatch"), "BookingDispatch");
const AuditLogPage = named(() => import("./pages/AuditLog"), "AuditLogPage");
const Accounting = named(() => import("./pages/Accounting"), "Accounting");
const Reports = named(() => import("./pages/Reports"), "Reports");
const SearchResults = named(() => import("./pages/SearchResults"), "SearchResults");
const MaintenancePanel = named(() => import("./pages/modules/maintenance/MaintenancePanel"), "MaintenancePanel");
const DriverSchedule = named(() => import("./pages/DriverSchedule"), "DriverSchedule");

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 1 } },
});

/** Mounted once as a layout route, so the top bar and sidebar stay put (and never re-animate) while pages switch. */
const AppLayout = () => {
  const { logout, user } = useAuth();
  return (
    <div className="flex min-h-screen flex-col md:h-dvh md:min-h-0 md:overflow-hidden">
      <Topbar userName={user?.username || "User"} onLogout={logout} />
      <div className="flex min-h-0 flex-1">
        <AdminNavigation />
        <div className="flex min-w-0 flex-1 flex-col md:min-h-0">
          <div className="flex flex-1 md:min-h-0">
            <div className="flex min-w-0 flex-1 flex-col bg-background pb-32 md:min-h-0 md:overflow-y-auto md:pb-0">
              <RouteBoundary><Outlet /></RouteBoundary>
            </div>
          </div>
          <BottomNavBar onLogout={logout} />
        </div>
      </div>
    </div>
  );
};

/** Agent layout: topbar only, no bottom nav, no back-to-dashboard */
const AgentLayout = ({ agentMode = false }: { agentMode?: boolean }) => {
  const { logout, user } = useAuth();
  return (
    <div className={agentMode ? "flex h-dvh min-h-0 flex-col overflow-hidden" : "flex flex-col min-h-screen"}>
      <Topbar userName={user?.username || "User"} onLogout={logout} />
      <div className={`flex-1 flex flex-col bg-background min-w-0 ${agentMode ? "min-h-0" : ""}`}>
        <RouteBoundary><Outlet /></RouteBoundary>
      </div>
    </div>
  );
};

const DriverLayout = () => {
  const { logout, user } = useAuth();
  return (
    <div className="flex min-h-screen flex-col">
      <Topbar userName={user?.username || "User"} onLogout={logout} />
      <div className="flex min-w-0 flex-1 flex-col bg-background pb-24">
        <RouteBoundary><Outlet /></RouteBoundary>
      </div>
      <DriverBottomNav />
    </div>
  );
};

const staffModulePaths: Record<ModulePermission, string> = {
  dashboard: "/",
  "product-customer": "/information-management",
  "order-fulfillment": "/booking-dispatch",
  "delivery-operations": "/booking-dispatch/delivery",
  "manage-accounts": "/manage-accounts/staff",
  reports: "/reports",
  administration: "/audit",
  accounting: "/accounting",
};

function StaffDispatchModule() {
  const { pathname } = useLocation();
  const deliveryPaths = ["/booking-dispatch/delivery", "/booking-dispatch/accounts", "/booking-dispatch/delivery-history", "/booking-dispatch/agent-returns"];
  const permission: ModulePermission = deliveryPaths.some((path) => pathname.startsWith(path)) ? "delivery-operations" : "order-fulfillment";
  return <StaffModule permission={permission}><BookingDispatch /></StaffModule>;
}

function StaffModule({ permission, children }: { permission: ModulePermission; children: React.ReactNode }) {
  const user = useAuth((state) => state.user);
  const allowed = user?.module_permissions ?? [];
  if (!allowed.includes(permission)) {
    const next = Object.keys(staffModulePaths).find((key) => allowed.includes(key as ModulePermission)) as ModulePermission | undefined;
    return next ? <Navigate to={staffModulePaths[next]} replace /> : <div className="p-8 text-center text-foreground">No modules are currently assigned to your account. Contact an administrator.</div>;
  }
  return <>{children}</>;
}

const AppContent = () => {
  const { isAuthenticated, user } = useAuth();
  const isAgent = user?.role === "agent";
  const isDriver = user?.role === "driver";
  const isStaff = user?.role === "staff";

  if (isAuthenticated && isStaff) {
    return (
      <Routes>
        <Route path="/login" element={<DemoRoleSelect />} />
        <Route element={<AppLayout />}>
        <Route path="/" element={<StaffModule permission="dashboard"><Dashboard /></StaffModule>} />
        <Route path="/information-management/*" element={<StaffModule permission="product-customer"><InformationManagement /></StaffModule>} />
        <Route path="/booking-dispatch/*" element={<StaffDispatchModule />} />
        <Route path="/manage-accounts/*" element={<StaffModule permission="manage-accounts"><ManageAccounts /></StaffModule>} />
        <Route path="/accounting/*" element={<StaffModule permission="accounting"><Accounting /></StaffModule>} />
        <Route path="/audit" element={<StaffModule permission="administration"><AuditLogPage /></StaffModule>} />
        <Route path="/reports" element={<StaffModule permission="reports"><Reports /></StaffModule>} />
        <Route path="/search" element={<StaffModule permission="order-fulfillment"><SearchResults /></StaffModule>} />
        </Route>
        <Route path="*" element={<Navigate to={staffModulePaths["dashboard"]} replace />} />
      </Routes>
    );
  }

  // ── Driver: only their delivery schedule is accessible ──────────
  if (isAuthenticated && isDriver) {
    return (
      <Routes>
        <Route path="/login" element={<DemoRoleSelect />} />
        <Route element={<DriverLayout />}>
          <Route path="/driver-schedule" element={<DriverSchedule />} />
          <Route path="/driver-maintenance" element={<MaintenancePanel />} />
        </Route>
        <Route path="*" element={<Navigate to="/driver-schedule" replace />} />
      </Routes>
    );
  }

  // ── Agent: only booking-dispatch is accessible ──────────────────
  if (isAuthenticated && isAgent) {
    return (
      <Routes>
        <Route path="/login" element={<DemoRoleSelect />} />
        <Route element={<AgentLayout agentMode />}>
          <Route path="/booking-dispatch/*" element={<BookingDispatch />} />
          <Route path="/search" element={<SearchResults />} />
        </Route>
        {/* Everything else → booking-dispatch */}
        <Route path="*" element={<Navigate to="/booking-dispatch/order-summary" replace />} />
      </Routes>
    );
  }

  // ── Admin: full access ───────────────────────────────────────────
  return (
    <Routes>
      <Route path="/login" element={<DemoRoleSelect />} />
      <Route element={isAuthenticated ? <AppLayout /> : <DemoRoleSelect />}>
      <Route path="/" element={<Dashboard />} />
      <Route path="/information-management/*" element={<InformationManagement />} />
      <Route path="/manage-accounts/*" element={<ManageAccounts />} />
      <Route path="/booking-dispatch/*" element={<BookingDispatch />} />
      <Route path="/accounting/*" element={<Accounting />} />
      <Route path="/audit" element={<AuditLogPage />} />
      <Route path="/reports" element={<Reports />} />
      <Route path="/search" element={<SearchResults />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

function PostLoginLoadingGate() {
  const isPostLoginLoading = useAuth((state) => state.isPostLoginLoading);
  return isPostLoginLoading ? <PostLoginLoadingScreen /> : null;
}

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="ccc-theme">
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner position="top-center" richColors closeButton />
        <ConfirmDialogHost />
        <BrowserRouter>
          {/* Outside the layout routes only the login screen is lazy-free; page-level boundaries live inside each layout so the shell never remounts. */}
          <Suspense fallback={<PageSkeleton />}>
            <AppContent />
          </Suspense>
          <PostLoginLoadingGate />
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

const rootElement = document.getElementById("root");
if (rootElement && !rootElement.hasChildNodes()) {
  createRoot(rootElement).render(<App />);
}
