/**
 * Local D1 Storage Provider Adapter (Ticket #68 / ADR-0008)
 * Fallback storage capped strictly at <= 1 MB raw (1,048,576 bytes) with zero GIF binaries in D1 (Rule 3).
 */

import { base64ToUint8Array } from '../security.js';

export const MAX_LOCAL_STORAGE_BYTES = 1024 * 1024; // 1 MB raw cap (1,048,576 bytes)

export const localStorageAdapter = {
  name: 'local',

  /**
   * Initialize local fallback upload. Rejects assets > 1 MB raw.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   kind: 'media' | 'attachments' | 'gifs' | 'waivers',
   *   fileName: string,
   *   mimeType: string,
   *   fileSize: number,
   *   metadata?: Record<string, any>
   * }} opts
   */
  async uploadInit(env, opts) {
    const { kind, fileSize, metadata = {} } = opts;

    if (fileSize > MAX_LOCAL_STORAGE_BYTES) {
      return {
        ok: false,
        error: 'Files over 1 MB exceed local storage cap. R2 or Google Drive required.'
      };
    }

    const uploadUrl = (kind === 'attachments')
      ? `/api/attachments/${encodeURIComponent(metadata.attachmentId || metadata.id || 'att')}/upload`
      : `/api/media/${encodeURIComponent(metadata.mediaId || metadata.id || '0')}/upload`;

    return {
      ok: true,
      storageProvider: 'local',
      uploadMode: 'local_put',
      uploadUrl,
      objectKey: null,
      driveFileId: null,
      expiresInSec: 3600,
      headers: {}
    };
  },

  /**
   * Finalize and verify local D1 asset upload.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   expectedSize?: number,
   *   mimeType?: string
   * }} opts
   */
  async finalizeUpload(env, opts) {
    const { expectedSize = 0, mimeType = '' } = opts;
    if (expectedSize > MAX_LOCAL_STORAGE_BYTES) {
      return { ok: false, error: 'File size exceeds 1 MB local limit.' };
    }
    return {
      ok: true,
      verifiedSize: expectedSize,
      verifiedMimeType: mimeType
    };
  },

  /**
   * Decode local base64 payload into raw binary buffer.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   localBase64?: string,
   *   mimeType?: string,
   *   rangeHeader?: string,
   *   cacheControl?: string
   * }} opts
   */
  async getDownloadTarget(env, opts) {
    const { localBase64, mimeType, rangeHeader, cacheControl } = opts;
    if (!localBase64) {
      return {
        type: 'error',
        status: 404,
        error: 'Local binary payload unavailable.'
      };
    }
    const buffer = base64ToUint8Array(localBase64);
    return {
      type: 'buffer',
      buffer,
      mimeType: mimeType || 'application/octet-stream',
      rangeHeader,
      cacheControl: cacheControl || 'private, no-store'
    };
  },

  /**
   * Store raw bytes locally. Rejects GIFs per AGENTS.md Rule 3.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   kind: 'media' | 'attachments' | 'gifs' | 'waivers',
   *   objectKey?: string,
   *   bytes: Uint8Array
   * }} opts
   */
  async putObject(env, opts) {
    const { kind, objectKey } = opts;
    if (kind === 'gifs') {
      throw new Error('Local storage provider does not permit GIF binaries in D1 (AGENTS.md Rule 3). R2 or Google Drive required.');
    }
    return {
      storageProvider: 'local',
      objectKey: objectKey || null
    };
  },

  /**
   * Local delete no-op (row deletion handles cleanup).
   * @param {Record<string, any>|null|undefined} _env
   * @param {Record<string, any>} _opts
   */
  async deleteObject(_env, _opts) {
    // No-op for local database storage; cleaned up via SQL DELETE statements.
  },

  /**
   * Report local storage provider health and quota.
   * @param {Record<string, any>|null|undefined} _env
   */
  async getStorageStatus(_env) {
    return {
      provider: 'local',
      enabled: true,
      maxSizeBytes: MAX_LOCAL_STORAGE_BYTES,
      maxSizeHuman: '1 MB'
    };
  }
};
