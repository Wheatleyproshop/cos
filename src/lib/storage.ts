import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { get as blobGet, put as blobPut } from '@vercel/blob';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Object storage for attachments and backups.
 * - local: development only (./.data/uploads). Serverless hosts have no persistent disk.
 * - vercel-blob: Vercel Blob, private access (default on Vercel when BLOB_READ_WRITE_TOKEN is set).
 * - s3:    any S3-compatible bucket (AWS S3, Cloudflare R2, Supabase Storage).
 * Objects are always private; the app streams them after an authorisation check.
 */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

class LocalStorage implements Storage {
  constructor(private root: string) {}
  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return full;
  }
  async put(key: string, body: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  async get(key: string) {
    return readFile(this.resolve(key));
  }
}

class S3Storage implements Storage {
  private client: S3Client;
  constructor(private bucket: string) {
    this.client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(process.env.S3_ENDPOINT),
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      },
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
}

class VercelBlobStorage implements Storage {
  async put(key: string, body: Buffer, contentType: string) {
    await blobPut(key, body, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: false });
  }
  async get(key: string) {
    const res = await blobGet(key, { access: 'private' });
    if (!res || !res.stream) throw new Error('File not found in storage');
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  }
}

let instance: Storage | null = null;

export function storage(): Storage {
  if (instance) return instance;
  const driver = process.env.STORAGE_DRIVER || (process.env.BLOB_READ_WRITE_TOKEN ? 'vercel-blob' : 'local');
  if (driver === 'vercel-blob') {
    instance = new VercelBlobStorage();
  } else if (driver === 's3') {
    if (!process.env.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is required when STORAGE_DRIVER=s3');
    instance = new S3Storage(process.env.STORAGE_BUCKET);
  } else {
    if (process.env.VERCEL) throw new Error('No file storage configured: connect a Vercel Blob store to this project.');
    instance = new LocalStorage(path.join(process.cwd(), '.data', 'uploads'));
  }
  return instance;
}

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // stays under Vercel's 4.5 MB request limit

export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/gif': 'gif',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};
