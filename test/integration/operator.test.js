import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import { makeBaseTestApp } from './baseHelpers.js';
import { computeDataCid } from '../../src/crypto/cid.js';
import { OPERATOR_SECRET_HEADER } from '../../src/middleware/auth.js';
import { createSingleMasl, createBundleMasl } from '../../src/masl/document.js';

// Build a CARv1 from an ordered list of [cidString, bytes] pairs, with the given root CID.
async function buildCar(rootCidStr, blocks) {
  const rootCid = CID.parse(rootCidStr, base32);
  const { writer, out } = CarWriter.create([rootCid]);
  const [chunks] = await Promise.all([
    (async () => { const acc = []; for await (const c of out) acc.push(c); return acc; })(),
    (async () => {
      for (const [cidStr, bytes] of blocks) {
        await writer.put({ cid: CID.parse(cidStr, base32), bytes });
      }
      await writer.close();
    })(),
  ]);
  return Buffer.concat(chunks);
}

// Helper: upload a raw file and return the upload result.
async function uploadFile(app, apiSecret, content, filename, contentType) {
  const res = await request(app)
    .post('/upload')
    .set(OPERATOR_SECRET_HEADER, apiSecret)
    .attach('files', content, { filename, contentType: contentType ?? 'application/octet-stream' });
  return res;
}

// Helper: upload a CAR and return the upload result.
async function uploadCar(app, apiSecret, carBytes, filename = 'bundle.car') {
  return request(app)
    .post('/upload')
    .set(OPERATOR_SECRET_HEADER, apiSecret)
    .attach('files', carBytes, { filename, contentType: 'application/vnd.ipld.car' });
}

// Helper: upload then pin, returning the maslCid.
async function uploadAndPin(app, apiSecret, content, filename) {
  const up = await uploadFile(app, apiSecret, content, filename, 'text/plain');
  expect(up.status).toBe(200);
  const { maslCid } = up.body.uploads[0];
  const pin = await request(app)
    .post('/pin')
    .set(OPERATOR_SECRET_HEADER, apiSecret)
    .send({ cids: [maslCid] });
  expect(pin.status).toBe(200);
  return maslCid;
}

describe('Operator API routes', () => {
  let app, store, cleanup, apiSecret;

  beforeEach(() => {
    ({ app, store, cleanup, apiSecret } = makeBaseTestApp());
  });

  afterEach(() => cleanup());

  describe('Authentication', () => {
    it('rejects requests without x-rasl-operator-secret header', async () => {
      const res = await request(app).get('/status');
      expect(res.status).toBe(401);
    });

    it('rejects requests with wrong x-rasl-operator-secret', async () => {
      const res = await request(app).get('/status').set(OPERATOR_SECRET_HEADER, 'wrong');
      expect(res.status).toBe(401);
    });

    it('accepts requests with correct x-rasl-operator-secret', async () => {
      const res = await request(app).get('/status').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /status', () => {
    it('returns domain and storage fields', async () => {
      const res = await request(app).get('/status').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.status).toBe(200);
      expect(res.body.domain).toBeDefined();
      expect(res.body.storage.totalCapacity).toBeGreaterThan(0);
      expect(res.body.storage.poolUsed).toBeGreaterThanOrEqual(0);
      expect(res.body.storage.poolAvailable).toBeGreaterThanOrEqual(0);
      expect(res.body.storage.pinnedUsed).toBeGreaterThanOrEqual(0);
      expect(res.body.storage.pinnedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('POST /upload', () => {
    describe('raw file', () => {
      it('returns maslCid and filename for each file', async () => {
        const res = await uploadFile(app, apiSecret, Buffer.from('hello'), 'hello.txt', 'text/plain');
        expect(res.status).toBe(200);
        expect(res.body.uploads).toHaveLength(1);
        expect(res.body.uploads[0].filename).toBe('hello.txt');
        expect(res.body.uploads[0].maslCid).toBeDefined();
      });

      it('stores content unpinned', async () => {
        const res = await uploadFile(app, apiSecret, Buffer.from('unpinned'), 'f.txt', 'text/plain');
        const { maslCid } = res.body.uploads[0];
        expect(store.hasContent(maslCid)).toBe(true);
        expect(store.getContent(maslCid).meta.pinned).toBe(0);
      });

      it('uses upload filename in the MASL content-disposition', async () => {
        const res = await uploadFile(app, apiSecret, Buffer.from('hi'), 'page.html', 'text/html');
        const { maslCid } = res.body.uploads[0];
        // Path-bearing form (trailing slash) resolves the MASL single-mode document
        // and returns the src resource with MASL-derived headers.
        const raslRes = await request(app).get(`/.well-known/rasl/${maslCid}/`);
        expect(raslRes.status).toBe(200);
        expect(raslRes.headers['content-disposition']).toContain('page.html');
      });

      it('accepts multiple files in one request', async () => {
        const res = await request(app)
          .post('/upload')
          .set(OPERATOR_SECRET_HEADER, apiSecret)
          .attach('files', Buffer.from('file one'), { filename: 'a.txt', contentType: 'text/plain' })
          .attach('files', Buffer.from('file two'), { filename: 'b.txt', contentType: 'text/plain' });
        expect(res.status).toBe(200);
        expect(res.body.uploads).toHaveLength(2);
        expect(res.body.uploads[0].filename).toBe('a.txt');
        expect(res.body.uploads[1].filename).toBe('b.txt');
      });

      it('returns 400 with no files', async () => {
        const res = await request(app).post('/upload').set(OPERATOR_SECRET_HEADER, apiSecret);
        expect(res.status).toBe(400);
      });
    });

    describe('CAR file', () => {
      it('stores MASL and linked data CIDs unpinned', async () => {
        const data = Buffer.from('car content');
        const dataCid = await computeDataCid(data);
        const { cborBytes, maslCid } = await createSingleMasl({
          name: 'f.txt', type: 'text/plain', size: data.length, dataCid,
        });
        const car = await buildCar(maslCid, [[maslCid, Buffer.from(cborBytes)], [dataCid, data]]);

        const res = await uploadCar(app, apiSecret, car);
        expect(res.status).toBe(200);
        expect(res.body.uploads[0].maslCid).toBe(maslCid);
        expect(store.getContent(maslCid).meta.pinned).toBe(0);
        expect(store.getContent(dataCid).meta.pinned).toBe(0);
      });

      it('links data CIDs to the MASL CID', async () => {
        const data = Buffer.from('linked');
        const dataCid = await computeDataCid(data);
        const { cborBytes, maslCid } = await createSingleMasl({
          name: 'f.bin', type: 'application/octet-stream', size: data.length, dataCid,
        });
        const car = await buildCar(maslCid, [[maslCid, Buffer.from(cborBytes)], [dataCid, data]]);
        await uploadCar(app, apiSecret, car);
        expect(store.getContent(dataCid).meta.masl_cid).toBe(maslCid);
      });

      it('accepts a bundle MASL CAR with multiple resources', async () => {
        const idx = Buffer.from('<html/>');
        const css = Buffer.from('body{}');
        const idxCid = await computeDataCid(idx);
        const cssCid = await computeDataCid(css);
        const { cborBytes, maslCid } = await createBundleMasl({
          name: 'site',
          resources: [
            { path: '/', cid: idxCid, size: idx.length, contentType: 'text/html' },
            { path: '/style.css', cid: cssCid, size: css.length, contentType: 'text/css' },
          ],
        });
        const car = await buildCar(maslCid, [
          [maslCid, Buffer.from(cborBytes)], [idxCid, idx], [cssCid, css],
        ]);

        const res = await uploadCar(app, apiSecret, car, 'site.car');
        expect(res.status).toBe(200);
        expect(store.hasContent(idxCid)).toBe(true);
        expect(store.hasContent(cssCid)).toBe(true);
      });

      it('detects CAR by .car filename extension too', async () => {
        const data = Buffer.from('ext detect');
        const dataCid = await computeDataCid(data);
        const { cborBytes, maslCid } = await createSingleMasl({
          name: 'f.bin', type: 'application/octet-stream', size: data.length, dataCid,
        });
        const car = await buildCar(maslCid, [[maslCid, Buffer.from(cborBytes)], [dataCid, data]]);
        const res = await request(app)
          .post('/upload')
          .set(OPERATOR_SECRET_HEADER, apiSecret)
          .attach('files', car, { filename: 'bundle.car', contentType: 'application/octet-stream' });
        expect(res.status).toBe(200);
        expect(res.body.uploads[0].maslCid).toBe(maslCid);
      });

      it('returns 400 if CAR is missing a linked data CID', async () => {
        const data = Buffer.from('missing');
        const dataCid = await computeDataCid(data);
        const { cborBytes, maslCid } = await createSingleMasl({
          name: 'f.txt', type: 'text/plain', size: data.length, dataCid,
        });
        const car = await buildCar(maslCid, [[maslCid, Buffer.from(cborBytes)]]);
        const res = await uploadCar(app, apiSecret, car);
        expect(res.status).toBe(400);
        expect(res.body.missing).toContain(dataCid);
      });

      it('returns 400 if a block has a mismatched CID', async () => {
        const data = Buffer.from('real');
        const dataCid = await computeDataCid(data);
        const { cborBytes, maslCid } = await createSingleMasl({
          name: 'f.txt', type: 'text/plain', size: data.length, dataCid,
        });
        const car = await buildCar(maslCid, [
          [maslCid, Buffer.from(cborBytes)],
          [dataCid, Buffer.from('tampered')],
        ]);
        const res = await uploadCar(app, apiSecret, car);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/mismatch/i);
      });
    });

    describe('mixed batch', () => {
      it('handles a raw file and a CAR in the same request', async () => {
        const rawData = Buffer.from('raw file');
        const carData = Buffer.from('car content');
        const carDataCid = await computeDataCid(carData);
        const { cborBytes, maslCid: carMaslCid } = await createSingleMasl({
          name: 'f.txt', type: 'text/plain', size: carData.length, dataCid: carDataCid,
        });
        const car = await buildCar(carMaslCid, [
          [carMaslCid, Buffer.from(cborBytes)], [carDataCid, carData],
        ]);

        const res = await request(app)
          .post('/upload')
          .set(OPERATOR_SECRET_HEADER, apiSecret)
          .attach('files', rawData, { filename: 'raw.txt', contentType: 'text/plain' })
          .attach('files', car, { filename: 'bundle.car', contentType: 'application/vnd.ipld.car' });

        expect(res.status).toBe(200);
        expect(res.body.uploads).toHaveLength(2);
        expect(res.body.uploads[0].filename).toBe('raw.txt');
        expect(res.body.uploads[1].filename).toBe('bundle.car');
        expect(res.body.uploads[1].maslCid).toBe(carMaslCid);
      });
    });
  });

  describe('POST /pin', () => {
    it('pins an uploaded MASL CID and its linked data CID', async () => {
      const uploadRes = await uploadFile(app, apiSecret, Buffer.from('to pin'), 'p.txt', 'text/plain');
      const { maslCid } = uploadRes.body.uploads[0];

      const pinRes = await request(app)
        .post('/pin')
        .set(OPERATOR_SECRET_HEADER, apiSecret)
        .send({ cids: [maslCid] });

      expect(pinRes.status).toBe(200);
      expect(pinRes.body.pinned).toContain(maslCid);
      expect(store.getContent(maslCid).meta.pinned).toBe(1);

      // The data CID linked from the MASL should also be pinned.
      const dataRow = store.listContent().find(r => r.masl_cid === maslCid && r.cid !== maslCid);
      expect(dataRow).toBeDefined();
      expect(store.getContent(dataRow.cid).meta.pinned).toBe(1);
    });

    it('pinning a data CID also pins its MASL', async () => {
      const uploadRes = await uploadFile(app, apiSecret, Buffer.from('data pin'), 'd.txt', 'text/plain');
      const { maslCid } = uploadRes.body.uploads[0];
      const dataRow = store.listContent().find(r => r.masl_cid === maslCid && r.cid !== maslCid);

      await request(app)
        .post('/pin')
        .set(OPERATOR_SECRET_HEADER, apiSecret)
        .send({ cids: [dataRow.cid] });

      expect(store.getContent(maslCid).meta.pinned).toBe(1);
    });

    it('content is not pinned by upload alone', async () => {
      const uploadRes = await uploadFile(app, apiSecret, Buffer.from('no pin'), 'n.txt', 'text/plain');
      const { maslCid } = uploadRes.body.uploads[0];
      expect(store.getContent(maslCid).meta.pinned).toBe(0);
    });

    it('returns 404 for a CID not in the store', async () => {
      const fakeCid = await computeDataCid(Buffer.from('unknown'));
      const res = await request(app)
        .post('/pin')
        .set(OPERATOR_SECRET_HEADER, apiSecret)
        .send({ cids: [fakeCid] });
      expect(res.status).toBe(404);
    });

    it('returns 400 for missing or empty cids', async () => {
      const r1 = await request(app).post('/pin').set(OPERATOR_SECRET_HEADER, apiSecret).send({});
      expect(r1.status).toBe(400);
      const r2 = await request(app).post('/pin').set(OPERATOR_SECRET_HEADER, apiSecret).send({ cids: [] });
      expect(r2.status).toBe(400);
    });

    it('pinned content is retrievable via RASL', async () => {
      const content = Buffer.from('retrievable');
      const uploadRes = await uploadFile(app, apiSecret, content, 'r.txt', 'text/plain');
      const { maslCid } = uploadRes.body.uploads[0];
      await request(app).post('/pin').set(OPERATOR_SECRET_HEADER, apiSecret).send({ cids: [maslCid] });

      const raslRes = await request(app).get(`/.well-known/rasl/${maslCid}`);
      expect(raslRes.status).toBe(200);
    });
  });

  describe('GET /content', () => {
    it('returns empty result when no content is stored', async () => {
      const res = await request(app).get('/content').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.items).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });

    it('returns correct fields for each item', async () => {
      await uploadFile(app, apiSecret, Buffer.from('hello'), 'h.txt', 'text/plain');
      const res = await request(app).get('/content').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items) {
        expect(typeof item.cid).toBe('string');
        expect(item.size).toBeGreaterThan(0);
        expect(typeof item.pinned).toBe('boolean');
        expect('maslCid' in item).toBe(true);
        expect('lastRequested' in item).toBe(true);
      }
    });

    it('total reflects the number of stored CIDs', async () => {
      await uploadFile(app, apiSecret, Buffer.from('a'), 'a.txt', 'text/plain');
      await uploadFile(app, apiSecret, Buffer.from('b'), 'b.txt', 'text/plain');
      const res = await request(app).get('/content').set(OPERATOR_SECRET_HEADER, apiSecret);
      // each raw upload creates 2 CIDs (data + MASL), so 2 uploads = 4 CIDs
      expect(res.body.total).toBe(4);
      expect(res.body.items).toHaveLength(4);
    });

    it('paginates with default limit of 50', async () => {
      // upload 30 files → 60 CIDs total; default limit is 50, so first page has 50 with a cursor
      for (let i = 0; i < 30; i++) {
        await uploadFile(app, apiSecret, Buffer.from(`file${i}`), `f${i}.txt`, 'text/plain');
      }
      const res = await request(app).get('/content').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(60);
      expect(res.body.items).toHaveLength(50);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it('follows cursor to retrieve the next page', async () => {
      for (let i = 0; i < 30; i++) {
        await uploadFile(app, apiSecret, Buffer.from(`file${i}`), `f${i}.txt`, 'text/plain');
      }
      const page1 = await request(app).get('/content').set(OPERATOR_SECRET_HEADER, apiSecret);
      const cursor = page1.body.nextCursor;

      const page2 = await request(app)
        .get(`/content?cursor=${cursor}`)
        .set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(page2.status).toBe(200);
      expect(page2.body.items.length).toBe(10);
      expect(page2.body.nextCursor).toBeNull();

      // No CID appears in both pages
      const page1Cids = new Set(page1.body.items.map(i => i.cid));
      for (const item of page2.body.items) {
        expect(page1Cids.has(item.cid)).toBe(false);
      }
    });

    it('respects a custom limit', async () => {
      for (let i = 0; i < 5; i++) {
        await uploadFile(app, apiSecret, Buffer.from(`x${i}`), `x${i}.txt`, 'text/plain');
      }
      const res = await request(app).get('/content?limit=3').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.body.items).toHaveLength(3);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it('clamps limit to 200', async () => {
      const res = await request(app).get('/content?limit=9999').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.status).toBe(200);
    });

    it('reflects pinned status correctly', async () => {
      const maslCid = await uploadAndPin(app, apiSecret, Buffer.from('pinned'), 'p.txt');
      const res = await request(app).get('/content').set(OPERATOR_SECRET_HEADER, apiSecret);
      const maslItem = res.body.items.find(i => i.cid === maslCid);
      expect(maslItem).toBeDefined();
      expect(maslItem.pinned).toBe(true);
    });
  });

  describe('DELETE /pin/:cid', () => {
    it('unpins a MASL CID and its linked data CID', async () => {
      const maslCid = await uploadAndPin(app, apiSecret, Buffer.from('to unpin'), 'u.txt');
      const dataRow = store.listContent().find(r => r.masl_cid === maslCid && r.cid !== maslCid);

      await request(app).delete(`/pin/${maslCid}`).set(OPERATOR_SECRET_HEADER, apiSecret);

      expect(store.getContent(maslCid).meta.pinned).toBe(0);
      expect(store.getContent(dataRow.cid).meta.pinned).toBe(0);
    });

    it('unpins via data CID and clears MASL pin too', async () => {
      const maslCid = await uploadAndPin(app, apiSecret, Buffer.from('unpin via data'), 'v.txt');
      const dataRow = store.listContent().find(r => r.masl_cid === maslCid && r.cid !== maslCid);

      await request(app).delete(`/pin/${dataRow.cid}`).set(OPERATOR_SECRET_HEADER, apiSecret);

      expect(store.getContent(maslCid).meta.pinned).toBe(0);
    });

    it('returns 200 for nonexistent CID', async () => {
      const fakeCid = await computeDataCid(Buffer.from('nonexistent'));
      const res = await request(app).delete(`/pin/${fakeCid}`).set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.status).toBe(200);
    });
  });
});

describe('GET /content/:cid', () => {
  let app, store, cleanup, apiSecret;

  beforeEach(() => ({ app, store, cleanup, apiSecret } = makeBaseTestApp()));
  afterEach(() => cleanup());

  it('returns metadata for a held CID', async () => {
    const res = await request(app)
      .post('/upload')
      .set(OPERATOR_SECRET_HEADER, apiSecret)
      .attach('files', Buffer.from('hello'), { filename: 'h.txt', contentType: 'text/plain' });
    const { maslCid } = res.body.uploads[0];

    const r = await request(app).get(`/content/${maslCid}`).set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(r.status).toBe(200);
    expect(r.body.cid).toBe(maslCid);
    expect(typeof r.body.size).toBe('number');
    expect(typeof r.body.pinned).toBe('boolean');
    expect('maslCid' in r.body).toBe(true);
    expect('lastRequested' in r.body).toBe(true);
  });

  it('returns 404 for an unknown CID', async () => {
    const fakeCid = await computeDataCid(Buffer.from('unknown'));
    const r = await request(app).get(`/content/${fakeCid}`).set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(r.status).toBe(404);
  });
});

describe('DELETE /content/:cid', () => {
  let app, store, cleanup, apiSecret;

  beforeEach(() => ({ app, store, cleanup, apiSecret } = makeBaseTestApp()));
  afterEach(() => cleanup());

  it('removes a held data CID', async () => {
    const data = Buffer.from('to delete');
    const dataCid = await computeDataCid(data);
    store.putContent(dataCid, data);

    const r = await request(app).delete(`/content/${dataCid}`).set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toContain(dataCid);
    expect(store.hasContent(dataCid)).toBe(false);
  });

  it('removes a MASL CID and its linked data CID', async () => {
    const res = await request(app)
      .post('/upload')
      .set(OPERATOR_SECRET_HEADER, apiSecret)
      .attach('files', Buffer.from('masl del'), { filename: 'm.txt', contentType: 'text/plain' });
    const { maslCid } = res.body.uploads[0];
    const dataRow = store.listContent().find(r => r.masl_cid === maslCid);

    const r = await request(app).delete(`/content/${maslCid}`).set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(r.status).toBe(200);
    expect(r.body.deleted).toContain(maslCid);
    expect(r.body.deleted).toContain(dataRow.cid);
    expect(store.hasContent(maslCid)).toBe(false);
    expect(store.hasContent(dataRow.cid)).toBe(false);
  });

  it('returns 404 for an unknown CID', async () => {
    const fakeCid = await computeDataCid(Buffer.from('gone'));
    const r = await request(app).delete(`/content/${fakeCid}`).set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(r.status).toBe(404);
  });

  it('removes pinned content', async () => {
    const up = await request(app)
      .post('/upload')
      .set(OPERATOR_SECRET_HEADER, apiSecret)
      .attach('files', Buffer.from('pinned del'), { filename: 'pd.txt', contentType: 'text/plain' });
    const { maslCid } = up.body.uploads[0];
    await request(app).post('/pin').set(OPERATOR_SECRET_HEADER, apiSecret).send({ cids: [maslCid] });

    const r = await request(app).delete(`/content/${maslCid}`).set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(r.status).toBe(200);
    expect(store.hasContent(maslCid)).toBe(false);
  });
});

describe('Operator API CORS', () => {
  const ALLOWED = 'https://admin.example.com';
  const OTHER   = 'https://other.example.com';
  let app, cleanup, apiSecret;

  beforeEach(() => {
    ({ app, cleanup, apiSecret } = makeBaseTestApp({ operatorCorsOrigins: [ALLOWED] }));
  });

  afterEach(() => cleanup());

  it('responds to OPTIONS preflight with 204 and CORS headers for an allowed origin', async () => {
    const res = await request(app)
      .options('/status')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
    expect(res.headers['access-control-allow-headers']).toMatch(new RegExp(OPERATOR_SECRET_HEADER, 'i'));
  });

  it('includes CORS headers on normal requests from an allowed origin', async () => {
    const res = await request(app)
      .get('/status')
      .set('Origin', ALLOWED)
      .set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('sets Vary: Origin when using a specific origin whitelist', async () => {
    const res = await request(app)
      .get('/status')
      .set('Origin', ALLOWED)
      .set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(res.headers['vary']).toMatch(/origin/i);
  });

  it('does not set CORS headers for a disallowed origin', async () => {
    const res = await request(app)
      .get('/status')
      .set('Origin', OTHER)
      .set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not set CORS headers when no Origin header is present', async () => {
    const res = await request(app).get('/status').set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OPTIONS preflight for a disallowed origin returns 204 without CORS headers', async () => {
    const res = await request(app)
      .options('/status')
      .set('Origin', OTHER)
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('wildcard * allows any origin without Vary', async () => {
    const { app: wildcardApp, cleanup: wc } = makeBaseTestApp({ operatorCorsOrigins: ['*'] });
    const res = await request(wildcardApp)
      .get('/status')
      .set('Origin', 'https://anything.example.com')
      .set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['vary'] ?? '').not.toMatch(/origin/i);
    wc();
  });

  it('CORS is disabled when no origins are configured', async () => {
    const { app: noCorApp, cleanup: nc } = makeBaseTestApp({ operatorCorsOrigins: [] });
    const res = await request(noCorApp)
      .get('/status')
      .set('Origin', ALLOWED)
      .set(OPERATOR_SECRET_HEADER, apiSecret);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    nc();
  });
});

describe('Operator API path prefix', () => {
  it('serves operator endpoints under the configured prefix', async () => {
    const { app, cleanup, apiSecret } = makeBaseTestApp({ operatorApiPathPrefix: '/admin' });
    try {
      const ok = await request(app).get('/admin/status').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(ok.status).toBe(200);
      expect(ok.body.domain).toBe('test.example.com');

      const auth = await request(app).get('/admin/status');
      expect(auth.status).toBe(401);
    } finally { cleanup(); }
  });

  it('does not serve operator endpoints at the root when prefix is set', async () => {
    const { app, cleanup, apiSecret } = makeBaseTestApp({ operatorApiPathPrefix: '/admin' });
    try {
      const res = await request(app).get('/status').set(OPERATOR_SECRET_HEADER, apiSecret);
      expect(res.status).toBe(404);
    } finally { cleanup(); }
  });

  it('leaves public RASL endpoints at the root when prefix is set', async () => {
    const bytes = Buffer.from('prefix rasl test');
    const cid = await computeDataCid(bytes);
    const { app, store, cleanup } = makeBaseTestApp({ operatorApiPathPrefix: '/admin' });
    try {
      store.putContent(cid, bytes);
      const res = await request(app).get(`/.well-known/rasl/${cid}`);
      expect(res.status).toBe(200);
    } finally { cleanup(); }
  });
});
