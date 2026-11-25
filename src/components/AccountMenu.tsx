import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Settings, SlidersHorizontal, User } from 'lucide-react';
import { AuthUser } from '../lib/api';

export type AccountSection = 'profile' | 'settings' | 'preferences';

interface AccountMenuProps {
  user: AuthUser;
  onOpenSection: (section: AccountSection) => void;
  onSignOut: () => void;
}

export const AccountMenu: React.FC<AccountMenuProps> = ({ user, onOpenSection, onSignOut }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function handleSelect(section: AccountSection) {
    setOpen(false);
    onOpenSection(section);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="User account menu"
        className="inline-flex items-center gap-2 pl-1.5 pr-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
      >
        <span className="w-7 h-7 rounded-full bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 flex items-center justify-center shrink-0">
          <User className="w-3.5 h-3.5" />
        </span>
        <span className="hidden sm:flex flex-col items-start text-left leading-tight">
          <span className="text-xs font-semibold text-slate-900 dark:text-white max-w-[130px] truncate">
            {user.fullName}
          </span>
          <span className="text-[10px] text-slate-500 dark:text-slate-400 capitalize">{user.role}</span>
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account options"
          className="absolute right-0 mt-2 w-60 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl py-1.5 z-50"
        >
          <div className="px-3.5 py-2.5 border-b border-slate-100 dark:border-slate-800">
            <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">{user.fullName}</div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{user.email}</div>
          </div>

          <div className="py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => handleSelect('profile')}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left"
            >
              <User className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
              <span>Profile</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleSelect('settings')}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left"
            >
              <Settings className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
              <span>Settings</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleSelect('preferences')}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left"
            >
              <SlidersHorizontal className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
              <span>Preferences</span>
            </button>
          </div>

          <div className="pt-1 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-left"
            >
              <LogOut className="w-4 h-4 shrink-0" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
