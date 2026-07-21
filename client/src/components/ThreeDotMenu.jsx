import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MoreVertical, Users, Archive, Star, CheckSquare, CheckCheck, Lock, Sun, Moon, Settings, Shield, Bell, LogOut } from 'lucide-react';
import './ThreeDotMenu.css';

/**
 * Global (app-level) three-dot menu — distinct from the per-conversation "..." menu inside a
 * chat (theme/disappearing/block/etc), which already exists elsewhere in ChatApp.jsx.
 *
 * Wired and real:      onNewGroup, onArchivedChats, onStarredMessages, onSelectChats,
 *                       onMarkAllRead, onAppLock, onToggleTheme, onLogout, onSettings
 * Not built yet:        Privacy, Notifications — shown disabled with a
 *                       "Coming soon" hint rather than removed, so the menu shape doesn't
 *                       keep changing on you as more of it gets built out.
 */
const ThreeDotMenu = ({
  buttonLabel = 'Menu',
  onNewGroup = () => {},
  onArchivedChats = () => {},
  onStarredMessages = () => {},
  onSelectChats = () => {},
  onMarkAllRead = () => {},
  onAppLock = () => {},
  onToggleTheme = () => {},
  onLogout = () => {},
  onSettings = () => {},
  isDarkMode = false,
  isAppLockEnabled = false,
  align = 'right', // 'right' | 'left'
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e) => {
      const el = rootRef.current;
      if (!el) return;
      if (el.contains(e.target)) return;
      close();
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const menuItems = useMemo(
    () => [
      { key: 'newGroup',  label: 'New Group',        icon: <Users size={16} />,       onSelect: onNewGroup },
      { key: 'archived',  label: 'Archived Chats',   icon: <Archive size={16} />,     onSelect: onArchivedChats },
      { key: 'starred',   label: 'Starred Messages', icon: <Star size={16} />,        onSelect: onStarredMessages },
      { key: 'select',    label: 'Select Chats',     icon: <CheckSquare size={16} />, onSelect: onSelectChats },
      { key: 'markAll',   label: 'Mark All as Read', icon: <CheckCheck size={16} />,  onSelect: onMarkAllRead },
      { key: 'sep1', type: 'sep' },

      { key: 'appLock', label: isAppLockEnabled ? 'App Lock · On' : 'App Lock · Off', icon: <Lock size={16} />, onSelect: onAppLock, active: isAppLockEnabled },
      { key: 'theme',   label: isDarkMode ? 'Light Mode' : 'Dark Mode', icon: isDarkMode ? <Sun size={16} /> : <Moon size={16} />, onSelect: onToggleTheme },
      { key: 'sep2', type: 'sep' },

      { key: 'settings',      label: 'Settings',      icon: <Settings size={16} />, onSelect: onSettings },
      { key: 'privacy',       label: 'Privacy',       icon: <Shield size={16} />,   disabled: true, hint: 'Coming soon' },
      { key: 'notifications', label: 'Notifications', icon: <Bell size={16} />,     disabled: true, hint: 'Coming soon' },
      { key: 'sep3', type: 'sep' },

      { key: 'logout', label: 'Logout', icon: <LogOut size={16} />, onSelect: onLogout, danger: true },
    ],
    [
      onNewGroup, onArchivedChats, onStarredMessages, onSelectChats, onMarkAllRead,
      onAppLock, isAppLockEnabled, onToggleTheme, isDarkMode, onLogout, onSettings,
    ]
  );

  const handleItemClick = async (item) => {
    if (item.disabled) return;
    try {
      await item.onSelect?.();
    } finally {
      close();
    }
  };

  return (
    <div className="ww-three-dot-menu" ref={rootRef}>
      <button
        type="button"
        className="ww-three-dot-button"
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <MoreVertical size={20} />
      </button>

      {open && (
        <div
          className={`ww-three-dot-popup ${align === 'left' ? 'left' : 'right'}`}
          role="menu"
        >
          {menuItems.map((item) => {
            if (item.type === 'sep') {
              return <div key={item.key} className="ww-three-dot-sep" role="separator" />;
            }

            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={`ww-three-dot-item ${item.danger ? 'danger' : ''} ${item.active ? 'active' : ''}`}
                disabled={item.disabled}
                onClick={() => handleItemClick(item)}
              >
                <span className="ww-three-dot-item-left">
                  {item.icon && <span className="ww-three-dot-icon-wrap">{item.icon}</span>}
                  <span>{item.label}</span>
                </span>
                {item.hint && <span className="ww-three-dot-hint">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ThreeDotMenu;