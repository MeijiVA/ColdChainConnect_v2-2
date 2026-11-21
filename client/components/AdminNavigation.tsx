import { useEffect, useState } from "react";
import { BADGE_KEY_BY_PATH, useUnseenCounts, type BadgeKey } from "@/lib/unseen";
import { NavLink, useLocation } from "react-router-dom";
import {
  BadgeCheck,
  Boxes,
  ChartNoAxesCombined,
  ChevronDown,
  ClipboardList,
  CreditCard,
  FileText,
  History,
  LayoutDashboard,
  PanelLeft,
  Package,
  Receipt,
  RotateCcw,
  ShieldCheck,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./ui/sheet";
import { useAuth } from "@/hooks/useAuth";
import { ModulePermission } from "@shared/api";

interface NavigationItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

interface NavigationGroup {
  label: string;
  icon: LucideIcon;
  items: NavigationItem[];
}

const primaryGroups: NavigationGroup[] = [
  {
    label: "Product & Customer Management",
    icon: Boxes,
    items: [
      { label: "Products", path: "/information-management/products", icon: Package },
      { label: "Inventory", path: "/information-management/inventory", icon: Boxes },
      { label: "Customers", path: "/information-management/customers", icon: Users },
    ],
  },
  {
    label: "Order Fulfillment",
    icon: ClipboardList,
    items: [
      { label: "Orders", path: "/booking-dispatch/order-summary", icon: ClipboardList },
      { label: "Pallet Preparation", path: "/booking-dispatch/preparation", icon: Package },
      { label: "Pallet Tracking", path: "/booking-dispatch/inventory", icon: Boxes },
      { label: "Receipts", path: "/booking-dispatch/invoicing", icon: FileText },
    ],
  },
  {
    label: "Delivery & Customer Operations",
    icon: Truck,
    items: [
      { label: "Truck Dispatch", path: "/booking-dispatch/delivery", icon: Truck },
      { label: "Accounts Receivable", path: "/booking-dispatch/accounts", icon: CreditCard },
      { label: "Delivery History", path: "/booking-dispatch/delivery-history", icon: History },
      { label: "Returns", path: "/booking-dispatch/agent-returns", icon: RotateCcw },
    ],
  },
  {
    label: "Accounting",
    icon: Wallet,
    items: [
      { label: "End-of-Day", path: "/accounting/payments", icon: BadgeCheck },
      { label: "Expenses", path: "/accounting/expenses", icon: Receipt },
    ],
  },
];

const accountGroup: NavigationGroup = {
  label: "Manage Accounts",
  icon: Users,
  items: [
    { label: "Agents", path: "/manage-accounts/agents", icon: Users },
    { label: "Drivers", path: "/manage-accounts/drivers", icon: Truck },
    { label: "Admins", path: "/manage-accounts/admin", icon: ShieldCheck },
    { label: "Staff", path: "/manage-accounts/staff", icon: Users },
  ],
};

const navigationGroups = [...primaryGroups, accountGroup];

const secondaryLinks: NavigationItem[] = [
  { label: "Reports", path: "/reports", icon: ChartNoAxesCombined },
  { label: "Administration", path: "/audit", icon: ShieldCheck },
];

function isItemActive(path: string, pathname: string) {
  return pathname === path || pathname.startsWith(`${path}/`);
}

const BADGE_LABEL: Partial<Record<BadgeKey, string>> = { reorder: "to reorder", outstanding: "outstanding", unverifiedPayments: "to verify" };

const BADGE_QUERY_BY_PATH: Record<string, string> = {
  "/information-management/inventory": "?stock=low",
  "/booking-dispatch/order-summary": "?status=pending",
};

function NewBadge({ count, label = "new", collapsed }: { count: number; label?: string; collapsed?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={`${count} ${label}`}
      className={`flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-bold leading-none text-white tabular-nums ${collapsed ? "absolute right-1 top-1" : "shrink-0"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function NavigationLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavigationItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const badgeKey = BADGE_KEY_BY_PATH[item.path];
  const count = useUnseenCounts()[badgeKey as BadgeKey] ?? 0;
  return (
    <NavLink
      to={`${item.path}${count > 0 ? (BADGE_QUERY_BY_PATH[item.path] ?? "") : ""}`}
      end={item.path === "/"}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `group relative flex min-h-10 items-center rounded-lg text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
          collapsed ? "justify-center px-2" : "gap-3 px-3"
        } ${
          isActive
            ? "bg-white/15 text-white"
            : "text-white/70 hover:bg-white/10 hover:text-white"
        }`
      }
    >
      <Icon size={18} className="shrink-0" aria-hidden="true" />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {badgeKey && <NewBadge count={count} label={BADGE_LABEL[badgeKey] ?? "new"} collapsed={collapsed} />}
    </NavLink>
  );
}

function NavigationMenu({
  collapsed,
  onExpand,
  onNavigate,
}: {
  collapsed: boolean;
  onExpand?: () => void;
  onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const user = useAuth((state) => state.user);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const moduleForGroup: Record<string, ModulePermission> = {
    "Product & Customer Management": "product-customer",
    "Order Fulfillment": "order-fulfillment",
    "Delivery & Customer Operations": "delivery-operations",
    Accounting: "accounting",
    "Manage Accounts": "manage-accounts",
  };
  const canAccess = (permission: ModulePermission) => user?.role !== "staff" || user.module_permissions?.includes(permission);

  useEffect(() => {
    const activeGroup = navigationGroups.find((group) => group.items.some((item) => isItemActive(item.path, pathname)));
    if (activeGroup) {
      setExpandedGroups((current) => ({ ...current, [activeGroup.label]: true }));
    }
  }, [pathname]);

  const unseenCounts = useUnseenCounts();
  const renderGroup = (group: NavigationGroup) => {
    const Icon = group.icon;
    const groupUnseen = group.items.reduce((sum, item) => sum + (unseenCounts[BADGE_KEY_BY_PATH[item.path]] ?? 0), 0);
    const isActive = group.items.some((item) => isItemActive(item.path, pathname));
    const isOpen = expandedGroups[group.label] ?? isActive;

    return (
      <Collapsible
        key={group.label}
        open={isOpen}
        onOpenChange={(open) => setExpandedGroups((current) => ({ ...current, [group.label]: open }))}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            title={collapsed ? group.label : undefined}
            aria-expanded={collapsed ? undefined : isOpen}
            onClick={(event) => {
              if (!collapsed) return;
              event.preventDefault();
              onExpand?.();
              setExpandedGroups((current) => ({ ...current, [group.label]: true }));
            }}
            className={`flex min-h-10 w-full items-center rounded-lg text-left text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
              collapsed ? "justify-center px-2" : "gap-3 px-3"
            } relative ${isActive ? "bg-white/10 text-white" : "text-white/75 hover:bg-white/10 hover:text-white"}`}
          >
            <Icon size={18} className="shrink-0" aria-hidden="true" />
            {collapsed && <NewBadge count={groupUnseen} collapsed />}
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">{group.label}</span>
                {!isOpen && <NewBadge count={groupUnseen} />}
                <ChevronDown size={15} className={`shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
              </>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className={collapsed ? "hidden" : "ml-4 mt-1 space-y-1 border-l border-white/15 pl-3"}>
          {group.items.map((item) => (
            <NavigationLink key={item.path} item={item} collapsed={false} onNavigate={onNavigate} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  return (
    <nav aria-label="Admin navigation" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
      {canAccess("dashboard") && <NavigationLink
        item={{ label: "Dashboard", path: "/", icon: LayoutDashboard }}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />}
      <div className="mt-2 space-y-1">
        {navigationGroups.slice(0, primaryGroups.length).filter((group) => canAccess(moduleForGroup[group.label])).map(renderGroup)}
      </div>
      {canAccess("manage-accounts") && <>
        <div className="my-3 border-t border-white/15" />
        {renderGroup(navigationGroups[navigationGroups.length - 1])}
      </>}
      {secondaryLinks.map((item) => {
        const permission = item.path === "/reports" ? "reports" : "administration";
        return canAccess(permission) ? <NavigationLink key={item.path} item={item} collapsed={collapsed} onNavigate={onNavigate} /> : null;
      })}
    </nav>
  );
}

export function AdminNavigation() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      aria-label="Admin sidebar"
      style={{
        top: "var(--app-header-height, 72px)",
        height: "calc(100dvh - var(--app-header-height, 72px))",
      }}
      className={`sticky hidden shrink-0 flex-col border-r border-white/10 bg-navy px-3 py-4 text-white transition-[width] duration-200 md:flex ${collapsed ? "w-[4.5rem]" : "w-64"}`}
    >
      <div className={`mb-4 flex h-10 items-center ${collapsed ? "justify-center" : "justify-between px-2"}`}>
        {!collapsed && <span className="text-2xs font-bold text-chrome-muted">Workspace</span>}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-white/65 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          <PanelLeft size={18} aria-hidden="true" />
        </button>
      </div>
      <NavigationMenu collapsed={collapsed} onExpand={() => setCollapsed(false)} />
    </aside>
  );
}

export function AdminMobileNavigation() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open navigation"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20 md:hidden"
        >
          <PanelLeft size={19} aria-hidden="true" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 max-w-[85vw] flex-col border-white/10 bg-navy p-3 text-white sm:max-w-xs">
        <SheetTitle className="mb-5 px-3 pt-2 pr-10 text-left font-rajdhani text-xl font-bold text-white">
          Navigation
        </SheetTitle>
        <NavigationMenu collapsed={false} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
