import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { CalendarClock } from "lucide-react";
import "./layout.css";

export function Layout() {
  const { pathname } = useLocation();
  const admin = pathname.startsWith("/admin");
  return (
    <div className="layout">
      <header className="layout-header">
        <div className="container layout-header-content">
          <Link to="/" className="layout-brand">
            <CalendarClock size={20} strokeWidth={2} className="layout-brand-icon" aria-hidden />
            <span className="layout-brand-name">Calendar</span>
          </Link>
          <nav className="layout-nav" aria-label="Основная навигация">
            {admin ? (
              <>
                <NavLink
                  to="/admin"
                  end
                  className={({ isActive }) => `layout-nav-link${isActive ? " is-active" : ""}`}
                >
                  Типы встреч
                </NavLink>
                <NavLink
                  to="/admin/events"
                  className={({ isActive }) => `layout-nav-link${isActive ? " is-active" : ""}`}
                >
                  Предстоящие события
                </NavLink>
                <Link to="/book" className="layout-nav-link">
                  Гость
                </Link>
              </>
            ) : pathname === "/book" ? (
              <Link to="/admin" className="layout-nav-link guest-admin-link">
                Админка
              </Link>
            ) : (
              <Link to="/book" className="layout-nav-link">
                Записаться
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
}
