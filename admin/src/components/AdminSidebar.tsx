import React, { useEffect } from 'react';
import {
  Building2,
  ClipboardCheck,
  Landmark,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { AuthUser } from '../lib/api';
import type { AdminTab } from './AdminWorkspace';
import type { SupportPrivacyMode } from './SupportPrivacyModal';

interface AdminSidebarProps {
  user: AuthUser;
  isDark: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  adminTab: AdminTab;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
  onToggleTheme: () => void;
  onSelectAdminTab: (tab: AdminTab) => void;
  onOpenSupportPrivacy: (mode: SupportPrivacyMode) => void;
  onSignOut: () => void;
}

const ADMIN_NAV: Array<{ id: AdminTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: 'Ecosystem Overview', icon: LayoutDashboard },
  { id: 'moderation', label: 'Moderation Queue', icon: ClipboardCheck },
  { id: 'advertisers', label: 'Advertisers', icon: Users },
  { id: 'publishers', label: 'Publishers & Properties', icon: Building2 },
  { id: 'fraud', label: 'Traffic Quality', icon: ShieldAlert },
  { id: 'finance', label: 'Financial Reconciliation', icon: Landmark },
  { id: 'settings', label: 'Platform Settings', icon: SlidersHorizontal },
];

const OTHERS_NAV: Array<{ id: SupportPrivacyMode; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'privacy', label: 'Privacy & Compliance', icon: ShieldCheck },
  { id: 'support', label: 'Contact Support', icon: LifeBuoy },
];

export const AdminSidebar: React.FC<AdminSidebarProps> = ({
  user,
  isDark,
  collapsed,
  mobileOpen,
  adminTab,
  onToggleCollapse,
  onCloseMobile,
  onToggleTheme,
  onSelectAdminTab,
  onOpenSupportPrivacy,
  onSignOut,
}) => {
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseMobile();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen, onCloseMobile]);

  const initials = user.fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  const isCompact = collapsed && !mobileOpen;

  const sidebarBody = (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
      <div
        className={`h-16 px-4 flex items-center border-b border-slate-200 dark:border-slate-800 shrink-0 ${
          isCompact ? 'justify-center gap-1' : 'justify-between gap-2'
        }`}
      >
        {!isCompact && (
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap truncate">
            Looma Admin
          </span>
        )}

        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden lg:inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors shrink-0"
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation sidebar"
          className="lg:hidden inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        <nav aria-label="Admin Operations">
          {!isCompact && (
            <div className="px-2.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2">
              Admin Navigation
            </div>
          )}
          <div className="space-y-1">
            {ADMIN_NAV.map((item) => {
              const Icon = item.icon;
              const active = adminTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelectAdminTab(item.id);
                    onCloseMobile();
                  }}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  title={isCompact ? item.label : undefined}
                  className={`w-full flex items-center ${
                    isCompact ? 'justify-center px-2' : 'gap-2.5 px-3'
                  } py-2 text-xs font-medium rounded-lg transition-colors ${
                    active
                      ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-800 dark:text-blue-200'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {!isCompact && <span className="truncate">{item.label}</span>}
                </button>
              );
            })}
          </div>
        </nav>

        <nav aria-label="Others" className="pt-4 border-t border-slate-200 dark:border-slate-800">
          {!isCompact && (
            <div className="px-2.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2">Others</div>
          )}
          <div className="space-y-1">
            {OTHERS_NAV.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onOpenSupportPrivacy(item.id);
                    onCloseMobile();
                  }}
                  aria-label={item.label}
                  title={isCompact ? item.label : undefined}
                  className={`w-full flex items-center ${
                    isCompact ? 'justify-center px-2' : 'gap-2.5 px-3'
                  } py-2 text-xs font-medium rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {!isCompact && <span className="truncate">{item.label}</span>}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
          {!isCompact && (
            <div className="px-2.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2">
              Signed In As
            </div>
          )}
          <div className={`flex items-center ${isCompact ? 'justify-center' : 'gap-2.5 px-2.5'}`}>
            <div
              className="w-7 h-7 rounded-full bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-[11px] font-semibold flex items-center justify-center shrink-0"
              aria-hidden="true"
            >
              {initials || 'LA'}
            </div>
            {!isCompact && (
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">{user.fullName}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{user.email}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2 shrink-0">
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          title={isCompact ? (isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode') : undefined}
          className={`w-full flex items-center ${
            isCompact ? 'justify-center px-2' : 'gap-2 px-3'
          } py-2 text-xs font-medium text-slate-700 dark:text-slate-300 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800`}
        >
          {isDark ? <Sun className="w-3.5 h-3.5 shrink-0" /> : <Moon className="w-3.5 h-3.5 shrink-0" />}
          {!isCompact && <span>{isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}</span>}
        </button>
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign Out"
          title={isCompact ? 'Sign Out' : undefined}
          className={`w-full flex items-center ${
            isCompact ? 'justify-center px-2' : 'gap-2 px-3'
          } py-2 text-xs font-medium text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800`}
        >
          <LogOut className="w-3.5 h-3.5 shrink-0" />
          {!isCompact && <span>Sign Out</span>}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside
        aria-label="Admin Sidebar"
        className={`hidden lg:flex lg:flex-col lg:sticky lg:top-0 lg:h-screen shrink-0 transition-[width] duration-200 ${
          collapsed ? 'lg:w-[72px]' : 'lg:w-64'
        }`}
      >
        {sidebarBody}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/45 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside
            aria-label="Mobile Navigation Sidebar"
            className="relative z-10 w-72 max-w-[85vw] h-full flex flex-col shadow-2xl"
          >
            {sidebarBody}
          </aside>
        </div>
      )}
    </>
  );
};
