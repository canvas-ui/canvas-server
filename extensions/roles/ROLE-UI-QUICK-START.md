# Role Manager UI - Quick Start Guide

## What Was Built

Replaced the placeholder "Coming Soon" pages with a full-featured Role Manager UI.

### Files Created/Modified

**New Files:**
- `src/ui/web/src/services/role.ts` - Complete role API service
- `UI-IMPLEMENTATION-SUMMARY.md` - Detailed documentation

**Modified Files:**
- `src/ui/web/src/config/api.ts` - Added role API routes
- `src/ui/web/src/pages/admin/roles/index.tsx` - Admin role management UI
- `src/ui/web/src/pages/roles/index.tsx` - User role management UI

## Quick Test

### 1. Start the Backend

```bash
# Make sure Canvas server is running
npm start
```

### 2. Start the Web UI

```bash
cd src/ui/web
npm install  # if not done already
npm run dev
```

### 3. Access the UI

**Admin View:**
```
http://localhost:5173/admin/roles
```
- Create, start, stop, restart, delete roles
- View all global and workspace roles
- Access logs and monitoring

**User View:**
```
http://localhost:5173/roles
```
- View your workspace roles
- Start/stop/restart your roles
- Access your role logs

## Features at a Glance

### Admin Page
✅ Full CRUD operations
✅ Role lifecycle management
✅ Template selection
✅ Filtering and search
✅ Logs viewer
✅ Status indicators

### User Page
✅ Card-based role display
✅ Simple lifecycle controls
✅ Logs access
✅ Auto-refresh every 30s
✅ Clean, focused interface

## Usage Examples

### Create a New Role (Admin)

1. Navigate to `/admin/roles`
2. Click "Create Role"
3. Select template: `docker.canvas-sshd`
4. Enter name: `canvas-sshd`
5. Select type: `Global`
6. Click "Create Role"
7. Click ▶ (Play) to start

### Manage Your Roles (User)

1. Navigate to `/roles`
2. See your workspace roles as cards
3. Click "Start" to start a role
4. Click "Stop" to stop a running role
5. Click 📄 (Logs) to view logs

## API Integration

The UI connects to these backend endpoints:

```
GET    /rest/v2/roles
POST   /rest/v2/roles
GET    /rest/v2/roles/:id
POST   /rest/v2/roles/:id/start
POST   /rest/v2/roles/:id/stop
POST   /rest/v2/roles/:id/restart
DELETE /rest/v2/roles/:id
GET    /rest/v2/roles/:id/logs
GET    /rest/v2/role-templates
```

Make sure these are exposed in your routes!

## Customization

### Change Colors

Edit the status badge colors in:
```typescript
// pages/admin/roles/index.tsx
const variants = {
  running: { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50', label: 'Running' },
  // ... customize here
}
```

### Add More Actions

Add custom buttons in the actions column:
```typescript
<Button
  size="sm"
  variant="outline"
  onClick={() => handleCustomAction(role)}
>
  <YourIcon className="w-4 h-4" />
</Button>
```

### Modify Auto-Refresh

Change the refresh interval:
```typescript
// pages/roles/index.tsx
const interval = setInterval(fetchRoles, 30000) // Change 30000 to your desired ms
```

## Troubleshooting

### "Failed to fetch roles"

**Check:**
1. Backend is running
2. API URL is correct in `.env`
3. You're authenticated
4. CORS is configured

### "Access denied"

**For admin page:**
- Make sure your user has `userType: 'admin'`
- Check token in localStorage

### Status not updating

**Solution:**
- Click the Refresh button
- Check browser console for errors
- Verify WebSocket connection (future feature)

### Logs not showing

**Check:**
1. Role is running
2. Container exists
3. Backend can access Docker
4. Permissions are correct

## Next Steps

1. ✅ UI is complete and functional
2. ⏭️ Test with real roles (canvas-sshd, etc.)
3. ⏭️ Add WebSocket for real-time updates
4. ⏭️ Implement resource monitoring graphs
5. ⏭️ Add role configuration editor

## Documentation

- **Full Details**: See `UI-IMPLEMENTATION-SUMMARY.md`
- **Backend Setup**: See `CANVAS-ROLES-SETUP.md`
- **Implementation**: See `IMPLEMENTATION-SUMMARY.md`

Ready to use! 🚀
