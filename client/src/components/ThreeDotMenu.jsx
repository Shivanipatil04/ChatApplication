import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, Users, Archive, Star, CheckSquare, CheckCheck, Lock, Sun, Moon, Settings, Shield, Bell, LogOut } from 'lucide-react';
import './ThreeDotMenu.css';

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
  align = 'right',
}) => {
  const [open, setOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState({});
  const buttonRef = useRef(null);
  const popupRef = useRef(null);

  const close = () => setOpen(false);

  // Calculate popup position from button's bounding rect every time it opens
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const POPUP_WIDTH = 260;
    let left = align === 'left' ? rect.left : rect.right - POPUP_WIDTH;
    // Clamp so it never goes off the left edge
    if (left < 8) left = 8;
    // Clamp so it never goes off the right edge
    if (left + POPUP_WIDTH > window.innerWidth - 8) left = window.innerWidth - POPUP_WIDTH - 8;
    setPopupStyle({
      position: 'fixed',
      top: rect.bottom + 6,
      left,
      width: POPUP_WIDTH,
    });
  }, [open, align]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (buttonRef.current?.contains(e.target)) return;
      if (popupRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const menuItems = useMemo(() => [
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
  ], [onNewGroup, onArchivedChats, onStarredMessages, onSelectChats, onMarkAllRead,
      onAppLock, isAppLockEnabled, onToggleTheme, isDarkMode, onLogout, onSettings]);

  const handleItemClick = async (item) => {
    if (item.disabled) return;
    try { await item.onSelect?.(); } finally { close(); }
  };

  const popup = open ? (
    <div
      ref={popupRef}
      className="ww-three-dot-popup"
      role="menu"
      style={popupStyle}
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
            className={`ww-three-dot-item${item.danger ? ' danger' : ''}${item.active ? ' active' : ''}`}
            disabled={item.disabled}
            onClick={() => handleItemClick(item)}
          >
            <span className="ww-tdm-left">
              <span className="ww-tdm-icon">{item.icon}</span>
              <span className="ww-tdm-label">{item.label}</span>
            </span>
            {item.hint && <span className="ww-tdm-hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div className="ww-three-dot-menu">
      <button
        ref={buttonRef}
        type="button"
        className="ww-three-dot-button"
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <MoreVertical size={20} />
      </button>
      {createPortal(popup, document.body)}
    </div>
  );
};

export default ThreeDotMenu;
