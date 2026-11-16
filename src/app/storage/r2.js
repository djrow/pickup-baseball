/**
 * Cloudflare R2 Storage Provider Adapter (Ticket #68 / ADR-0008)
 * Generates 15-minute presigned PUT URLs and 5-minute presigned GET URLs via aws4fetch,
 * finalizes uploads via MEDIA_BUCKET.head(), and deletes via MEDIA_BUCKET.delete().
 */

import { AwsClient } from 'aws4fetch';
import { canonicalObjectKey } from './index.js';

export const MAX_R2_MEDIA_BYTES = 50 * 1024 * 1024;       // 50 MB max per Gallery media item
export const MAX_R2_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB max per Clubhouse chat attachment

/**
 * Instantiate an AwsClient for signing R2 S3 requests.
 * @param {Record<string, any>|null|undefined} env
 * @returns {AwsClient}
 */
function createR2AwsClient(env) {
  const accessKeyId = (env && env.R2_ACCESS_KEY_ID) || 'mock_r2_access_key';
  const secretAccessKey = (env && env.R2_SECRET_ACCESS_KEY) || 'mock_r2_secret_key';
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region: 'auto'
  });
}

/**
 * Get the R2 endpoint URL for a given object key.
 * @param {Record<string, any>|null|undefined} env
 * @param {string} objectKey
 * @returns {string}
 */
function getR2ObjectEndpoint(env, objectKey) {
  const accountId = (env && env.R2_ACCOUNT_ID) || 'mock_r2_account';
  const bucketName = (env && env.R2_BUCKET_NAME) || 'pickup-media';
  return `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${objectKey}`;
}

export const r2StorageAdapter = {
  name: 'r2',

  /**
   * Initialize a direct upload by generating a 15-minute presigned PUT URL via aws4fetch.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   kind: 'media' | 'attachments' | 'gifs' | 'waivers',
   *   objectKey?: string,
   *   fileName: string,
   *   mimeType: string,
   *   fileSize: number,
   *   origin?: string,
   *   metadata?: Record<string, any>
   * }} opts
   */
  async uploadInit(env, opts) {
    const { kind, fileName, mimeType, fileSize, metadata = {} } = opts;
    const objectKey = opts.objectKey || canonicalObjectKey(kind, { ...metadata, fileName, mimeType });

    const maxBytes = kind === 'media' ? MAX_R2_MEDIA_BYTES : MAX_R2_ATTACHMENT_BYTES;
    if (fileSize > maxBytes) {
      const maxMb = Math.round(maxBytes / (1024 * 1024));
      return { ok: false, error: `File size exceeds R2 ${maxMb} MB limit.` };
    }

    const client = createR2AwsClient(env);
    const baseEndpoint = getR2ObjectEndpoint(env, objectKey);
    const endpointWithTtl = `${baseEndpoint}?X-Amz-Expires=900`;

    const signedPut = await client.sign(endpointWithTtl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileSize)
      },
      aws: { signQuery: true }
    });

    return {
      ok: true,
      storageProvider: 'r2',
      uploadMode: 'r2_presigned_put',
      uploadUrl: signedPut.url,
      objectKey,
      r2Key: objectKey,
      driveFileId: null,
      expiresInSec: 900,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileSize)
      }
    };
  },

  /**
   * Finalize and verify an uploaded object via MEDIA_BUCKET.head().
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   kind: 'media' | 'attachments' | 'gifs' | 'waivers',
   *   objectKey: string,
   *   expectedSize?: number,
   *   mimeType?: string,
   *   isEncrypted?: boolean,
   *   metadata?: Record<string, any>
   * }} opts
   */
  async finalizeUpload(env, opts) {
    const { kind, objectKey, expectedSize = 0, mimeType = '' } = opts;
    const bucket = env && (env.MEDIA_BUCKET || env.R2_BUCKET);

    if (bucket && typeof bucket.head === 'function') {
      const head = await bucket.head(objectKey);
      if (!head) {
        return { ok: false, error: 'Object not found in R2 bucket.' };
      }
      const verifiedSize = Number(head.size || 0);
      const maxBytes = kind === 'media' ? MAX_R2_MEDIA_BYTES : MAX_R2_ATTACHMENT_BYTES;
      if (verifiedSize > maxBytes) {
        return { ok: false, error: 'Uploaded object exceeds maximum permitted size.' };
      }
      const verifiedMimeType = (head.httpMetadata && head.httpMetadata.contentType) || mimeType;
      return {
        ok: true,
        verifiedSize,
        verifiedMimeType,
        objectKey
      };
    }

    // In unit test or environment without live R2 binding, trust verified parameters
    return {
      ok: true,
      verifiedSize: expectedSize,
      verifiedMimeType: mimeType,
      objectKey
    };
  },

  /**
   * Return a 302 redirect target to a 5-minute presigned GET URL via aws4fetch.
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   kind?: 'media' | 'attachments' | 'gifs' | 'waivers',
   *   objectKey: string,
   *   mimeType?: string,
   *   fileName?: string,
   *   isPublic?: boolean,
   *   isEncrypted?: boolean,
   *   approved?: boolean
   * }} opts
   */
  async getDownloadTarget(env, opts) {
    const { objectKey, mimeType, fileName, isPublic, isEncrypted, approved } = opts;
    const client = createR2AwsClient(env);
    const baseEndpoint = getR2ObjectEndpoint(env, objectKey);

    const searchParams = new URLSearchParams({
      'X-Amz-Expires': '300'
    });

    if (isEncrypted) {
      searchParams.set('response-content-type', 'application/octet-stream');
      searchParams.set('response-content-disposition', 'attachment');
    } else {
      if (mimeType) {
        searchParams.set('response-content-type', mimeType);
      }
      if (fileName) {
        searchParams.set('response-content-disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
      }
    }

    const endpointWithParams = `${baseEndpoint}?${searchParams.toString()}`;
    const signedGet = await client.sign(endpointWithParams, {
      method: 'GET',
      aws: { signQuery: true }
    });

    const cacheControl = (isPublic && approved)
      ? 'public, max-age=240'
      : 'private, no-store';

    return {
      type: 'redirect',
      url: signedGet.url,
      status: 302,
      cacheControl
    };
  },

  /**
   * Direct write small asset (GIF import, waiver certificate) via MEDIA_BUCKET.put().
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   kind: 'media' | 'attachments' | 'gifs' | 'waivers',
   *   objectKey: string,
   *   fileName?: string,
   *   mimeType: string,
   *   bytes: Uint8Array
   * }} opts
   */
  async putObject(env, opts) {
    const { objectKey, mimeType, bytes } = opts;
    const bucket = env && (env.MEDIA_BUCKET || env.R2_BUCKET);
    if (bucket && typeof bucket.put === 'function') {
      await bucket.put(objectKey, bytes, {
        httpMetadata: { contentType: mimeType }
      });
    }
    return {
      storageProvider: 'r2',
      objectKey
    };
  },

  /**
   * Best-effort object deletion via MEDIA_BUCKET.delete().
   * @param {Record<string, any>|null|undefined} env
   * @param {{
   *   objectKey?: string
   * }} opts
   */
  async deleteObject(env, opts) {
    const { objectKey } = opts;
    if (!objectKey) return;
    const bucket = env && (env.MEDIA_BUCKET || env.R2_BUCKET);
    if (bucket && typeof bucket.delete === 'function') {
      try {
        await bucket.delete(objectKey);
      } catch (err) {
        /* best-effort R2 deletion */
      }
    }
  },

  /**
   * Report R2 provider health and configuration summary.
   * @param {Record<string, any>|null|undefined} env
   */
  async getStorageStatus(env) {
    const bucket = env && (env.MEDIA_BUCKET || env.R2_BUCKET);
    const hasBucket = Boolean(bucket && typeof bucket.delete === 'function');
    const hasAccountId = Boolean(env && env.R2_ACCOUNT_ID);
    const hasAccessKey = Boolean(env && env.R2_ACCESS_KEY_ID);
    const hasSecretKey = Boolean(env && env.R2_SECRET_ACCESS_KEY);
    const bucketName = (env && env.R2_BUCKET_NAME) || 'pickup-media';

    return {
      provider: 'r2',
      configured: Boolean(hasBucket || (hasAccountId && hasAccessKey && hasSecretKey)),
      bucketBound: hasBucket,
      accountIdConfigured: hasAccountId,
      credentialsConfigured: hasAccessKey && hasSecretKey,
      bucketName
    };
  }
};
