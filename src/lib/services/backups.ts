import { and, eq, getTableColumns } from 'drizzle-orm';
import { withTenant, type DB } from '@/db';
import {
  attachments,
  auditEvents,
  backupDestinations,
  backupRuns,
  customers,
  messages,
  orders,
  organisations,
  payments,
  quotes,
  users,
  type BackupProvider,
  type Organisation,
} from '@/db/schema';
import { recordEvent, type Actor } from '../audit';
import { hasFeature } from '../plans';
import { storage } from '../storage';
import { decryptSecret } from '../tokens';
import { ServiceError } from './common';

export const EXPORT_VERSION = 1;

/** Full, portable snapshot of one organisation's data (no secrets). */
export async function buildExport(tx: DB, orgId: string) {
  const { passwordHash, failedLoginCount, lockedUntil, ...safeUserCols } = getTableColumns(users);
  void passwordHash; void failedLoginCount; void lockedUntil;
  const [org] = await tx.select().from(organisations).where(eq(organisations.id, orgId));
  return {
    format: 'cos-export',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    organisation: org,
    users: await tx.select(safeUserCols).from(users),
    customers: await tx.select().from(customers),
    quotes: await tx.select().from(quotes),
    orders: await tx.select().from(orders),
    payments: await tx.select().from(payments),
    messages: await tx.select().from(messages),
    attachments: await tx.select().from(attachments), // metadata; files live in object storage
    auditEvents: await tx.select().from(auditEvents),
  };
}

/** Destinations implement one method, so adding OneDrive/S3-per-tenant later is local to this file. */
interface BackupTarget {
  upload(filename: string, body: Buffer): Promise<string>;
}

class CosHostedTarget implements BackupTarget {
  constructor(private orgId: string) {}
  async upload(filename: string, body: Buffer) {
    const key = `backups/${this.orgId}/${filename}`;
    await storage().put(key, body, 'application/json');
    return key;
  }
}

class DropboxTarget implements BackupTarget {
  constructor(private accessToken: string, private folder: string) {}
  async upload(filename: string, body: Buffer) {
    const path = `${this.folder.replace(/\/$/, '')}/${filename}`;
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true }),
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`Dropbox upload failed (${res.status})`);
    return path;
  }
}

class GoogleDriveTarget implements BackupTarget {
  constructor(private accessToken: string, private folderId?: string) {}
  async upload(filename: string, body: Buffer) {
    const boundary = 'cos' + Date.now();
    const meta = JSON.stringify({ name: filename, ...(this.folderId ? { parents: [this.folderId] } : {}) });
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(payload),
    });
    if (!res.ok) throw new Error(`Google Drive upload failed (${res.status})`);
    return ((await res.json()) as { id: string }).id;
  }
}

async function targetFor(tx: DB, org: Organisation, provider: BackupProvider): Promise<BackupTarget> {
  if (!hasFeature(org, `backup.${provider}`)) throw new ServiceError('Your plan does not include this backup destination.');
  if (provider === 'cos_hosted') return new CosHostedTarget(org.id);
  const [dest] = await tx
    .select()
    .from(backupDestinations)
    .where(and(eq(backupDestinations.provider, provider), eq(backupDestinations.status, 'active')))
    .limit(1);
  if (!dest?.credentialsEncrypted) throw new ServiceError('Connect this destination in Store settings first.');
  // Credentials hold a short-lived access token refreshed by the OAuth integration (see docs/BACKUPS.md).
  const creds = JSON.parse(decryptSecret(dest.credentialsEncrypted)) as { accessToken: string };
  const cfg = dest.config as { folder?: string; folderId?: string };
  return provider === 'dropbox'
    ? new DropboxTarget(creds.accessToken, cfg.folder ?? '/COS Backups')
    : new GoogleDriveTarget(creds.accessToken, cfg.folderId);
}

export async function runBackup(org: Organisation, provider: BackupProvider, actor: Actor, userId: string | null) {
  const [run] = await withTenant(org.id, (tx) =>
    tx.insert(backupRuns).values({ organisationId: org.id, provider, triggeredByUserId: userId }).returning(),
  );
  try {
    const { body, location } = await withTenant(org.id, async (tx) => {
      const target = await targetFor(tx, org, provider);
      const body = Buffer.from(JSON.stringify(await buildExport(tx, org.id)));
      const filename = `${org.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      return { body, location: await target.upload(filename, body) };
    });
    await withTenant(org.id, async (tx) => {
      await tx
        .update(backupRuns)
        .set({ status: 'succeeded', storageKey: location, sizeBytes: body.length, finishedAt: new Date() })
        .where(eq(backupRuns.id, run.id));
      await recordEvent(tx, {
        organisationId: org.id, actor, eventType: 'backup_completed', entityType: 'backup', entityId: run.id,
        metadata: { provider, sizeBytes: body.length },
      });
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await withTenant(org.id, async (tx) => {
      await tx.update(backupRuns).set({ status: 'failed', error, finishedAt: new Date() }).where(eq(backupRuns.id, run.id));
      await recordEvent(tx, {
        organisationId: org.id, actor, eventType: 'backup_failed', entityType: 'backup', entityId: run.id,
        metadata: { provider, error },
      });
    });
    throw e instanceof ServiceError ? e : new ServiceError(`Backup failed: ${error}`);
  }
}
