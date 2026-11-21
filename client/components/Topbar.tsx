import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Bell, LogOut, Monitor, Moon, Search, Settings, Sun, Truck } from "lucide-react";
import { useTheme } from "next-themes";
import { useAuth } from "@/hooks/useAuth";
import { NotificationPanel } from "./NotificationPanel";
import { useNotifications } from "@/hooks/useNotifications";
import { useGlobalSearchData } from "@/hooks/useGlobalSearchData";
import { AdminMobileNavigation } from "@/components/AdminNavigation";
import { EMPTY_SEARCH_DATA, searchAll, type SearchHit } from "@/lib/globalSearch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface TopbarProps {
  userName: string;
  onLogout?: () => void;
}

export function Topbar({ userName, onLogout }: TopbarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, setTheme } = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get("q") ?? "");
  const [showNotifications, setShowNotifications] = useState(false);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [hoveredSuggestionId, setHoveredSuggestionId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const { data: searchData = EMPTY_SEARCH_DATA, isFetching: isFetchingSearch } = useGlobalSearchData(
    isSearchFocused && Boolean(searchTerm.trim())
  );
  const suggestions = useMemo(
    () => searchAll(searchData, searchTerm)
      .flatMap((group) => group.hits.map((hit) => ({ ...hit, group: group.label })))
      .slice(0, 8),
    [searchData, searchTerm]
  );
  const role = useAuth((state) => state.user?.role);
  const {
    notifications,
    unreadCount,
    truckAssignments,
    isLoading: isLoadingNotifications,
    error: notificationError,
    refresh: refreshNotifications,
    markAsRead,
    markAllAsRead,
    dismiss,
  } = useNotifications();

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    const updateHeaderHeight = () => {
      document.documentElement.style.setProperty(
        "--app-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
    };

    updateHeaderHeight();
    const observer = new ResizeObserver(updateHeaderHeight);
    observer.observe(header);

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--app-header-height");
    };
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && role !== "agent") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [role]);

  useEffect(() => {
    setSearchTerm(searchParams.get("q") ?? "");
  }, [searchParams]);

  const handleSearchTermChange = (value: string) => {
    setSearchTerm(value);
    setHoveredSuggestionId(null);
    if (location.pathname === "/search") {
      const nextParams = new URLSearchParams(searchParams);
      if (value.trim()) nextParams.set("q", value);
      else nextParams.delete("q");
      nextParams.delete("highlight");
      setSearchParams(nextParams, { replace: true });
    }
  };

  const updateHoveredSuggestion = (hitId: string | null) => {
    setHoveredSuggestionId(hitId);
    if (location.pathname !== "/search") return;
    const nextParams = new URLSearchParams(searchParams);
    if (hitId) nextParams.set("highlight", hitId);
    else nextParams.delete("highlight");
    setSearchParams(nextParams, { replace: true });
  };

  const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const query = searchTerm.trim();
    if (!query) return;
    setIsSearchFocused(false);
    navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  const handleSuggestionSelect = (hit: SearchHit) => {
    setIsSearchFocused(false);
    navigate(hit.path);
  };

  return (
    <header ref={headerRef} className="bg-navy px-4 md:px-8 py-3 sm:py-4 flex flex-wrap items-center flex-shrink-0 sticky top-0 z-10 shadow-sm gap-2 sm:gap-4 md:gap-6">
      {role === "admin" && (
        <span className="text-2xs font-bold text-chrome-muted md:hidden">Workspace</span>
      )}
      <div className={`flex items-center gap-4 min-w-0 ${role === "agent" ? "flex-1" : "flex-1 sm:flex-none"} ${role === "admin" ? "justify-center sm:justify-start" : ""}`}>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <img src="https://cdn.builder.io/api/v1/image/assets%2Feac2d0d867f54007b4538c37b7be16a7%2F29275c5234184b8a9c0e21283e9dec28?format=webp&width=800&height=1200" alt="ACDP Logo" className="w-8 h-8 object-cover rounded-full" />
            <div className={`font-rajdhani text-xl font-bold text-white ${role === "admin" ? "" : "hidden sm:block"}`}>
              ACDP
            </div>
          </div>

          {role === "agent" && (
            <div className="flex min-w-0 flex-1 items-center gap-2 border-l border-white/20 pl-3 sm:pl-4" aria-label="Assigned truck and district">
              <Truck size={16} className="shrink-0 text-white/80" />
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="text-2xs font-semibold text-white/60">Assigned truck · district</span>
                <span className="truncate text-xs font-semibold text-white" title={truckAssignments.join(" / ")}>
                  {truckAssignments.length ? truckAssignments.join(" / ") : "No active truck assignment"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

        {role !== "agent" && (
          <form
            onSubmit={handleSearch}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setIsSearchFocused(false);
                updateHoveredSuggestion(null);
              }
            }}
            className="relative order-last w-full sm:order-none sm:w-64"
          >
            <input
              ref={searchInputRef}
              type="text"
              aria-keyshortcuts="Control+K Meta+K"
              placeholder="Search products, customers, orders…"
              value={searchTerm}
              onFocus={() => setIsSearchFocused(true)}
              onChange={(event) => handleSearchTermChange(event.target.value)}
              className="w-full pl-4 pr-11 py-2 rounded-lg bg-white/10 border border-white/20 text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition"
            />
            <button
              type="submit"
              aria-label="Search"
              className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            >
              <Search className="w-4 h-4" />
            </button>
            {isSearchFocused && searchTerm.trim() && (
              <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[min(70vh,420px)] overflow-y-auto rounded-lg border border-border bg-card p-1.5 text-foreground shadow-xl">
                {isFetchingSearch && searchData === EMPTY_SEARCH_DATA ? (
                  <p className="px-3 py-3 text-sm text-foreground/60">Searching…</p>
                ) : suggestions.length ? (
                  <>
                    {suggestions.map((hit) => (
                      <button
                        key={`${hit.group}-${hit.id}`}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => updateHoveredSuggestion(hit.id)}
                        onMouseLeave={() => updateHoveredSuggestion(null)}
                        onFocus={() => updateHoveredSuggestion(hit.id)}
                        onClick={() => handleSuggestionSelect(hit)}
                        className={`w-full rounded-md border-l-2 px-3 py-2 text-left transition-colors ${hoveredSuggestionId === hit.id ? "border-accent-2 bg-accent-2/10" : "border-transparent hover:bg-accent focus-visible:bg-background"}`}
                      >
                        <span className="flex items-center justify-between gap-3">
                          <span className="truncate text-sm font-semibold">{hit.title}</span>
                          <span className="shrink-0 text-2xs font-semibold text-foreground/50">{hit.group}</span>
                        </span>
                        {hit.subtitle && <span className="block truncate text-xs text-foreground/60">{hit.subtitle}</span>}
                      </button>
                    ))}
                    <button
                      type="submit"
                      onMouseDown={(event) => event.preventDefault()}
                      className="mt-1 w-full rounded-md border-t border-border px-3 py-2 text-left text-xs font-semibold text-accent-2 hover:bg-accent"
                    >
                      See all results for “{searchTerm.trim()}”
                    </button>
                  </>
                ) : (
                  <p className="px-3 py-3 text-sm text-foreground/60">No matching results.</p>
                )}
              </div>
            )}
          </form>
        )}

      {/* Right Section */}
      <div className="ml-auto flex items-center gap-2 relative">
        {role === "admin" && <AdminMobileNavigation />}
        {/* Notification button */}
        <button
          ref={bellRef}
          onClick={() => setShowNotifications(!showNotifications)}
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          aria-expanded={showNotifications}
          className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-white/20 bg-white/10 cursor-pointer text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold"
        >
          <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
          {unreadCount > 0 && (
            <div className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-brand-gold rounded-full text-2xs flex items-center justify-center text-brand-gold-foreground font-bold">
              {unreadCount > 9 ? "9+" : unreadCount}
            </div>
          )}
        </button>


        {/* Settings dropdown */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Settings"
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/20 bg-white/10 cursor-pointer text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold"
            >
              <Settings className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light"><Sun className="mr-2 h-4 w-4" aria-hidden="true" />Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><Moon className="mr-2 h-4 w-4" aria-hidden="true" />Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system"><Monitor className="mr-2 h-4 w-4" aria-hidden="true" />System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout} className="cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Notification Panel */}
        {showNotifications && (
          <NotificationPanel
            notifications={notifications}
            isLoading={isLoadingNotifications}
            error={notificationError}
            onRefresh={() => void refreshNotifications()}
            onMarkAsRead={markAsRead}
            onMarkAllAsRead={markAllAsRead}
            onDismiss={dismiss}
            onClose={() => {
              setShowNotifications(false);
              // The sheet unmounts on close, so hand focus back to the bell ourselves.
              window.setTimeout(() => bellRef.current?.focus(), 0);
            }}
          />
        )}
      </div>
    </header>
  );
}
