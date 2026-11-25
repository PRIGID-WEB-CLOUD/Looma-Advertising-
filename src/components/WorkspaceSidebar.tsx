import React, { useEffect } from 'react';
import {
  Banknote,
  BarChart3,
  Bell,
  Boxes,
  Code2,
  CreditCard,
  Crosshair,
  DollarSign,
  FlaskConical,
  Globe,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Sun,
  Wallet,
  X,
} from 'lucide-react';
import { AuthUser } from '../lib/api';
import type { AdvTab } from './AdvertiserWorkspace';
import type { PubTab } from './PublisherWorkspace';
import type { SupportPrivacyMode } from './SupportPrivacyModal';

interface WorkspaceSidebarProps {
  user: AuthUser;
  isDark: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  advTab: AdvTab;
  pubTab: PubTab;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
  onToggleTheme: () => void;
  onSelectAdvTab: (tab: AdvTab) => void;
  onSelectPubTab: (tab: PubTab) => void;
  onOpenSupportPrivacy: (mode: SupportPrivacyMode) => void;
  onSignOut: () => void;
}

const ADVERTISER_NAV: Array<{ id: AdvTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'campaigns', label: 'Campaigns', icon: Layers },
  { id: 'studio', label: 'Ad Creation Studio', icon: Palette },
  { id: 'targeting', label: 'Audience Targeting', icon: Crosshair },
  { id: 'bidding', label: 'Budget & Bidding', icon: DollarSign },
  { id: 'reporting', label: 'Reporting & Exports', icon: BarChart3 },
  { id: 'billing', label: 'Wallet & Ledger', icon: Wallet },
  { id: 'activity', label: 'Activity & Alerts', icon: Bell },
];

const PUBLISHER_NAV: Array<{ id: PubTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'properties', label: 'Properties & Verification', icon: Globe },
  { id: 'placements', label: 'Ad Units', icon: Boxes },
  { id: 'integration', label: 'Integration Center', icon: Code2 },
  { id: 'sandbox', label: 'Live Ad Sandbox', icon: FlaskConical },
  { id: 'earnings', label: 'Earnings & Payouts', icon: Banknote },
  { id: 'payouts', label: 'Payout Settings', icon: CreditCard },
];

const OTHERS_NAV: Array<{ id: SupportPrivacyMode; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'privacy', label: 'Privacy & Compliance', icon: ShieldCheck },
  { id: 'support', label: 'Contact Support', icon: LifeBuoy },
];

export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({
  user,
  isDark,
  collapsed,
  mobileOpen,
  advTab,
  pubTab,
  onToggleCollapse,
  onCloseMobile,
  onToggleTheme,
  onSelectAdvTab,
  onSelectPubTab,
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

  const sectionItems =
    user.role === 'advertiser'
      ? ADVERTISER_NAV.map((item) => ({
          ...item,
          active: advTab === item.id,
          onClick: () => {
            onSelectAdvTab(item.id);
            onCloseMobile();
          },
        }))
      : PUBLISHER_NAV.map((item) => ({
          ...item,
          active: pubTab === item.id,
          onClick: () => {
            onSelectPubTab(item.id);
            onCloseMobile();
          },
        }));

  const isCompact = collapsed && !mobileOpen;

  const sidebarBody = (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
      {/* Brand + Collapse / Mobile Close Header */}
      <div
        className={`h-16 px-4 flex items-center border-b border-slate-200 dark:border-slate-800 shrink-0 ${
          isCompact ? 'justify-center gap-1' : 'justify-between gap-2'
        }`}
      >
        {!isCompact && (
          <button
            type="button"
            onClick={onSignOut}
            className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap truncate"
          >
            Looma Advertising
          </button>
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

      {/* Scrollable Navigation Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {/* Current Workspace Section Links */}
        <nav aria-label="Workspace Sections">
          {!isCompact && (
            <div className="px-2.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2">
              {user.role === 'advertiser' ? 'Advertiser Navigation' : 'Publisher Navigation'}
            </div>
          )}
          <div className="space-y-1">
            {sectionItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={item.onClick}
                  aria-label={item.label}
                  aria-current={item.active ? 'page' : undefined}
                  title={isCompact ? item.label : undefined}
                  className={`w-full flex items-center ${
                    isCompact ? 'justify-center px-2' : 'gap-2.5 px-3'
                  } py-2 text-xs font-medium rounded-lg transition-colors ${
                    item.active
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

        {/* Others Utility Links */}
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

        {/* User Profile Summary */}
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

      {/* Footer Actions */}
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
          aria-label="Public Website / Sign Out"
          title={isCompact ? 'Public Website / Sign Out' : undefined}
          className={`w-full flex items-center ${
            isCompact ? 'justify-center px-2' : 'gap-2 px-3'
          } py-2 text-xs font-medium text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800`}
        >
          <LogOut className="w-3.5 h-3.5 shrink-0" />
          {!isCompact && <span>Public Website / Sign Out</span>}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sticky Collapsible Sidebar */}
      <aside
        aria-label="Workspace Sidebar"
        className={`hidden lg:flex lg:flex-col lg:sticky lg:top-0 lg:h-screen shrink-0 transition-[width] duration-200 ${
          collapsed ? 'lg:w-[72px]' : 'lg:w-64'
        }`}
      >
        {sidebarBody}
      </aside>

      {/* Mobile Slide-Over Sidebar Drawer */}
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
