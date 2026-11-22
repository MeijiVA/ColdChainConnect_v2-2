import { NavLink } from "react-router-dom";
import { CalendarDays, Wrench } from "lucide-react";

const items = [
  { path: "/driver-schedule", label: "Schedule", icon: CalendarDays },
  { path: "/driver-maintenance", label: "Maintenance", icon: Wrench },
];

export function DriverBottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-white/10 bg-navy">
      <div className="mx-auto flex max-w-2xl justify-around gap-1 px-2 py-1">
        {items.map(({ path, label, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 rounded-full px-3 py-2 text-2xs font-semibold transition ${
                isActive ? "bg-chrome-active text-white" : "text-white/60 hover:bg-white/10 hover:text-white"
              }`
            }
          >
            <Icon size={16} />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
