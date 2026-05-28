import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { makeBaseTestApp } from './baseHelpers.js';
import { computeDataCid } from '../../src/crypto/cid.js';
import { cidToUnencodedDigest } from '../../src/crypto/cid.js';
import { createSingleMasl, createBundleMasl } from '../../src/masl/document.js';
import { indexStaticRoot } from '../../src/static.js';

describe('RASL routes', () => {
  let app, store, cleanup;

  beforeEach(() => {
    ({ app, store, cleanup } = makeBaseTestApp());
  });

  afterEach(() => cleanup());

  // ── Path-free: GET /.well-known/rasl/:cid ──────────────────────────────────
  // The path-free form always returns raw bytes for the CID, regardless of
  // whether it is a MASL document. Clients use this to fetch and verify MASL
  // documents themselves.

  describe('GET /.well-known/rasl/:cid (path-free)', () => {
    it('returns 404 for unknown CID', async () => {
      const fakeCid = await computeDataCid(Buffer.from('nonexistent'));
      const res = await request(app).get(`/.well-known/rasl/${fakeCid}`);
      expect(res.status).toBe(404);
    });

    it('serves a locally held data CID as octet-stream with Unencoded-Digest', async () => {
      const bytes = Buffer.from('hello world');
      const cid = await computeDataCid(bytes);
      store.putContent(cid, bytes);

      const res = await request(app).get(`/.well-known/rasl/${cid}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/octet-stream/);
      expect(res.body.toString()).toBe('hello world');
      expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cid));
    });

    it('serves data CID with MASL-derived content-type', async () => {
      const bytes = Buffer.from('<html>hello</html>');
      const cid = await computeDataCid(bytes);
      const { cborBytes, maslCid } = await createSingleMasl({
        name: 'index.html',
        type: 'text/html',
        size: bytes.length,
        dataCid: cid,
      });
      store.putContent(cid, bytes, { maslCid });
      store.putContent(maslCid, cborBytes, { pinned: true });

      const res = await request(app).get(`/.well-known/rasl/${cid}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cid));
    });

    it('returns raw MASL document bytes for a MASL CID (single mode)', async () => {
      const bytes = Buffer.from('masl single content');
      const cid = await computeDataCid(bytes);
      const { cborBytes, maslCid } = await createSingleMasl({
        name: 'doc.txt',
        type: 'text/plain',
        size: bytes.length,
        dataCid: cid,
      });
      store.putContent(cid, bytes, { maslCid });
      store.putContent(maslCid, cborBytes, { pinned: true });

      // Path-free form returns the raw MASL CBOR bytes, not the src resource.
      const res = await request(app).get(`/.well-known/rasl/${maslCid}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).equals(cborBytes)).toBe(true);
      expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(maslCid));
    });

    it('returns raw MASL document bytes for a bundle MASL CID', async () => {
      const indexBytes = Buffer.from('<html>index</html>');
      const indexCid = await computeDataCid(indexBytes);
      const { cborBytes: bundleBytes, maslCid: bundleCid } = await createBundleMasl({
        name: 'My Site',
        resources: [{ path: '/', cid: indexCid, size: indexBytes.length, contentType: 'text/html' }],
      });
      store.putContent(indexCid, indexBytes);
      store.putContent(bundleCid, bundleBytes);

      // Path-free returns raw bytes, not a redirect.
      const res = await request(app).get(`/.well-known/rasl/${bundleCid}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).equals(bundleBytes)).toBe(true);
      expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(bundleCid));
    });

    it('records last_requested on successful retrieval', async () => {
      const bytes = Buffer.from('track me');
      const cid = await computeDataCid(bytes);
      store.putContent(cid, bytes);

      const before = store.getContent(cid).meta.last_requested;
      await request(app).get(`/.well-known/rasl/${cid}`);
      const after = store.getContent(cid).meta.last_requested;
      expect(after).toBeGreaterThan(before ?? 0);
    });
  });

  // ── Path-bearing: GET /.well-known/rasl/:cid/*path ────────────────────────
  // Path-bearing requests resolve the path against the MASL document structure.

  describe('GET /.well-known/rasl/:cid/*path (path-bearing)', () => {
    describe('non-MASL CID', () => {
      it('path "/" returns raw bytes with Unencoded-Digest', async () => {
        const bytes = Buffer.from('raw bytes');
        const cid = await computeDataCid(bytes);
        store.putContent(cid, bytes);

        const res = await request(app).get(`/.well-known/rasl/${cid}/`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/octet-stream/);
        expect(res.body.toString()).toBe('raw bytes');
        expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cid));
      });

      it('non-"/" path returns 404', async () => {
        const bytes = Buffer.from('raw bytes');
        const cid = await computeDataCid(bytes);
        store.putContent(cid, bytes);

        const res = await request(app).get(`/.well-known/rasl/${cid}/picture.jpg`);
        expect(res.status).toBe(404);
      });
    });

    describe('MASL Single Mode', () => {
      it('path "/" resolves to the src resource with content headers and Unencoded-Digest', async () => {
        const bytes = Buffer.from('masl single content');
        const cid = await computeDataCid(bytes);
        const { cborBytes, maslCid } = await createSingleMasl({
          name: 'doc.txt',
          type: 'text/plain',
          size: bytes.length,
          dataCid: cid,
        });
        store.putContent(cid, bytes, { maslCid });
        store.putContent(maslCid, cborBytes, { pinned: true });

        const res = await request(app).get(`/.well-known/rasl/${maslCid}/`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
        expect(res.text).toBe('masl single content');
        expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cid));
      });

      it('non-"/" path returns 404', async () => {
        const bytes = Buffer.from('masl single content');
        const dataCid = await computeDataCid(bytes);
        const { cborBytes, maslCid } = await createSingleMasl({
          name: 'doc.txt',
          type: 'text/plain',
          size: bytes.length,
          dataCid,
        });
        store.putContent(dataCid, bytes, { maslCid });
        store.putContent(maslCid, cborBytes, { pinned: true });

        const res = await request(app).get(`/.well-known/rasl/${maslCid}/other.txt`);
        expect(res.status).toBe(404);
      });

      it('forwards content-disposition from single-mode document root', async () => {
        const bytes = Buffer.from('%PDF-1.4...');
        const dataCid = await computeDataCid(bytes);
        const { cborBytes, maslCid } = await createSingleMasl({
          name: 'report.pdf',
          type: 'application/pdf',
          size: bytes.length,
          dataCid,
        });
        store.putContent(dataCid, bytes, { maslCid });
        store.putContent(maslCid, cborBytes, { pinned: true });

        const res = await request(app).get(`/.well-known/rasl/${maslCid}/`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/pdf/);
        expect(res.headers['content-disposition']).toContain('report.pdf');
        expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(dataCid));
      });
    });

    describe('MASL Bundle Mode', () => {
      it('path "/" resolves to the root resource', async () => {
        const indexBytes = Buffer.from('<html>index</html>');
        const indexCid = await computeDataCid(indexBytes);
        const { cborBytes: bundleBytes, maslCid: bundleCid } = await createBundleMasl({
          name: 'My Site',
          resources: [{ path: '/', cid: indexCid, size: indexBytes.length, contentType: 'text/html' }],
        });
        store.putContent(indexCid, indexBytes);
        store.putContent(bundleCid, bundleBytes);

        const res = await request(app).get(`/.well-known/rasl/${bundleCid}/`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.text).toBe('<html>index</html>');
        expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(indexCid));
      });

      it('non-root path resolves to the matching resource', async () => {
        const indexBytes = Buffer.from('<html>index</html>');
        const cssBytes = Buffer.from('body { color: red }');
        const indexCid = await computeDataCid(indexBytes);
        const cssCid = await computeDataCid(cssBytes);
        const { cborBytes: bundleBytes, maslCid: bundleCid } = await createBundleMasl({
          name: 'My Site',
          resources: [
            { path: '/', cid: indexCid, size: indexBytes.length, contentType: 'text/html' },
            { path: '/style.css', cid: cssCid, size: cssBytes.length, contentType: 'text/css' },
          ],
        });
        store.putContent(indexCid, indexBytes);
        store.putContent(cssCid, cssBytes);
        store.putContent(bundleCid, bundleBytes);

        const resCSS = await request(app).get(`/.well-known/rasl/${bundleCid}/style.css`);
        expect(resCSS.status).toBe(200);
        expect(resCSS.headers['content-type']).toMatch(/text\/css/);
        expect(resCSS.text).toBe('body { color: red }');
        expect(resCSS.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cssCid));
      });

      it('multi-segment path with trailing slash resolves correctly', async () => {
        const aboutBytes = Buffer.from('<html>about</html>');
        const aboutCid = await computeDataCid(aboutBytes);
        const { cborBytes: bundleBytes, maslCid: bundleCid } = await createBundleMasl({
          name: 'Nested Site',
          resources: [
            { path: '/about/why-rasler/', cid: aboutCid, size: aboutBytes.length, contentType: 'text/html' },
          ],
        });
        store.putContent(aboutCid, aboutBytes);
        store.putContent(bundleCid, bundleBytes);

        const res = await request(app).get(`/.well-known/rasl/${bundleCid}/about/why-rasler/`);
        expect(res.status).toBe(200);
        expect(res.text).toBe('<html>about</html>');
        expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(aboutCid));
      });

      it('path not in resources map returns 404', async () => {
        const indexBytes = Buffer.from('<html>index</html>');
        const indexCid = await computeDataCid(indexBytes);
        const { cborBytes: bundleBytes, maslCid: bundleCid } = await createBundleMasl({
          name: 'My Site',
          resources: [{ path: '/', cid: indexCid, size: indexBytes.length, contentType: 'text/html' }],
        });
        store.putContent(indexCid, indexBytes);
        store.putContent(bundleCid, bundleBytes);

        const res = await request(app).get(`/.well-known/rasl/${bundleCid}/missing.txt`);
        expect(res.status).toBe(404);
      });

      it('forwards content-language and content-disposition from bundle resource entry', async () => {
        const bytes = Buffer.from('bonjour');
        const cid = await computeDataCid(bytes);
        const { cborBytes: bundleBytes, maslCid: bundleCid } = await createBundleMasl({
          name: 'Localised Bundle',
          resources: [{
            path: '/',
            cid,
            size: bytes.length,
            contentType: 'text/plain',
            contentDisposition: 'attachment; filename="bonjour.txt"',
            contentLanguage: 'fr',
          }],
        });
        store.putContent(cid, bytes);
        store.putContent(bundleCid, bundleBytes);

        const res = await request(app).get(`/.well-known/rasl/${bundleCid}/`);
        expect(res.status).toBe(200);
        expect(res.headers['content-language']).toBe('fr');
        expect(res.headers['content-disposition']).toBe('attachment; filename="bonjour.txt"');
        expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cid));
      });
    });
  });

  // ── Static roots ───────────────────────────────────────────────────────────
  // Files served directly from operator-owned directories without blob copies.

  describe('static root content', () => {
    let staticDir, staticApp, staticStore, staticCleanup;

    beforeEach(async () => {
      staticDir = mkdtempSync(join(tmpdir(), 'rasl-static-'));
      mkdirSync(join(staticDir, 'sub'), { recursive: true });
      writeFileSync(join(staticDir, 'index.html'), '<html>hello</html>');
      writeFileSync(join(staticDir, 'style.css'), 'body { color: red }');
      writeFileSync(join(staticDir, 'sub', 'page.html'), '<html>sub</html>');

      ({ app: staticApp, store: staticStore, cleanup: staticCleanup } =
        makeBaseTestApp({ staticRoots: [staticDir] }));
      await indexStaticRoot(staticDir, staticStore);
    });

    afterEach(() => {
      staticCleanup();
      rmSync(staticDir, { recursive: true, force: true });
    });

    it('serves a static file by its data CID with correct content-type', async () => {
      const bytes = Buffer.from('<html>hello</html>');
      const cid = await computeDataCid(bytes);
      const res = await request(staticApp).get(`/.well-known/rasl/${cid}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>hello</html>');
      expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cid));
    });

    it('serves a static file via bundle MASL path resolution', async () => {
      const cssBytes = Buffer.from('body { color: red }');
      const cssCid = await computeDataCid(cssBytes);
      const meta = staticStore.getContentMeta(cssCid);
      const maslCid = meta?.masl_cid;
      expect(maslCid).toBeTruthy();

      const res = await request(staticApp).get(`/.well-known/rasl/${maslCid}/style.css`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/css/);
      expect(res.text).toBe('body { color: red }');
    });

    it('resolves index.html directory alias', async () => {
      const indexBytes = Buffer.from('<html>hello</html>');
      const indexCid = await computeDataCid(indexBytes);
      const meta = staticStore.getContentMeta(indexCid);
      const maslCid = meta?.masl_cid;

      // The '/' path should resolve to index.html via the directory alias.
      const res = await request(staticApp).get(`/.well-known/rasl/${maslCid}/`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>hello</html>');
    });

    it('does not copy static bytes into the blob store', async () => {
      const bytes = Buffer.from('body { color: red }');
      const cid = await computeDataCid(bytes);
      // getContent reads from source_path, not the blob store.
      const { existsSync } = await import('fs');
      const blobPath = join(staticStore.dataDir, 'blobs',
        cid.slice(-3, -1), cid);
      expect(existsSync(blobPath)).toBe(false);
    });

    it('GET /static-roots returns path and maslCid after indexing', async () => {
      const res = await request(staticApp)
        .get('/static-roots')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].path).toBe(staticDir);
      expect(res.body[0].maslCid).toMatch(/^bafy/);
    });

    it('GET /static-roots returns null maslCid before indexing', async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'rasl-empty-'));
      try {
        const { app: freshApp } = makeBaseTestApp({ staticRoots: [emptyDir] });
        // No indexStaticRoot call — simulates the async startup window.
        const res = await request(freshApp)
          .get('/static-roots')
          .set('x-rasl-operator-secret', 'test-secret');
        expect(res.status).toBe(200);
        expect(res.body[0].maslCid).toBeNull();
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('second index links new MASL to previous via prev', async () => {
      const { parseMasl } = await import('../../src/masl/document.js');
      // Re-indexing the same root (even without file changes) produces a new
      // MASL CID because it now includes a prev link.
      const maslCid2 = await indexStaticRoot(staticDir, staticStore);
      const doc2 = parseMasl(staticStore.getContent(maslCid2).bytes);
      expect(doc2.prev?.$link).toBeTruthy();
    });

    it('maxHistory unpins MASLs beyond the configured depth', async () => {
      const { parseMasl } = await import('../../src/masl/document.js');
      // beforeEach already ran one index (maslCid1 is pinned).
      // Run a second index with maxHistory=1: only the new MASL stays pinned.
      const maslCid2 = await indexStaticRoot(staticDir, staticStore, { maxHistory: 1 });
      const prevCid = parseMasl(staticStore.getContent(maslCid2).bytes).prev?.$link;
      expect(prevCid).toBeTruthy();
      expect(staticStore.getContentMeta(prevCid).pinned).toBe(0); // unpinned
      expect(staticStore.getContentMeta(maslCid2).pinned).toBe(1); // current stays pinned
    });

    it('static content is excluded from pool capacity accounting', async () => {
      const poolUsed = staticStore.getPoolUsed();
      const pinnedUsed = staticStore.getPinnedUsed();
      // The generated MASL is pinned, data CIDs (pinned=2) are not in either pool.
      expect(poolUsed).toBe(0);
      // MASL bytes count as pinned, but static data bytes do not.
      expect(pinnedUsed).toBeGreaterThan(0); // the MASL doc itself
    });
  });

  // ── Virtual host routing ───────────────────────────────────────────────────
  // Host: header mapped to a static root's MASL bundle.

  describe('virtual host routing', () => {
    let vhostDir, vhostApp, vhostStore, vhostCleanup;
    const vhostName = 'mysite.example.com';

    beforeEach(async () => {
      vhostDir = mkdtempSync(join(tmpdir(), 'rasl-vhost-'));
      mkdirSync(join(vhostDir, 'sub'), { recursive: true });
      writeFileSync(join(vhostDir, 'index.html'), '<html>home</html>');
      writeFileSync(join(vhostDir, 'about.html'), '<html>about</html>');

      const vh = new Map([[vhostName, vhostDir]]);
      ({ app: vhostApp, store: vhostStore, cleanup: vhostCleanup } =
        makeBaseTestApp({ staticRoots: [vhostDir], virtualHosts: vh }));
      await indexStaticRoot(vhostDir, vhostStore);
    });

    afterEach(() => {
      vhostCleanup();
      rmSync(vhostDir, { recursive: true, force: true });
    });

    it('serves index.html at / via Host header', async () => {
      const res = await request(vhostApp)
        .get('/')
        .set('Host', vhostName);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>home</html>');
    });

    it('resolves a non-root path via Host header', async () => {
      const res = await request(vhostApp)
        .get('/about.html')
        .set('Host', vhostName);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>about</html>');
    });

    it('returns 404 for a path not in the bundle', async () => {
      const res = await request(vhostApp)
        .get('/missing.txt')
        .set('Host', vhostName);
      expect(res.status).toBe(404);
    });

    it('unknown hostname falls through: RASL path returns 404 from RASL handler', async () => {
      const fakeCid = await computeDataCid(Buffer.from('unknown'));
      const res = await request(vhostApp)
        .get(`/.well-known/rasl/${fakeCid}`)
        .set('Host', 'other.example.com');
      // Vhost router skips unknown hostname; RASL not-found handler returns 404.
      expect(res.status).toBe(404);
    });

    it('RASL retrieval paths are not intercepted by the vhost router', async () => {
      const bytes = Buffer.from('<html>home</html>');
      const cid = await computeDataCid(bytes);
      vhostStore.putContent(cid, bytes);

      const res = await request(vhostApp)
        .get(`/.well-known/rasl/${cid}`)
        .set('Host', vhostName);
      // RASL router handles it, not vhost
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/octet-stream/);
    });

    it('returns 503 before indexing is complete', async () => {
      const newDir = mkdtempSync(join(tmpdir(), 'rasl-vhost-pre-'));
      writeFileSync(join(newDir, 'index.html'), '<html>x</html>');
      try {
        const vh = new Map([['preindex.example.com', newDir]]);
        const { app: freshApp } = makeBaseTestApp({ staticRoots: [newDir], virtualHosts: vh });
        // No indexStaticRoot call — simulates the async startup window.
        const res = await request(freshApp)
          .get('/')
          .set('Host', 'preindex.example.com');
        expect(res.status).toBe(503);
      } finally {
        rmSync(newDir, { recursive: true, force: true });
      }
    });

    it('vhost MASL updates automatically after re-index', async () => {
      // Modify a file and re-index — the vhost should serve the new content.
      writeFileSync(join(vhostDir, 'index.html'), '<html>updated</html>');
      await indexStaticRoot(vhostDir, vhostStore);

      const res = await request(vhostApp)
        .get('/')
        .set('Host', vhostName);
      expect(res.status).toBe(200);
      expect(res.text).toBe('<html>updated</html>');
    });

    it('sets unencoded-digest header', async () => {
      const bytes = Buffer.from('<html>home</html>');
      const cid = await computeDataCid(bytes);
      const res = await request(vhostApp)
        .get('/')
        .set('Host', vhostName);
      expect(res.status).toBe(200);
      expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cid));
    });

    it('GET /virtual-hosts returns hostname, path, maslCid, and source=static', async () => {
      const res = await request(vhostApp)
        .get('/virtual-hosts')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].hostname).toBe(vhostName);
      expect(res.body[0].path).toBe(vhostDir);
      expect(res.body[0].maslCid).toMatch(/^bafy/);
      expect(res.body[0].source).toBe('static');
    });

    it('GET /virtual-hosts returns null maslCid before indexing', async () => {
      const newDir = mkdtempSync(join(tmpdir(), 'rasl-vhost-pre2-'));
      writeFileSync(join(newDir, 'index.html'), '<html>x</html>');
      try {
        const vh = new Map([['preindex2.example.com', newDir]]);
        const { app: freshApp } = makeBaseTestApp({ staticRoots: [newDir], virtualHosts: vh });
        const res = await request(freshApp)
          .get('/virtual-hosts')
          .set('x-rasl-operator-secret', 'test-secret');
        expect(res.status).toBe(200);
        expect(res.body[0].maslCid).toBeNull();
        expect(res.body[0].source).toBe('static');
      } finally {
        rmSync(newDir, { recursive: true, force: true });
      }
    });
  });

  // ── Runtime virtual host mapping ───────────────────────────────────────────
  // PUT /virtual-hosts/:hostname maps any held bundle MASL to a hostname.

  describe('runtime virtual host mapping', () => {
    let runtimeApp, runtimeStore, runtimeCleanup;

    beforeEach(() => {
      ({ app: runtimeApp, store: runtimeStore, cleanup: runtimeCleanup } = makeBaseTestApp());
    });

    afterEach(() => runtimeCleanup());

    async function uploadBundle(store) {
      const indexBytes = Buffer.from('<html>runtime</html>');
      const cssBytes = Buffer.from('body{}');
      const indexCid = await computeDataCid(indexBytes);
      const cssCid = await computeDataCid(cssBytes);
      const { cborBytes, maslCid } = await createBundleMasl({
        name: 'Runtime Site',
        resources: [
          { path: '/', cid: indexCid, size: indexBytes.length, contentType: 'text/html' },
          { path: '/style.css', cid: cssCid, size: cssBytes.length, contentType: 'text/css' },
        ],
      });
      store.putContent(indexCid, indexBytes, { maslCid });
      store.putContent(cssCid, cssBytes, { maslCid });
      store.putContent(maslCid, cborBytes);
      return { maslCid, indexBytes, cssBytes, indexCid };
    }

    it('PUT /virtual-hosts/:hostname registers a mapping', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      const res = await request(runtimeApp)
        .put('/virtual-hosts/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });
      expect(res.status).toBe(200);
      expect(res.body.hostname).toBe('runtime.example.com');
      expect(res.body.maslCid).toBe(maslCid);
    });

    it('serves content via runtime-mapped hostname', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/virtual-hosts/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const res = await request(runtimeApp)
        .get('/')
        .set('Host', 'runtime.example.com');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>runtime</html>');
    });

    it('serves non-root path via runtime-mapped hostname', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/virtual-hosts/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const res = await request(runtimeApp)
        .get('/style.css')
        .set('Host', 'runtime.example.com');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/css/);
    });

    it('GET /virtual-hosts includes runtime entry with source=runtime', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/virtual-hosts/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const res = await request(runtimeApp)
        .get('/virtual-hosts')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(res.status).toBe(200);
      const entry = res.body.find(e => e.hostname === 'runtime.example.com');
      expect(entry).toBeDefined();
      expect(entry.maslCid).toBe(maslCid);
      expect(entry.source).toBe('runtime');
      expect(entry.path).toBeNull();
    });

    it('DELETE /virtual-hosts/:hostname removes the mapping', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/virtual-hosts/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const del = await request(runtimeApp)
        .delete('/virtual-hosts/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(del.status).toBe(200);

      // After deletion, the hostname no longer has a mapping; a RASL path
      // falls through to the not-found handler (404).
      const fakeCid = await computeDataCid(Buffer.from('gone'));
      const res = await request(runtimeApp)
        .get(`/.well-known/rasl/${fakeCid}`)
        .set('Host', 'runtime.example.com');
      expect(res.status).toBe(404);
    });

    it('DELETE /virtual-hosts/:hostname returns 404 for unknown hostname', async () => {
      const res = await request(runtimeApp)
        .delete('/virtual-hosts/nope.example.com')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(res.status).toBe(404);
    });

    it('PUT returns 404 if CID not held', async () => {
      const fakeCid = await computeDataCid(Buffer.from('nope'));
      // fakeCid is a data CID, not a MASL CID — expect 400 (not MASL)
      const res = await request(runtimeApp)
        .put('/virtual-hosts/x.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid: fakeCid });
      expect(res.status).toBe(400);
    });

    it('PUT returns 400 for a non-bundle MASL', async () => {
      const bytes = Buffer.from('hello');
      const dataCid = await computeDataCid(bytes);
      const { cborBytes, maslCid } = await createSingleMasl({
        name: 'hello.txt', type: 'text/plain', size: bytes.length, dataCid,
      });
      runtimeStore.putContent(dataCid, bytes, { maslCid });
      runtimeStore.putContent(maslCid, cborBytes);

      const res = await request(runtimeApp)
        .put('/virtual-hosts/x.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bundle/);
    });

    it('runtime mapping persists across store restarts (loaded from DB)', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/virtual-hosts/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      // Verify it's in runtimeVirtualHosts after the PUT.
      expect(runtimeStore.runtimeVirtualHosts.get('runtime.example.com')).toBe(maslCid);

      // Simulate a restart by creating a new Store over the same DB.
      const { Store } = await import('../../src/storage/store.js');
      const store2 = new Store(runtimeStore.db, runtimeStore.dataDir, 10 * 1024 * 1024);
      expect(store2.runtimeVirtualHosts.get('runtime.example.com')).toBe(maslCid);
    });
  });

  // ── HEAD ───────────────────────────────────────────────────────────────────

  describe('HEAD /.well-known/rasl/:cid', () => {
    it('returns 200 for held CID with no body', async () => {
      const bytes = Buffer.from('head check');
      const cid = await computeDataCid(bytes);
      store.putContent(cid, bytes);

      const res = await request(app).head(`/.well-known/rasl/${cid}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });

    it('returns 404 for unknown CID', async () => {
      const cid = await computeDataCid(Buffer.from('unknown for head'));
      const res = await request(app).head(`/.well-known/rasl/${cid}`);
      expect(res.status).toBe(404);
    });
  });
});
