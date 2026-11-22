import { useQuery } from "@tanstack/react-query";
import type { DashboardSummary } from "@shared/api";
import { Link, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import {
  LayoutDashboard,
  Package,
  Users,
  Truck,
  Wallet,
  FileText,
  ClipboardList,
  History,
  RotateCcw,
  BadgeCheck,
  Receipt,
} from "lucide-react";

interface BottomNavBarProps {
  onLogout: () => void;
}

const globalNavItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/information-management/products", label: "Products", icon: Package },
  { path: "/booking-dispatch/order-summary", label: "Orders", icon: ClipboardList },
  { path: "/booking-dispatch/delivery", label: "Operations", icon: Truck },
  { path: "/accounting/payments", label: "Accounting", icon: Wallet },
];

// Map of hub paths to their sub-modules
const hubModulesByPath: Record<string, Array<{ path: string; label: string; icon: React.ElementType }>> = {
  "/information-management": [
    { path: "/products", label: "Products", icon: Package },
    { path: "/inventory", label: "Inventory", icon: Package },
    { path: "/customers", label: "Customers", icon: Users },
  ],
  "/booking-dispatch": [
    { path: "/order-summary", label: "Orders", icon: ClipboardList },
    { path: "/preparation", label: "Pallet Preparation", icon: Package },
    { path: "/inventory", label: "Pallet Tracking", icon: Package },
    { path: "/invoicing", label: "Receipts", icon: FileText },
    { path: "/delivery", label: "Truck Dispatch", icon: Truck },
    { path: "/accounts", label: "Accounts Receivable", icon: Wallet },
    { path: "/delivery-history", label: "Delivery History", icon: History },
    { path: "/agent-returns", label: "Returns and Maintenance", icon: RotateCcw },
  ],
  "/accounting": [
    { path: "/payments", label: "End-of-Day", icon: BadgeCheck },
    { path: "/expenses", label: "Expenses", icon: Receipt },
  ],
  "/manage-accounts": [
    { path: "/agents", label: "Agents", icon: Users },
    { path: "/drivers", label: "Drivers", icon: Truck },
    { path: "/admin", label: "Admins", icon: Users },
    { path: "/staff", label: "Staff", icon: Users },
  ],
};

export function BottomNavBar({ onLogout }: BottomNavBarProps) {
  const location = useLocation();
  const currentPath = location.pathname;
  const { user, token } = useAuth();
  const isAdmin = user?.role === "admin";
  const isStaff = user?.role === "staff";
  const staffCan = (permission: "dashboard" | "product-customer" | "order-fulfillment" | "delivery-operations" | "manage-accounts" | "accounting") => !isStaff || Boolean(user.module_permissions?.includes(permission));
  // Badge counts share the dashboard's 1 KB summary (same query key, one request).
  const { data: summary } = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: async (): Promise<DashboardSummary> => {
      const res = await fetch("/api/dashboard/summary", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`dashboard summary ${res.status}`);
      return res.json();
    },
    enabled: isAdmin && Boolean(token),
    refetchInterval: 60_000,
  });
  const counts = { pendingOrders: summary?.pendingOrders ?? 0, activeDeliveries: summary?.activeDeliveries ?? 0 };

  const countForPath = (path: string) => {
    if (path.endsWith("/order-summary")) return counts.pendingOrders;
    if (path.endsWith("/delivery")) return counts.activeDeliveries;
    return 0;
  };

  // Determine which hub the user is in and get the appropriate modules
  let currentHub: string | null = null;
  let modulesToShow: Array<{ path: string; label: string; icon: React.ElementType }> = [];

  if ((isAdmin || isStaff) && currentPath.startsWith("/information-management")) {
    currentHub = "/information-management";
    modulesToShow = (hubModulesByPath["/information-management"] || []).filter(() => staffCan("product-customer"));
  } else if ((isAdmin || isStaff) && currentPath.startsWith("/booking-dispatch")) {
    currentHub = "/booking-dispatch";
    modulesToShow = (hubModulesByPath["/booking-dispatch"] || []).filter(({ path }) => {
      const delivery = ["/delivery", "/accounts", "/delivery-history", "/agent-returns"].includes(path);
      return staffCan(delivery ? "delivery-operations" : "order-fulfillment");
    });
  } else if ((isAdmin || isStaff) && currentPath.startsWith("/accounting") && staffCan("accounting")) {
    currentHub = "/accounting";
    modulesToShow = hubModulesByPath["/accounting"] || [];
  } else if ((isAdmin || isStaff) && currentPath.startsWith("/manage-accounts") && staffCan("manage-accounts")) {
    currentHub = "/manage-accounts";
    modulesToShow = hubModulesByPath["/manage-accounts"] || [];
  }

  if (currentHub && modulesToShow.length > 0) {
    return (
      <div className="fixed bottom-0 left-0 right-0 bg-navy border-t border-white/10 z-30 md:hidden">
        <div className="flex overflow-x-auto overflow-y-hidden gap-1 px-2 py-1 justify-start sm:justify-center scrollbar-visible" style={{ WebkitOverflowScrolling: "touch" }}>
          {modulesToShow.map(({ path, label, icon: Icon }) => {
            const fullPath = currentHub + path;
            const isActive = currentPath === fullPath || currentPath.startsWith(fullPath + "/");
            return (
              <Link
                key={fullPath}
                to={fullPath}
                className={`flex-shrink-0 flex flex-col items-center justify-center px-3 py-2 rounded-full text-2xs font-semibold transition min-w-max gap-0.5 ${
                  isActive
                    ? "bg-chrome-active text-white"
                    : "text-white/60 hover:text-white hover:bg-white/10"
                }`}
              >
                <span className="relative"><Icon size={16} />{countForPath(path) > 0 && <span className="absolute -right-2 -top-2 min-w-4 rounded-full bg-brand-gold px-1 text-center text-2xs font-bold leading-4 text-brand-gold-foreground">{countForPath(path) > 99 ? "99+" : countForPath(path)}</span>}</span>
                <span className="truncate">{label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    );
  }

  // Show global nav for dashboard or when not in a hub page
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-navy border-t border-white/10 z-30 md:hidden">
      <div className="flex overflow-x-auto overflow-y-hidden scrollbar-visible gap-1 scroll-smooth touch-pan-x px-2 py-1 [justify-content:safe_center]" style={{ WebkitOverflowScrolling: "touch" }}>
        {globalNavItems.filter(({ path }) => {
          if (path === "/") return staffCan("dashboard");
          if (path.startsWith("/information-management")) return staffCan("product-customer");
          if (path.startsWith("/accounting")) return staffCan("accounting");
          if (path.includes("delivery")) return staffCan("delivery-operations");
          return staffCan("order-fulfillment");
        }).map(({ path, label, icon: Icon }) => {
          const isActive = currentPath === path || (path !== "/" && currentPath.startsWith(path));
          return (
            <Link
              key={path}
              to={path}
              className={`flex-shrink-0 flex flex-col items-center justify-center px-3 py-2 rounded-full text-2xs font-semibold transition min-w-max gap-0.5 ${
                isActive
                  ? "bg-chrome-active text-white"
                  : "text-white/60 hover:text-white hover:bg-white/10"
              }`}
            >
              <span className="relative"><Icon size={16} />{countForPath(path) > 0 && <span className="absolute -right-2 -top-2 min-w-4 rounded-full bg-brand-gold px-1 text-center text-2xs font-bold leading-4 text-brand-gold-foreground">{countForPath(path) > 99 ? "99+" : countForPath(path)}</span>}</span>
              <span>{label}</span>
            </Link>
          );
        })}
        <div className="flex-shrink-0 w-2" />
      </div>
    </div>
  );
}
