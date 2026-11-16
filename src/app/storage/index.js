/**
 * Unified STORAGE_PROVIDER Factory & Adapter Interface (Ticket #68 / ADR-0008)
 * Standardizes storage across Cloudflare R2 ('r2'), Google Drive v3 ('gdrive'), and Local D1 ('local').
 */

import { isGDriveConfigured } from '../gdrive.js';
import { r2StorageAdapter } from './r2.js';
import { gdriveStorageAdapter } from './gdrive.js';
import { localStorageAdapter } from './local.js';

export { r2StorageAdapter } from './r2.js';
export { gdriveStorageAdapter } from './gdrive.js';
export { localStorageAdapter } from './local.js';

/**
 * Determine active storage provider ('r2' | 'gdrive' | 'local').
 * Explicit env.STORAGE_PROVIDER takes precedence; otherwise auto-detects based on available bindings/credentials.
 * @param {Record<string, any>|null|undefined} env
 * @returns {'r2' | 'gdrive' | 'local'}
 */
export function resolveStorageProvider(env) {
  if (env && env.STORAGE_PROVIDER) {
    const p = String(env.STORAGE_PROVIDER).toLowerCase().trim();
    if (p === 'r2' || p === 'gdrive' || p === 'local') {
      return p;
    }
  }
  if (env && (env.MEDIA_BUCKET || env.R2_BUCKET || env.R2_ACCOUNT_ID)) {
    return 'r2';
  }
  if (isGDriveConfigured(env) || (env && (env.GOOGLE_DRIVE_FOLDER_ID || env.GDRIVE_FOLDER_ID))) {
    return 'gdrive';
  }
  return 'local';
}

/**
 * Get the storage adapter instance for the resolved provider.
 * @param {Record<string, any>|null|undefined} env
 * @returns {typeof r2StorageAdapter | typeof gdriveStorageAdapter | typeof localStorageAdapter}
 */
export function getStorageAdapter(env) {
  const provider = resolveStorageProvider(env);
  switch (provider) {
    case 'r2':
      return r2StorageAdapter;
    case 'gdrive':
      return gdriveStorageAdapter;
    case 'local':
    default:
      return localStorageAdapter;
  }
}

/**
 * Compute canonical object key per ADR-0008:
 * - media: media/<mediaId>/<uuid>
 * - attachments: attachments/<channelId>/<attachmentId>
 * - gifs: gifs/<gifId>.<ext>
 * - waivers: waivers/<certificateId>.html
 * @param {'media' | 'attachments' | 'gifs' | 'waivers'} kind
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
export function canonicalObjectKey(kind, params = {}) {
  switch (kind) {
    case 'attachments': {
      const channelId = params.channelId || params.channel_id || '0';
      const attachmentId = params.attachmentId || params.attachment_id || params.id || 'att';
      return `attachments/${channelId}/${attachmentId}`;
    }
    case 'media': {
      const mediaId = params.mediaId || params.media_id || params.id || '0';
      const uuid = params.uuid || params.fileUuid || params.file_uuid || params.token || 'raw';
      return `media/${mediaId}/${uuid}`;
    }
    case 'gifs': {
      const gifId = params.gifId || params.gif_id || params.id || 'gif';
      const ext = params.ext || (params.mimeType === 'image/webp' ? 'webp' : 'gif');
      return `gifs/${gifId}.${ext}`;
    }
    case 'waivers': {
      const certId = params.certificateId || params.certificate_id || params.id || 'cert';
      return `waivers/${certId}.html`;
    }
    default:
      return `misc/${params.id || 'item'}`;
  }
}
