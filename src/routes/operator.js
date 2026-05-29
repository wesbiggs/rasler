import { Router } from 'express';
import multer from 'multer';
import { CarReader } from '@ipld/car';
import { base32 } from 'multiformats/bases/base32';
import * as dagCbor from '@ipld/dag-cbor';
import { computeDataCid, computeMaslCid, isMaslCid } from '../crypto/cid.js';
import { createSingleMasl, parseMasl, maslLinkedCids, maslIsBundle } from '../masl/document.js';
import { realpathSync } from 'fs';
import { requireApiSecret } from '../middleware/auth.js';
import { makeOperatorCors } from '../middleware/cors.js';
import { normalizeMountPath } from '../util/normalizeMountPath.js';

const upload = multer({ storage: multer.memoryStorage() });

/**
 * @openapi
 * components:
 *   schemas:
 *     ContentItem:
 *       type: object
 *       properties:
 *         cid:
 *           type: string
 *           example: bafkreid7qoywk7hv5udpjlmxqmr4of3d5jx4k5r2kvfm4vs3l4dz3t7ku
 *         maslCid:
 *           type: string
 *           nullable: true
 *           example: bafyreid7qoywk7hv5udpjlmxqmr4of3d5jx4k5r2kvfm4vs3l4dz3t7ku
 *         size:
 *           type: integer
 *           example: 4096
 *         pinned:
 *           type: boolean
 *         lastRequested:
 *           type: integer
 *           nullable: true
 *           description: Unix timestamp in milliseconds
 *     UploadResult:
 *       type: object
 *       properties:
 *         filename:
 *           type: string
 *         maslCid:
 *           type: string
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 */

function isCarFile(file) {
  return (
    file.mimetype === 'application/vnd.ipld.car' ||
    file.mimetype === 'application/car' ||
    file.originalname?.toLowerCase().endsWith('.car')
  );
}

// Extract, verify, and return all blocks from a CAR file.
// Returns { maslCid, blocks: Map<cidStr, Uint8Array> } or throws with { status, error, ...extra }.
async function readCar(fileBuffer) {
  let reader;
  try {
    reader = await CarReader.fromBytes(fileBuffer);
  } catch {
    throw { status: 400, error: 'Invalid CAR file' };
  }

  const blocks = new Map();
  try {
    for await (const { cid, bytes } of reader.blocks()) {
      const cidStr = cid.toString(base32);
      const isMasl = cid.code === dagCbor.code;
      const actual = isMasl ? await computeMaslCid(bytes) : await computeDataCid(bytes);
      if (actual !== cidStr) throw { status: 400, error: `CID mismatch for block ${cidStr}` };
      blocks.set(cidStr, bytes);
    }
  } catch (err) {
    if (err.status) throw err;
    throw { status: 400, error: `Failed to read CAR blocks: ${err.message}` };
  }

  const roots = await reader.getRoots();
  const maslRoot = roots.find(cid => cid.code === dagCbor.code);
  if (!maslRoot) throw { status: 400, error: 'CAR root must be a MASL CID (dag-cbor codec)' };

  const maslCid = maslRoot.toString(base32);
  if (!blocks.has(maslCid)) throw { status: 400, error: 'MASL root block is missing from the CAR' };

  let doc;
  try { doc = parseMasl(blocks.get(maslCid)); } catch {
    throw { status: 400, error: 'Failed to parse MASL document' };
  }

  const links = maslLinkedCids(doc);
  const missing = links.filter(l => !blocks.has(l.cid)).map(l => l.cid);
  if (missing.length > 0) throw { status: 400, error: 'CAR is missing linked data CIDs', missing };

  return { maslCid, blocks, links };
}

// Base operator router: content management and node status (base fields).
// Auth and CORS are applied here, which also protects any operator extension router
// routes — Express runs router.use middleware for all requests entering the router
// even when no route matches, so auth is enforced before the request falls through
// to the overlay extension.
export function makeOperatorRouter({ store, selfDomain, apiSecret, corsOrigins = [], staticRoots = [], mountPoints = [] }) {
  const router = Router();
  if (corsOrigins.length > 0) router.use(makeOperatorCors(corsOrigins));
  router.use(requireApiSecret(apiSecret));

  /**
   * @openapi
   * /upload:
   *   post:
   *     tags: [Content]
   *     summary: Upload one or more files
   *     description: >
   *       Each file is stored unpinned. Files are either a raw data file (any
   *       content type) or a CARv1 bundle (detected by content-type
   *       `application/vnd.ipld.car` or a `.car` extension). A raw file gets a
   *       single-mode MASL wrapper generated automatically.
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             required: [files]
   *             properties:
   *               files:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: binary
   *     responses:
   *       '200':
   *         description: All files stored successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 uploads:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/UploadResult'
   *       '400':
   *         description: Invalid input (bad CAR, CID mismatch, no files)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       '401':
   *         description: Missing or invalid operator secret
   *       '507':
   *         description: Insufficient storage
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.post('/upload', upload.array('files'), async (req, res) => {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const uploads = [];

    for (const file of files) {
      if (isCarFile(file)) {
        let parsed;
        try {
          parsed = await readCar(file.buffer);
        } catch (err) {
          return res.status(err.status ?? 400).json(
            err.missing ? { error: err.error, missing: err.missing } : { error: err.error }
          );
        }

        const { maslCid, blocks, links } = parsed;
        const totalBytes = [...blocks.values()].reduce((n, b) => n + b.length, 0);
        if (store.getPoolAvailable() < totalBytes) {
          if (!store.evictIfNeeded(totalBytes)) {
            return res.status(507).json({ error: 'Insufficient storage' });
          }
        }

        store.putContent(maslCid, blocks.get(maslCid));
        for (const link of links) {
          store.putContent(link.cid, blocks.get(link.cid), { maslCid });
        }
        uploads.push({ filename: file.originalname, maslCid });

      } else {
        const bytes = file.buffer;
        const name = file.originalname ?? 'upload';
        const type = file.mimetype ?? 'application/octet-stream';
        const size = bytes.length;

        let dataCid;
        try { dataCid = await computeDataCid(bytes); } catch {
          return res.status(500).json({ error: `CID computation failed for ${name}` });
        }

        let maslResult;
        try {
          maslResult = await createSingleMasl({ name, type, size, dataCid });
        } catch {
          return res.status(500).json({ error: `MASL creation failed for ${name}` });
        }

        const { cborBytes, maslCid } = maslResult;
        const totalBytes = bytes.length + cborBytes.length;
        if (store.getPoolAvailable() < totalBytes) {
          if (!store.evictIfNeeded(totalBytes)) {
            return res.status(507).json({ error: 'Insufficient storage' });
          }
        }

        store.putContent(dataCid, bytes, { maslCid });
        store.putContent(maslCid, cborBytes);
        uploads.push({ filename: name, maslCid });
      }
    }

    return res.status(200).json({ uploads });
  });

  /**
   * @openapi
   * /pin:
   *   post:
   *     tags: [Content]
   *     summary: Pin stored CIDs
   *     description: >
   *       Marks CIDs as operator-pinned so they are never evicted. Pinning a
   *       MASL CID also pins all its linked data CIDs; pinning a data CID also
   *       pins its MASL wrapper.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [cids]
   *             properties:
   *               cids:
   *                 type: array
   *                 items:
   *                   type: string
   *                 example: ["bafyreid7qoywk7hv5udpjlmxqmr4of3d5jx4k5r2kvfm4vs3l4dz3t7ku"]
   *     responses:
   *       '200':
   *         description: CIDs pinned (includes cascade pins)
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 pinned:
   *                   type: array
   *                   items:
   *                     type: string
   *       '400':
   *         description: cids missing or empty
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       '401':
   *         description: Missing or invalid operator secret
   *       '404':
   *         description: One or more CIDs not held locally
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.post('/pin', (req, res) => {
    const { cids } = req.body ?? {};
    if (!Array.isArray(cids) || cids.length === 0) {
      return res.status(400).json({ error: 'cids must be a non-empty array' });
    }

    const pinned = new Set();

    for (const cid of cids) {
      const entry = store.getContent(cid);
      if (!entry) return res.status(404).json({ error: `CID not found: ${cid}` });

      store.setPinned(cid, true);
      pinned.add(cid);

      const maslCid = entry.meta.masl_cid;
      if (maslCid && store.hasContent(maslCid)) {
        store.setPinned(maslCid, true);
        pinned.add(maslCid);
      }

      for (const row of store.listContent()) {
        if (row.masl_cid === cid) {
          store.setPinned(row.cid, true);
          pinned.add(row.cid);
        }
      }
    }

    return res.status(200).json({ pinned: [...pinned] });
  });

  /**
   * @openapi
   * /pin/{cid}:
   *   delete:
   *     tags: [Content]
   *     summary: Unpin a CID
   *     description: >
   *       Removes the operator pin from a CID, making it eligible for eviction.
   *       Unpinning a MASL CID also unpins its linked data CIDs; unpinning a
   *       data CID also unpins its MASL wrapper. Returns 200 even if the CID is
   *       not held.
   *     parameters:
   *       - in: path
   *         name: cid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Unpinned (or not found)
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   enum: [ok, not found]
   *       '401':
   *         description: Missing or invalid operator secret
   */
  router.delete('/pin/:cid', (req, res) => {
    const { cid } = req.params;
    const meta = store.getContent(cid)?.meta;

    if (!meta) return res.status(200).json({ status: 'not found' });

    store.setPinned(cid, false);

    if (meta.masl_cid && store.hasContent(meta.masl_cid)) {
      store.setPinned(meta.masl_cid, false);
    }

    for (const row of store.listContent()) {
      if (row.masl_cid === cid) store.setPinned(row.cid, false);
    }

    return res.status(200).json({ status: 'ok' });
  });

  /**
   * @openapi
   * /content:
   *   get:
   *     tags: [Content]
   *     summary: List locally held CIDs
   *     description: Cursor-based pagination over all CIDs held by this node, ordered by CID.
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 50
   *           minimum: 1
   *           maximum: 200
   *         description: Number of items per page
   *       - in: query
   *         name: cursor
   *         schema:
   *           type: string
   *         description: Exclusive lower-bound CID from the previous page's `nextCursor`
   *     responses:
   *       '200':
   *         description: Page of content items
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 total:
   *                   type: integer
   *                   description: Total number of CIDs held (across all pages)
   *                 items:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/ContentItem'
   *                 nextCursor:
   *                   type: string
   *                   nullable: true
   *                   description: Pass as `cursor` to fetch the next page; null on the last page
   *       '401':
   *         description: Missing or invalid operator secret
   */
  router.get('/content', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
    const cursor = req.query.cursor ?? null;

    const items = store.listContentPage(limit, cursor);
    const total = store.countContent();
    const nextCursor = items.length === limit ? items[items.length - 1].cid : null;

    return res.status(200).json({
      total,
      items: items.map(row => ({
        cid: row.cid,
        maslCid: row.masl_cid ?? null,
        size: row.size,
        pinned: row.pinned === 1,
        lastRequested: row.last_requested ?? null,
      })),
      nextCursor,
    });
  });

  /**
   * @openapi
   * /content/{cid}:
   *   get:
   *     tags: [Content]
   *     summary: Get metadata for a single CID
   *     parameters:
   *       - in: path
   *         name: cid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: CID metadata
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ContentItem'
   *       '401':
   *         description: Missing or invalid operator secret
   *       '404':
   *         description: CID not held locally
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *   delete:
   *     tags: [Content]
   *     summary: Force-remove a CID
   *     description: >
   *       Permanently deletes a CID regardless of pin status. If the CID is a
   *       MASL document, all linked data CIDs that are held locally are also
   *       deleted. Returns the list of all CIDs actually removed.
   *     parameters:
   *       - in: path
   *         name: cid
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: CID(s) deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 deleted:
   *                   type: array
   *                   items:
   *                     type: string
   *       '401':
   *         description: Missing or invalid operator secret
   *       '404':
   *         description: CID not held locally
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.get('/content/:cid', (req, res) => {
    const { cid } = req.params;
    const meta = store.getContentMeta(cid);
    if (!meta) return res.status(404).json({ error: 'CID not found' });
    return res.status(200).json({
      cid: meta.cid,
      maslCid: meta.masl_cid ?? null,
      size: meta.size,
      pinned: meta.pinned === 1,
      lastRequested: meta.last_requested ?? null,
    });
  });

  router.delete('/content/:cid', (req, res) => {
    const { cid } = req.params;
    const entry = store.getContent(cid);
    if (!entry) return res.status(404).json({ error: 'CID not found' });

    const deleted = [];

    if (isMaslCid(cid)) {
      let linkedCids = [];
      try {
        linkedCids = maslLinkedCids(parseMasl(entry.bytes)).map(l => l.cid);
      } catch {
        // Unparseable MASL — fall through and delete just the MASL itself
      }
      for (const linkedCid of linkedCids) {
        if (store.hasContent(linkedCid)) {
          store.deleteContent(linkedCid);
          deleted.push(linkedCid);
        }
      }
    }

    store.deleteContent(cid);
    deleted.push(cid);

    return res.status(200).json({ deleted });
  });

  /**
   * @openapi
   * /static-roots:
   *   get:
   *     tags: [Content]
   *     summary: List configured static roots and their current MASL CIDs
   *     description: >
   *       Returns one entry per directory configured in STATIC_ROOTS. `maslCid`
   *       is null if background indexing has not yet completed for that root.
   *     responses:
   *       '200':
   *         description: Static root list
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   path:
   *                     type: string
   *                     description: Configured directory path
   *                   maslCid:
   *                     type: string
   *                     nullable: true
   *                     description: Current bundle MASL CID, or null if not yet indexed
   *       '401':
   *         description: Missing or invalid operator secret
   */
  router.get('/static-roots', (req, res) => {
    const result = staticRoots.map(root => {
      let maslCid = null;
      try {
        maslCid = store.staticRootMasls.get(realpathSync(root)) ?? null;
      } catch { /* root path does not exist */ }
      return { path: root, maslCid };
    });
    return res.status(200).json(result);
  });

  /**
   * @openapi
   * /mount-points:
   *   get:
   *     tags: [Content]
   *     summary: List all virtual hosts and their current MASL CIDs
   *     description: >
   *       Returns all virtual hosts: those set via the operator API (`source:
   *       runtime`) and those configured in MOUNT_POINTS (`source: static`).
   *       Runtime entries take priority in serving. `maslCid` is null only for
   *       static entries whose background indexing has not yet completed.
   *     responses:
   *       '200':
   *         description: Virtual host list
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   hostname:
   *                     type: string
   *                   mountPath:
   *                     type: string
   *                     description: URL path prefix for this mount point (e.g. / or /docs)
   *                   path:
   *                     type: string
   *                     nullable: true
   *                     description: Directory path (static entries only)
   *                   maslCid:
   *                     type: string
   *                     nullable: true
   *                   source:
   *                     type: string
   *                     enum: [runtime, static]
   *       '401':
   *         description: Missing or invalid operator secret
   */
  router.get('/mount-points', (req, res) => {
    const result = [];
    const seen = new Set();

    // Runtime entries first (they take serving priority).
    for (const mp of store.runtimeMountPoints) {
      const key = `${mp.hostname}|${mp.prefix}`;
      seen.add(key);
      result.push({ hostname: mp.hostname, mountPath: mp.prefix || '/', path: null, maslCid: mp.maslCid, source: 'runtime' });
    }

    // Config-backed entries not overridden by a runtime mapping at the same (hostname, prefix).
    for (const mp of mountPoints) {
      const key = `${mp.hostname}|${mp.prefix}`;
      if (seen.has(key)) continue;
      let maslCid = null;
      try { maslCid = store.staticRootMasls.get(realpathSync(mp.directory)) ?? null; } catch {}
      result.push({ hostname: mp.hostname, mountPath: mp.prefix || '/', path: mp.directory, maslCid, source: 'static' });
    }

    return res.status(200).json(result);
  });

  /**
   * @openapi
   * /mount-points/{hostname}:
   *   put:
   *     tags: [Content]
   *     summary: Map a hostname (with optional path prefix) to a bundle MASL CID
   *     description: >
   *       Registers a runtime mount point mapping. The MASL CID must already be
   *       held locally and must be a bundle MASL. The MASL is pinned automatically
   *       to prevent eviction. This mapping takes priority over any static-root
   *       mapping for the same (hostname, mountPath) and persists across restarts.
   *     parameters:
   *       - in: path
   *         name: hostname
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [maslCid]
   *             properties:
   *               maslCid:
   *                 type: string
   *               mountPath:
   *                 type: string
   *                 description: URL path prefix for this mount point (default /)
   *     responses:
   *       '200':
   *         description: Mapping set
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 hostname:
   *                   type: string
   *                 mountPath:
   *                   type: string
   *                 maslCid:
   *                   type: string
   *       '400':
   *         description: Invalid or non-bundle MASL CID
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       '401':
   *         description: Missing or invalid operator secret
   *       '404':
   *         description: CID not held locally
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *   delete:
   *     tags: [Content]
   *     summary: Remove a runtime mount point mapping
   *     parameters:
   *       - in: path
   *         name: hostname
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: mountPath
   *         required: false
   *         schema:
   *           type: string
   *         description: URL path prefix to remove (default /)
   *     responses:
   *       '200':
   *         description: Mapping removed
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   enum: [ok]
   *       '401':
   *         description: Missing or invalid operator secret
   *       '404':
   *         description: Runtime mapping not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.put('/mount-points/:hostname', (req, res) => {
    const { hostname } = req.params;
    const { maslCid, mountPath } = req.body ?? {};
    const prefix = normalizeMountPath(mountPath ?? '/');
    if (!maslCid || typeof maslCid !== 'string') {
      return res.status(400).json({ error: 'maslCid is required' });
    }
    if (!isMaslCid(maslCid)) {
      return res.status(400).json({ error: 'maslCid must be a dag-cbor CID' });
    }
    const entry = store.getContent(maslCid);
    if (!entry) {
      return res.status(404).json({ error: 'CID not held locally' });
    }
    let doc;
    try { doc = parseMasl(entry.bytes); } catch {
      return res.status(400).json({ error: 'Failed to parse MASL document' });
    }
    if (!maslIsBundle(doc)) {
      return res.status(400).json({ error: 'maslCid must refer to a bundle MASL' });
    }
    store.setPinned(maslCid, true);
    store.setVirtualHost(hostname, prefix, maslCid);
    return res.status(200).json({ hostname, mountPath: prefix || '/', maslCid });
  });

  router.delete('/mount-points/:hostname', (req, res) => {
    const { hostname } = req.params;
    const prefix = normalizeMountPath(req.query.mountPath ?? '/');
    const exists = store.runtimeMountPoints.some(mp => mp.hostname === hostname && mp.prefix === prefix);
    if (!exists) {
      return res.status(404).json({ error: 'Runtime virtual host mapping not found' });
    }
    store.deleteVirtualHost(hostname, prefix);
    return res.status(200).json({ status: 'ok' });
  });

  // Base /status: writes local fields and falls through to overlay/terminator.
  router.get('/status', (req, res, next) => {
    res.locals.status = {
      domain: selfDomain,
      storage: {
        totalCapacity: store.totalCapacity,
        poolUsed: store.getPoolUsed(),
        poolAvailable: store.getPoolAvailable(),
        pinnedUsed: store.getPinnedUsed(),
        pinnedCount: store.countPinned(),
      },
    };
    next();
  });

  return router;
}

// Terminator: sends the /status response assembled by base and overlay handlers.
export function makeOperatorStatusTerminator() {
  const router = Router();
  router.get('/status', (req, res) => res.status(200).json(res.locals.status));
  return router;
}
