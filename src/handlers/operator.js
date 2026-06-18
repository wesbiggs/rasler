import { CarReader } from '@ipld/car';
import { base32 } from 'multiformats/bases/base32';
import * as dagCbor from '@ipld/dag-cbor';
import { computeDataCid, computeMaslCid, isMaslCid } from '../crypto/cid.js';
import { createSingleMasl, parseMasl, maslLinkedCids, maslIsBundle } from '../masl/document.js';
import { normalizeMountPath } from '../util/normalizeMountPath.js';

function isCarFilename(name) {
  return name?.toLowerCase().endsWith('.car');
}

function isCarMimeType(type) {
  return type === 'application/vnd.ipld.car' || type === 'application/car';
}

export function isCarFile({ name, type }) {
  return isCarMimeType(type) || isCarFilename(name);
}

// Extract, verify, and return all blocks from a CAR file buffer.
// Returns { maslCid, blocks: Map<cidStr, Uint8Array>, links } or throws { status, error, ...extra }.
export async function readCar(fileBuffer) {
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

// files: Array<{ name: string, type: string, bytes: Uint8Array }>
// Returns { status, body }
export async function handleUpload(store, files) {
  if (!files || files.length === 0) {
    return { status: 400, body: { error: 'No files provided' } };
  }

  const uploads = [];

  for (const file of files) {
    if (isCarFile(file)) {
      let parsed;
      try {
        parsed = await readCar(file.bytes);
      } catch (err) {
        return {
          status: err.status ?? 400,
          body: err.missing ? { error: err.error, missing: err.missing } : { error: err.error },
        };
      }

      const { maslCid, blocks, links } = parsed;
      const totalBytes = [...blocks.values()].reduce((n, b) => n + b.length, 0);
      if (await store.getPoolAvailable() < totalBytes) {
        if (!await store.evictIfNeeded(totalBytes)) {
          return { status: 507, body: { error: 'Insufficient storage' } };
        }
      }

      await store.putContent(maslCid, blocks.get(maslCid));
      for (const link of links) {
        await store.putContent(link.cid, blocks.get(link.cid), { maslCid });
      }
      uploads.push({ filename: file.name, maslCid });

    } else {
      const { bytes, name = 'upload', type = 'application/octet-stream' } = file;
      const size = bytes.length;

      let dataCid;
      try { dataCid = await computeDataCid(bytes); } catch {
        return { status: 500, body: { error: `CID computation failed for ${name}` } };
      }

      let maslResult;
      try {
        maslResult = await createSingleMasl({ name, type, size, dataCid });
      } catch {
        return { status: 500, body: { error: `MASL creation failed for ${name}` } };
      }

      const { cborBytes, maslCid } = maslResult;
      const totalBytes = bytes.length + cborBytes.length;
      if (await store.getPoolAvailable() < totalBytes) {
        if (!await store.evictIfNeeded(totalBytes)) {
          return { status: 507, body: { error: 'Insufficient storage' } };
        }
      }

      await store.putContent(dataCid, bytes, { maslCid });
      await store.putContent(maslCid, cborBytes);
      uploads.push({ filename: name, maslCid });
    }
  }

  return { status: 200, body: { uploads } };
}

// cids: string[]
// Returns { status, body }
export async function handlePin(store, cids) {
  if (!Array.isArray(cids) || cids.length === 0) {
    return { status: 400, body: { error: 'cids must be a non-empty array' } };
  }

  const pinned = new Set();

  for (const cid of cids) {
    const entry = await store.getContent(cid);
    if (!entry) return { status: 404, body: { error: `CID not found: ${cid}` } };

    await store.setPinned(cid, true);
    pinned.add(cid);

    const maslCid = entry.meta.masl_cid;
    if (maslCid && await store.hasContent(maslCid)) {
      await store.setPinned(maslCid, true);
      pinned.add(maslCid);
    }

    for (const row of await store.listContent()) {
      if (row.masl_cid === cid) {
        await store.setPinned(row.cid, true);
        pinned.add(row.cid);
      }
    }
  }

  return { status: 200, body: { pinned: [...pinned] } };
}

export async function handleUnpin(store, cid) {
  const entry = await store.getContent(cid);
  if (!entry) return { status: 200, body: { status: 'not found' } };

  await store.setPinned(cid, false);

  if (entry.meta.masl_cid && await store.hasContent(entry.meta.masl_cid)) {
    await store.setPinned(entry.meta.masl_cid, false);
  }

  for (const row of await store.listContent()) {
    if (row.masl_cid === cid) await store.setPinned(row.cid, false);
  }

  return { status: 200, body: { status: 'ok' } };
}

export async function handleListContent(store, limit, cursor) {
  const items = await store.listContentPage(limit, cursor);
  const total = await store.countContent();
  const nextCursor = items.length === limit ? items[items.length - 1].cid : null;
  return {
    status: 200,
    body: {
      total,
      items: items.map(row => ({
        cid: row.cid,
        maslCid: row.masl_cid ?? null,
        size: row.size,
        pinned: row.pinned === 1,
        lastRequested: row.last_requested ?? null,
      })),
      nextCursor,
    },
  };
}

export async function handleGetContent(store, cid) {
  const meta = await store.getContentMeta(cid);
  if (!meta) return { status: 404, body: { error: 'CID not found' } };
  return {
    status: 200,
    body: {
      cid: meta.cid,
      maslCid: meta.masl_cid ?? null,
      size: meta.size,
      pinned: meta.pinned === 1,
      lastRequested: meta.last_requested ?? null,
    },
  };
}

export async function handleDeleteContent(store, cid) {
  const entry = await store.getContent(cid);
  if (!entry) return { status: 404, body: { error: 'CID not found' } };

  const deleted = [];

  if (isMaslCid(cid)) {
    let linkedCids = [];
    try {
      linkedCids = maslLinkedCids(parseMasl(entry.bytes)).map(l => l.cid);
    } catch {
      // Unparseable MASL — fall through and delete just the MASL itself
    }
    for (const linkedCid of linkedCids) {
      if (await store.hasContent(linkedCid)) {
        await store.deleteContent(linkedCid);
        deleted.push(linkedCid);
      }
    }
  }

  await store.deleteContent(cid);
  deleted.push(cid);

  return { status: 200, body: { deleted } };
}

export async function handleSetMountPoint(store, hostnameParam, prefixParam) {
  return async function (maslCid) {
    if (!maslCid || typeof maslCid !== 'string') {
      return { status: 400, body: { error: 'maslCid is required' } };
    }
    if (!isMaslCid(maslCid)) {
      return { status: 400, body: { error: 'maslCid must be a dag-cbor CID' } };
    }
    const entry = await store.getContent(maslCid);
    if (!entry) return { status: 404, body: { error: 'CID not held locally' } };
    let doc;
    try { doc = parseMasl(entry.bytes); } catch {
      return { status: 400, body: { error: 'Failed to parse MASL document' } };
    }
    if (!maslIsBundle(doc)) {
      return { status: 400, body: { error: 'maslCid must refer to a bundle MASL' } };
    }
    const hostname = hostnameParam === '-' ? '' : hostnameParam;
    const prefix = normalizeMountPath(prefixParam || '/');
    await store.setPinned(maslCid, true);
    await store.setMountPoint(hostname, prefix, maslCid);
    return { status: 200, body: { hostname: hostname || null, mountPath: prefix || '/', maslCid } };
  };
}

export async function handleDeleteMountPoint(store, hostnameParam, prefixParam) {
  const hostname = hostnameParam === '-' ? '' : hostnameParam;
  const prefix = normalizeMountPath(prefixParam || '/');
  const exists = store.runtimeMountPoints.some(mp => mp.hostname === hostname && mp.prefix === prefix);
  if (!exists) {
    return { status: 404, body: { error: 'Runtime virtual host mapping not found' } };
  }
  await store.deleteMountPoint(hostname, prefix);
  return { status: 200, body: { status: 'ok' } };
}

export async function handleGetStatus(store, selfOrigin) {
  return {
    origin: selfOrigin,
    storage: {
      totalCapacity: store.totalCapacity,
      poolUsed: await store.getPoolUsed(),
      poolAvailable: await store.getPoolAvailable(),
      pinnedUsed: await store.getPinnedUsed(),
      pinnedCount: await store.countPinned(),
    },
  };
}
