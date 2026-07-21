# TODO: Wire Up Message Reactions & Editing

## Status: ✅ COMPLETE

All requested features are already implemented end-to-end in the codebase:

### ✅ 1. `socket.on('message-reaction', ...)` Listener
- **Status**: ✅ Present in ChatApp.jsx
- Updates the matching message's `reactions` array in state when a reaction event arrives from the server

### ✅ 2. Emoji-Reaction Picker
- **Status**: ✅ Present in ChatApp.jsx
- Opens from the per-message menu (ww-msg-menu) via "React" button
- Reuses the existing EMOJIS list (first 18 emojis shown)
- Calls `reactToMessage()` which POSTs to `/api/messages/:id/react` or `/api/groups/:groupId/messages/:id/react`

### ✅ 3. Reaction Pills Under Message Bubbles
- **Status**: ✅ Present in ChatApp.jsx
- Renders `.ww-reactions` div showing grouped emoji + count
- Clicking a reaction pill toggles that reaction
- Highlighted (`.mine` class) if the current user reacted with that emoji

### ✅ 4. Edit Option in Per-Message Menu
- **Status**: ✅ Present in ChatApp.jsx (line within ww-msg-menu)
- Shown only for `item.type === 'text' && mine` (the menu item already checks this)
- No 15-minute check here — the server enforces it and returns an error message if expired

### ✅ 5. Inline Editing UI
- **Status**: ✅ Present in ChatApp.jsx
- When `editingMessageId === item.id`, the bubble renders a `<form>` with an input field and Save/Cancel buttons
- `editInputRef` auto-focuses via `setTimeout(() => editInputRef.current?.focus(), 50)` in `startEditMessage`
- On save, calls `submitEditMessage()` which PATCHes `/api/messages/:id` or `/api/groups/:groupId/messages/:id`

### ✅ 6. `socket.on('message-edited', ...)` Listener + "edited" Label
- **Status**: ✅ Present
- Listener updates `msg` and `editedAt` on the matching message
- In the meta section: `{item.editedAt && <span className="ww-edited-label">edited</span>}` shows next to the timestamp
