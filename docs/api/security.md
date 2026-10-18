# Sign-in security and media uploads API

Trusted devices (docs/admin.md §4.1) and the media upload protocol. All routes are under `/api/admin`, JSON in and
out, behind the admin guard; writes re-read the actor's role from D1.

## Trusted devices

"Trust this device for N days" on the sign-in page's TOTP step sends `trustDevice: true` to Better Auth's
`/api/auth/two-factor/verify-totp` (or `verify-backup-code`). Better Auth stores a `trust-device-<random>` row in
`verification` (value = user id) and sets the signed, httpOnly `trust_device` cookie. `src/server/auth/passwordless-2fa.ts`
checks it on email-code and magic-link sign-ins; `src/server/auth/trusted-devices.ts` reads, counts and revokes.

- The challenge response is `{ twoFactorRedirect: true, twoFactorMethods: ['totp'], trustDeviceDays }` (the magic
  link redirects to `/admin/sign-in?step=totp&trust=<days>`), so the page knows whether to offer the tick box.
- N is Settings → `security.trustDeviceDays` (owners only; 0–90, default 30, 0 = off), counted from when the code
  was entered. Lowering it applies to devices already trusted.

### `GET /api/admin/me/trusted-devices` (editor+)

```jsonc
{ "days": 30, "count": 2 } // the trust period, and how many of your devices skip the code now
```

### `DELETE /api/admin/me/trusted-devices` (editor+)

Forgets all your trusted devices. `{ "revoked": 2 }`. Audited as `auth.devices_revoke` (`after.reason: "manual"`).

### `DELETE /api/admin/users/:id/trusted-devices` (admin+)

The same for someone whose account you could remove (below your role; owners manage everyone). 403 otherwise.

Automatic revokes, each audited as `auth.devices_revoke` with a reason when there was anything to forget: TOTP set up
again (`totp.enable`) or turned off (`totp.disable`); a role change or removal (in the same batch as the change).
A newly trusted device is audited as `auth.device_trust` (`after.days`).

## Media uploads

1. `PUT /api/admin/media/<uuid>/original.<ext>`: the original.
2. `PUT /api/admin/media/<uuid>/<width>.webp`, or `<width>.jpg` from browsers whose canvas can't encode WebP: each
   resized copy.
3. `POST /api/admin/media { id, filename, mime, bytes, width, height, variants, variantExt: "webp" | "jpg", alt }`:
   checks every file is in R2, then records the row (`media.variant_ext`; missing = `webp`).

Every uploaded file carries R2 `customMetadata.source = "admin-upload"`. The hourly cron deletes such files that are
over 24 hours old and have no media row (an abandoned upload), one page of 400 keys per run, resuming where it
stopped (`site_settings` key `cron.media_sweep`). Files without the marker (the importer's) are never touched.
