/**
 * tests/helpers/mock-gdrive.js
 * High-Fidelity Mock Google Drive API v3 Engine
 *
 * Implements Google Drive v3 protocols for offline CI test execution:
 * - Resumable Upload Session Creation (POST /upload/drive/v3/files?uploadType=resumable)
 * - Chunked Byte-Range Uploads (PUT /upload/drive/v3/files?upload_id=...)
 * - Zero-Copy Range Streaming with HTTP 206 Partial Content (GET /drive/v3/files/:id?alt=media)
 * - Full Media Download with HTTP 200 (GET /drive/v3/files/:id?alt=media)
 * - PBF Shared Drive Storage Quota & Metric Reporting (GET /drive/v3/about?fields=storageQuota)
 * - File Metadata Retrieval (GET /drive/v3/files/:id)
 */

const express = require('express');
const http = require('http');

class MockGoogleDriveService {
  constructor() {
    this.files = new Map(); // fileId -> { id, name, mimeType, size, buffer, createdAt }
    this.sessions = new Map(); // sessionId -> { fileId, metadata, bufferChunks, receivedBytes, totalBytes }
    this.fileCounter = 1;
    this.quotaLimit = 5 * 1024 * 1024 * 1024 * 1024; // 5 TB in bytes
    this.quotaUsed = 120 * 1024 * 1024 * 1024; // 120 GB baseline usage
  }

  reset() {
    this.files.clear();
    this.sessions.clear();
    this.fileCounter = 1;
  }

  /**
   * Express router implementing Google Drive v3 endpoints
   */
  createRouter() {
    const router = express.Router();

    // 1. Resumable Upload Session Init
    router.post('/upload/drive/v3/files', express.json(), (req, res) => {
      const uploadType = req.query.uploadType;
      if (uploadType !== 'resumable') {
        return res.status(400).json({ error: { message: 'Only resumable uploadType is supported' } });
      }

      const sessionId = `mock_session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const fileId = `gdrive_file_${this.fileCounter++}`;
      const metadata = req.body || {};
      const totalBytes = parseInt(req.headers['x-upload-content-length'] || metadata.size || '0', 10);

      this.sessions.set(sessionId, {
        fileId,
        metadata: {
          id: fileId,
          name: metadata.name || 'unnamed',
          mimeType: metadata.mimeType || req.headers['x-upload-content-type'] || 'application/octet-stream',
          size: totalBytes
        },
        bufferChunks: [],
        receivedBytes: 0,
        totalBytes
      });

      const host = req.get('host') || '127.0.0.1';
      const protocol = req.protocol || 'http';
      const sessionUri = `${protocol}://${host}/upload/drive/v3/files?upload_id=${sessionId}`;

      res.setHeader('Location', sessionUri);
      return res.status(200).json({
        kind: 'drive#file',
        id: fileId,
        sessionUri
      });
    });

    // 2. Resumable Chunk Upload
    router.put('/upload/drive/v3/files', express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
      const sessionId = req.query.upload_id;
      const session = this.sessions.get(sessionId);
      if (!session) {
        return res.status(404).json({ error: { message: 'Upload session not found or expired' } });
      }

      const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const contentRange = req.headers['content-range'];
      let start = 0;
      let end = 0;
      let total = session.totalBytes;

      if (contentRange) {
        // e.g. "bytes 0-1048575/2097152"
        const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/);
        if (match) {
          start = parseInt(match[1], 10);
          end = parseInt(match[2], 10);
          total = match[3] === '*' ? session.totalBytes : parseInt(match[3], 10);
        }
      }

      // Check 1: Enforce byte-range sequence (reject out-of-order chunks)
      if (contentRange && start !== session.receivedBytes) {
        if (session.receivedBytes > 0) {
          res.setHeader('Range', `bytes=0-${session.receivedBytes - 1}`);
        }
        return res.status(308).send('Resume Incomplete');
      }

      // Check 2: Enforce 256 KB multiple for intermediate chunks
      const isFinalChunk = contentRange
        ? (end + 1 >= total)
        : (session.receivedBytes + chunk.length >= session.totalBytes);

      if (!isFinalChunk && chunk.length % 262144 !== 0) {
        return res.status(400).json({
          error: {
            code: 400,
            message: 'Invalid chunk size. Chunk size must be a multiple of 256 KB (262,144 bytes), except for the final chunk.'
          }
        });
      }

      // Accept chunk
      session.bufferChunks.push(chunk);
      session.receivedBytes += chunk.length;

      // Check 3: Strict completion check (all bytes received)
      const isComplete = (isFinalChunk && session.receivedBytes >= total) || (session.totalBytes === 0);

      if (isComplete) {
        const fullBuffer = Buffer.concat(session.bufferChunks);
        const fileRecord = {
          id: session.fileId,
          name: session.metadata.name,
          mimeType: session.metadata.mimeType,
          size: fullBuffer.length,
          buffer: fullBuffer,
          createdAt: new Date().toISOString()
        };
        this.files.set(session.fileId, fileRecord);
        this.sessions.delete(sessionId);
        this.quotaUsed += fullBuffer.length;

        return res.status(200).json({
          kind: 'drive#file',
          id: fileRecord.id,
          name: fileRecord.name,
          mimeType: fileRecord.mimeType,
          size: String(fileRecord.size)
        });
      }

      // Resume Incomplete (Standard Google Drive behavior)
      res.setHeader('Range', `bytes=0-${session.receivedBytes - 1}`);
      return res.status(308).send('Resume Incomplete');
    });

    // 3. File Streaming & Range Requests
    router.get('/drive/v3/files/:id', (req, res) => {
      const fileId = req.params.id;
      const file = this.files.get(fileId);
      if (!file) {
        return res.status(404).json({ error: { message: 'File not found in Google Drive' } });
      }

      // If alt=media, download or stream binary contents
      if (req.query.alt === 'media') {
        const totalSize = file.buffer.length;
        const rangeHeader = req.headers['range'];

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', file.mimeType);

        if (rangeHeader) {
          // Parse Range: bytes=start-end
          const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (!match) {
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            return res.status(416).send('Range Not Satisfiable');
          }

          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

          if (start >= totalSize || end < start) {
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            return res.status(416).send('Range Not Satisfiable');
          }

          const sliceEnd = Math.min(end + 1, totalSize);
          const chunk = file.buffer.subarray(start, sliceEnd);
          const chunkLength = chunk.length;

          res.setHeader('Content-Range', `bytes ${start}-${start + chunkLength - 1}/${totalSize}`);
          res.setHeader('Content-Length', String(chunkLength));
          return res.status(206).send(chunk);
        }

        // Full content download
        res.setHeader('Content-Length', String(totalSize));
        return res.status(200).send(file.buffer);
      }

      // Return File Metadata JSON
      return res.status(200).json({
        kind: 'drive#file',
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: String(file.size),
        createdTime: file.createdAt
      });
    });

    // 4. Storage Quota & Status
    router.get('/drive/v3/about', (req, res) => {
      return res.status(200).json({
        kind: 'drive#about',
        storageQuota: {
          limit: String(this.quotaLimit),
          usage: String(this.quotaUsed),
          usageInDrive: String(this.quotaUsed),
          usageInDriveTrash: '0'
        }
      });
    });

    return router;
  }
}

/**
 * Helper to spin up a standalone mock Google Drive HTTP server
 */
function createMockGDriveServer() {
  const service = new MockGoogleDriveService();
  const app = express();
  app.use(service.createRouter());

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        service,
        baseUrl,
        server,
        close: () => Promise.race([
          new Promise((r) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(r);
          }),
          new Promise((r) => setTimeout(r, 1500).unref())
        ])
      });
    });
  });
}

module.exports = {
  MockGoogleDriveService,
  createMockGDriveServer
};
