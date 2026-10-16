# Backups & export

## Layers
| Layer | Who | What | Status |
|---|---|---|---|
| Database PITR | COS operator | Neon/Supabase point‑in‑time recovery for the whole platform | Configure in your provider |
| On‑demand export | Retailer admin | `/api/export` (full JSON) and `/api/export?format=csv` (orders) | Built |
| COS Cloud nightly | All paid plans | Per‑organisation JSON snapshot written to private object storage at `backups/{orgId}/…` | Built (`runDailyJobs`) |
| Google Drive export | Pro | Nightly snapshot uploaded to the retailer's Drive folder | Adapter built; OAuth connect flow to do |
| Dropbox export | Pro | Nightly snapshot uploaded to the retailer's Dropbox | Adapter built; OAuth connect flow to do |

## Snapshot format
`{ format: "cos-export", version: 1, exportedAt, organisation, users (no password hashes), customers, quotes, orders, payments, messages, attachments (metadata), auditEvents }`. Attachments' binary files stay in object storage under `orgs/{orgId}/…`.

Every export and backup is itself recorded on the ledger (`data_exported`, `backup_completed`, `backup_failed`), and runs are listed in **Store settings → Backups & export**.

## Adding the Drive and Dropbox connection
`src/lib/services/backups.ts` defines a `BackupTarget` interface (`upload(filename, body)`). `GoogleDriveTarget` (multipart upload to Drive v3) and `DropboxTarget` (`/2/files/upload`) are implemented. What's left:
1. OAuth routes such as `/api/backups/{provider}/connect` and `/callback`. Use the `GOOGLE_DRIVE_CLIENT_*` and `DROPBOX_APP_*` env vars and request offline access: Drive scope `drive.file`, Dropbox `files.content.write`.
2. Store the refresh token encrypted with `encryptSecret()` (AES‑256‑GCM keyed from `AUTH_SECRET`) in `backup_destinations.credentials_encrypted`, with `status = 'active'`.
3. Before uploading, exchange the refresh token for an access token. That is the `targetFor()` step.
4. In `runDailyJobs`, iterate active destinations where `hasFeature(org, 'backup.<provider>')`.
