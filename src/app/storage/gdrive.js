/**
 * Google Drive v3 Storage Provider Adapter (Ticket #68 / ADR-0008)
 * Wraps OAuth2 Google Drive resumable uploads, metadata verification, and chunked streaming.
 */

import {
  isGDriveConfigured,
  initGDriveResumableSession,
  getGDriveFileMetadata,
  uploadGDriveBytes,
  streamGDriveFile,
  deleteGDriveFile,
  getGDriveStorageQuota
} from '../gdrive.js';

export const MAX_GDRIVE_BYTES = 500 * 1024 * 1024; // 500 MB max per Google Drive asset

export const gdriveStorageAdapter = {
  name: 'gdrive',

  /**
   * Initialize a Drive v3 resumable upload session.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   kind: 'media' | 'attachments' | 'gifs' | 'waivers',
   *   fileName: string,
   *   mimeType: string,
   *   fileSize: number,
   *   origin?: string,
   *   metadata?: Record<string, any>
   * }} opts
   */
  async uploadInit(env, opts) {
    const { fileName, mimeType, fileSize, origin, metadata = {} } = opts;

    if (fileSize > MAX_GDRIVE_BYTES) {
      return { ok: false, error: 'File size exceeds Google Drive 500 MB limit.' };
    }

    if (!isGDriveConfigured(env)) {
      return { ok: false, error: 'Google Drive storage is not configured or unavailable.' };
    }

    const { sessionUri, driveFileId } = await initGDriveResumableSession(env, {
      fileName,
      mimeType,
      fileSize,
      origin: origin || '',
      appProperties: metadata
    });

    return {
      ok: true,
      storageProvider: 'gdrive',
      uploadMode: 'gdrive_resumable',
      uploadUrl: sessionUri,
      driveFileId,
      objectKey: null,
      expiresInSec: 86400,
      headers: {}
    };
  },

  /**
   * Finalize and verify Drive file metadata.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   driveFileId: string,
   *   expectedSize?: number,
   *   mimeType?: string
   * }} opts
   */
  async finalizeUpload(env, opts) {
    const { driveFileId, expectedSize = 0, mimeType = '' } = opts;
    if (!driveFileId) {
      return { ok: false, error: 'driveFileId is required for Google Drive upload finalization.' };
    }

    const meta = await getGDriveFileMetadata(env, driveFileId);
    if (!meta) {
      return { ok: false, error: 'Google Drive file metadata could not be verified.' };
    }

    const verifiedSize = Number(meta.size || expectedSize);
    if (verifiedSize > MAX_GDRIVE_BYTES) {
      return { ok: false, error: 'File size exceeds Google Drive 500 MB limit.' };
    }

    return {
      ok: true,
      verifiedSize,
      verifiedMimeType: meta.mimeType || mimeType,
      driveFileId
    };
  },

  /**
   * Stream file from Google Drive.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   driveFileId: string,
   *   mimeType?: string,
   *   rangeHeader?: string,
   *   reqUrl?: string,
   *   isPublic?: boolean,
   *   cacheControl?: string
   * }} opts
   */
  async getDownloadTarget(env, opts) {
    const { driveFileId, mimeType, rangeHeader, reqUrl, isPublic, cacheControl } = opts;
    const response = await streamGDriveFile(
      env,
      driveFileId,
      rangeHeader,
      mimeType || 'application/octet-stream',
      isPublic ? reqUrl : null,
      { useEdgeCache: Boolean(isPublic), cacheControl }
    );
    return {
      type: 'stream',
      response
    };
  },

  /**
   * Direct upload raw bytes (small asset: GIF, waiver).
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   fileName: string,
   *   mimeType: string,
   *   bytes: Uint8Array
   * }} opts
   */
  async putObject(env, opts) {
    const { fileName, mimeType, bytes } = opts;
    const driveFileId = await uploadGDriveBytes(env, {
      fileName,
      mimeType,
      bytes
    });
    return {
      storageProvider: 'gdrive',
      driveFileId
    };
  },

  /**
   * Best-effort Drive file deletion.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   driveFileId?: string
   * }} opts
   */
  async deleteObject(env, opts) {
    const { driveFileId } = opts;
    if (driveFileId) {
      await deleteGDriveFile(env, driveFileId);
    }
  },

  /**
   * Report Google Drive storage quota and health.
   * @param {Record<string, any>|null|undefined} env
   */
  async getStorageStatus(env) {
    return await getGDriveStorageQuota(env);
  }
};
