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

  describe('mount point routing', () => {
    let mpDir, mpApp, mpStore, mpCleanup;
    const mpHostname = 'mysite.example.com';

    beforeEach(async () => {
      mpDir = mkdtempSync(join(tmpdir(), 'rasl-mp-'));
      mkdirSync(join(mpDir, 'sub'), { recursive: true });
      writeFileSync(join(mpDir, 'index.html'), '<html>home</html>');
      writeFileSync(join(mpDir, 'about.html'), '<html>about</html>');

      const mountPoints = [{ hostname: mpHostname, prefix: '', directory: mpDir }];
      ({ app: mpApp, store: mpStore, cleanup: mpCleanup } =
        makeBaseTestApp({ staticRoots: [mpDir], mountPoints }));
      await indexStaticRoot(mpDir, mpStore);
    });

    afterEach(() => {
      mpCleanup();
      rmSync(mpDir, { recursive: true, force: true });
    });

    it('serves index.html at / via Host header', async () => {
      const res = await request(mpApp)
        .get('/')
        .set('Host', mpHostname);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>home</html>');
    });

    it('resolves a non-root path via Host header', async () => {
      const res = await request(mpApp)
        .get('/about.html')
        .set('Host', mpHostname);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>about</html>');
    });

    it('returns 404 for a path not in the bundle', async () => {
      const res = await request(mpApp)
        .get('/missing.txt')
        .set('Host', mpHostname);
      expect(res.status).toBe(404);
    });

    it('unknown hostname falls through: RASL path returns 404 from RASL handler', async () => {
      const fakeCid = await computeDataCid(Buffer.from('unknown'));
      const res = await request(mpApp)
        .get(`/.well-known/rasl/${fakeCid}`)
        .set('Host', 'other.example.com');
      // Mount-point router skips unknown hostname; RASL not-found handler returns 404.
      expect(res.status).toBe(404);
    });

    it('RASL retrieval paths are not intercepted by the mount-point router', async () => {
      const bytes = Buffer.from('<html>home</html>');
      const cid = await computeDataCid(bytes);
      mpStore.putContent(cid, bytes);

      const res = await request(mpApp)
        .get(`/.well-known/rasl/${cid}`)
        .set('Host', mpHostname);
      // RASL router handles it, not the mount-point router
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/octet-stream/);
    });

    it('returns 503 before indexing is complete', async () => {
      const newDir = mkdtempSync(join(tmpdir(), 'rasl-mp-pre-'));
      writeFileSync(join(newDir, 'index.html'), '<html>x</html>');
      try {
        const mp = [{ hostname: 'preindex.example.com', prefix: '', directory: newDir }];
        const { app: freshApp } = makeBaseTestApp({ staticRoots: [newDir], mountPoints: mp });
        // No indexStaticRoot call — simulates the async startup window.
        const res = await request(freshApp)
          .get('/')
          .set('Host', 'preindex.example.com');
        expect(res.status).toBe(503);
      } finally {
        rmSync(newDir, { recursive: true, force: true });
      }
    });

    it('mount-point MASL updates automatically after re-index', async () => {
      // Modify a file and re-index — the mount point should serve the new content.
      writeFileSync(join(mpDir, 'index.html'), '<html>updated</html>');
      await indexStaticRoot(mpDir, mpStore);

      const res = await request(mpApp)
        .get('/')
        .set('Host', mpHostname);
      expect(res.status).toBe(200);
      expect(res.text).toBe('<html>updated</html>');
    });

    it('sets Link rel=duplicate header pointing to the canonical RASL URL', async () => {
      const res = await request(mpApp)
        .get('/index.html')
        .set('Host', mpHostname);
      expect(res.status).toBe(200);
      const link = res.headers['link'];
      expect(link).toBeDefined();
      expect(link).toMatch(/rel="duplicate"/);
      expect(link).toMatch(/https:\/\/test\.example\.com\/\.well-known\/rasl\//);
      expect(link).toContain('/index.html>');
    });

    it('sets unencoded-digest header', async () => {
      const bytes = Buffer.from('<html>home</html>');
      const cid = await computeDataCid(bytes);
      const res = await request(mpApp)
        .get('/')
        .set('Host', mpHostname);
      expect(res.status).toBe(200);
      expect(res.headers['unencoded-digest']).toBe(cidToUnencodedDigest(cid));
    });

    it('GET /mount-points returns hostname, mountPath, path, maslCid, and source=static', async () => {
      const res = await request(mpApp)
        .get('/mount-points')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].hostname).toBe(mpHostname);
      expect(res.body[0].mountPath).toBe('/');
      expect(res.body[0].path).toBe(mpDir);
      expect(res.body[0].maslCid).toMatch(/^bafy/);
      expect(res.body[0].source).toBe('static');
    });

    it('GET /mount-points returns null maslCid before indexing', async () => {
      const newDir = mkdtempSync(join(tmpdir(), 'rasl-mp-pre2-'));
      writeFileSync(join(newDir, 'index.html'), '<html>x</html>');
      try {
        const mp = [{ hostname: 'preindex2.example.com', prefix: '', directory: newDir }];
        const { app: freshApp } = makeBaseTestApp({ staticRoots: [newDir], mountPoints: mp });
        const res = await request(freshApp)
          .get('/mount-points')
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
  // PUT /mount-points/:hostname maps any held bundle MASL to a hostname.

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

    it('PUT /mount-points/:hostname registers a mapping', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      const res = await request(runtimeApp)
        .put('/mount-points/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });
      expect(res.status).toBe(200);
      expect(res.body.hostname).toBe('runtime.example.com');
      expect(res.body.maslCid).toBe(maslCid);
    });

    it('serves content via runtime-mapped hostname', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/mount-points/runtime.example.com')
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
        .put('/mount-points/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const res = await request(runtimeApp)
        .get('/style.css')
        .set('Host', 'runtime.example.com');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/css/);
    });

    it('GET /mount-points includes runtime entry with source=runtime', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/mount-points/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const res = await request(runtimeApp)
        .get('/mount-points')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(res.status).toBe(200);
      const entry = res.body.find(e => e.hostname === 'runtime.example.com');
      expect(entry).toBeDefined();
      expect(entry.maslCid).toBe(maslCid);
      expect(entry.source).toBe('runtime');
      expect(entry.path).toBeNull();
    });

    it('DELETE /mount-points/:hostname removes the mapping', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/mount-points/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const del = await request(runtimeApp)
        .delete('/mount-points/runtime.example.com')
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

    it('DELETE /mount-points/:hostname returns 404 for unknown hostname', async () => {
      const res = await request(runtimeApp)
        .delete('/mount-points/nope.example.com')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(res.status).toBe(404);
    });

    it('PUT returns 404 if CID not held', async () => {
      const fakeCid = await computeDataCid(Buffer.from('nope'));
      // fakeCid is a data CID, not a MASL CID — expect 400 (not MASL)
      const res = await request(runtimeApp)
        .put('/mount-points/x.example.com')
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
        .put('/mount-points/x.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bundle/);
    });

    it('runtime mapping persists across store restarts (loaded from DB)', async () => {
      const { maslCid } = await uploadBundle(runtimeStore);
      await request(runtimeApp)
        .put('/mount-points/runtime.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      // Verify it's in runtimeMountPoints after the PUT.
      const mp = runtimeStore.runtimeMountPoints.find(m => m.hostname === 'runtime.example.com' && m.prefix === '');
      expect(mp?.maslCid).toBe(maslCid);

      // Simulate a restart by creating a new Store over the same DB.
      const { Store } = await import('../../src/storage/store.js');
      const store2 = new Store(runtimeStore.db, runtimeStore.dataDir, 10 * 1024 * 1024);
      const mp2 = store2.runtimeMountPoints.find(m => m.hostname === 'runtime.example.com' && m.prefix === '');
      expect(mp2?.maslCid).toBe(maslCid);
    });
  });

  // ── Static mount with path prefix ─────────────────────────────────────────
  // Mount a bundle at hostname/prefix so only requests under that prefix are
  // handled; the prefix is stripped before looking up the MASL resource path.

  describe('static mount point with path prefix', () => {
    let prefixDir, prefixApp, prefixStore, prefixCleanup;
    const prefixHost = 'site.example.com';
    const prefix = '/app';

    beforeEach(async () => {
      prefixDir = mkdtempSync(join(tmpdir(), 'rasl-prefix-'));
      writeFileSync(join(prefixDir, 'index.html'), '<html>app</html>');
      writeFileSync(join(prefixDir, 'style.css'), 'body{}');

      const mountPoints = [{ hostname: prefixHost, prefix, directory: prefixDir }];
      ({ app: prefixApp, store: prefixStore, cleanup: prefixCleanup } =
        makeBaseTestApp({ staticRoots: [prefixDir], mountPoints }));
      await indexStaticRoot(prefixDir, prefixStore);
    });

    afterEach(() => {
      prefixCleanup();
      rmSync(prefixDir, { recursive: true, force: true });
    });

    it('serves a file at /prefix/file.html', async () => {
      const res = await request(prefixApp)
        .get('/app/index.html')
        .set('Host', prefixHost);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<html>app</html>');
    });

    it('serves the root resource at /prefix/', async () => {
      const res = await request(prefixApp)
        .get('/app/')
        .set('Host', prefixHost);
      expect(res.status).toBe(200);
      expect(res.text).toBe('<html>app</html>');
    });

    it('returns 404 for a file not in the bundle', async () => {
      const res = await request(prefixApp)
        .get('/app/missing.txt')
        .set('Host', prefixHost);
      expect(res.status).toBe(404);
    });

    it('falls through for paths not under the prefix', async () => {
      const fakeCid = await computeDataCid(Buffer.from('other'));
      // Use a RASL path so the not-found handler returns 404 (not the operator router's 401).
      const res = await request(prefixApp)
        .get(`/.well-known/rasl/${fakeCid}`)
        .set('Host', prefixHost);
      expect(res.status).toBe(404);
    });

    it('Link header uses the stripped MASL path, not the full request path', async () => {
      const res = await request(prefixApp)
        .get('/app/index.html')
        .set('Host', prefixHost);
      expect(res.status).toBe(200);
      const link = res.headers['link'];
      expect(link).toMatch(/rel="duplicate"/);
      // Must contain /index.html (stripped), not /app/index.html
      expect(link).toContain('/index.html>');
      expect(link).not.toContain('/app/index.html');
    });

    it('GET /mount-points shows mountPath for prefixed static entry', async () => {
      const res = await request(prefixApp)
        .get('/mount-points')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].hostname).toBe(prefixHost);
      expect(res.body[0].mountPath).toBe('/app');
      expect(res.body[0].source).toBe('static');
    });

    it('longer prefix wins when two static mounts share a hostname', async () => {
      const rootDir = mkdtempSync(join(tmpdir(), 'rasl-root-'));
      writeFileSync(join(rootDir, 'index.html'), '<html>root</html>');
      try {
        // Longer prefix must come first — mirrors what the config parser produces.
        const mountPoints = [
          { hostname: prefixHost, prefix: '/app', directory: prefixDir },
          { hostname: prefixHost, prefix: '', directory: rootDir },
        ];
        const { app: twoApp, store: twoStore, cleanup: twoCleanup } =
          makeBaseTestApp({ staticRoots: [rootDir, prefixDir], mountPoints });
        await indexStaticRoot(rootDir, twoStore);
        await indexStaticRoot(prefixDir, twoStore);
        try {
          const appRes = await request(twoApp).get('/app/index.html').set('Host', prefixHost);
          expect(appRes.status).toBe(200);
          expect(appRes.text).toBe('<html>app</html>');

          const rootRes = await request(twoApp).get('/index.html').set('Host', prefixHost);
          expect(rootRes.status).toBe(200);
          expect(rootRes.text).toBe('<html>root</html>');
        } finally { twoCleanup(); }
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  // ── Runtime mount with path prefix ────────────────────────────────────────
  // PUT /mount-points/:hostname/*prefix and DELETE /mount-points/:hostname/*prefix

  describe('runtime virtual host mapping with path prefix', () => {
    let runtimePrefixApp, runtimePrefixStore, runtimePrefixCleanup;

    beforeEach(() => {
      ({ app: runtimePrefixApp, store: runtimePrefixStore, cleanup: runtimePrefixCleanup } =
        makeBaseTestApp());
    });

    afterEach(() => runtimePrefixCleanup());

    async function uploadBundle(store) {
      const indexBytes = Buffer.from('<html>prefixed</html>');
      const cssBytes = Buffer.from('a{}');
      const indexCid = await computeDataCid(indexBytes);
      const cssCid = await computeDataCid(cssBytes);
      const { cborBytes, maslCid } = await createBundleMasl({
        name: 'Prefixed Site',
        resources: [
          { path: '/', cid: indexCid, size: indexBytes.length, contentType: 'text/html' },
          { path: '/style.css', cid: cssCid, size: cssBytes.length, contentType: 'text/css' },
        ],
      });
      store.putContent(indexCid, indexBytes, { maslCid });
      store.putContent(cssCid, cssBytes, { maslCid });
      store.putContent(maslCid, cborBytes);
      return { maslCid, indexBytes, cssBytes };
    }

    it('PUT with path prefix in URL registers at that path prefix', async () => {
      const { maslCid } = await uploadBundle(runtimePrefixStore);
      const res = await request(runtimePrefixApp)
        .put('/mount-points/mp.example.com/app')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });
      expect(res.status).toBe(200);
      expect(res.body.hostname).toBe('mp.example.com');
      expect(res.body.mountPath).toBe('/app');
      expect(res.body.maslCid).toBe(maslCid);
    });

    it('serves content at /prefix/* after PUT with path prefix in URL', async () => {
      const { maslCid } = await uploadBundle(runtimePrefixStore);
      await request(runtimePrefixApp)
        .put('/mount-points/mp.example.com/app')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const res = await request(runtimePrefixApp)
        .get('/app/')
        .set('Host', 'mp.example.com');
      expect(res.status).toBe(200);
      expect(res.text).toBe('<html>prefixed</html>');
    });

    it('strips prefix from the Link header path', async () => {
      const { maslCid } = await uploadBundle(runtimePrefixStore);
      await request(runtimePrefixApp)
        .put('/mount-points/mp.example.com/app')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const res = await request(runtimePrefixApp)
        .get('/app/style.css')
        .set('Host', 'mp.example.com');
      expect(res.status).toBe(200);
      const link = res.headers['link'];
      expect(link).toContain('/style.css>');
      expect(link).not.toContain('/app/style.css');
    });

    it('falls through for paths outside the prefix', async () => {
      const { maslCid } = await uploadBundle(runtimePrefixStore);
      await request(runtimePrefixApp)
        .put('/mount-points/mp.example.com/app')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const fakeCid = await computeDataCid(Buffer.from('nope'));
      // Use a RASL path so the not-found handler returns 404 (not the operator router's 401).
      const res = await request(runtimePrefixApp)
        .get(`/.well-known/rasl/${fakeCid}`)
        .set('Host', 'mp.example.com');
      expect(res.status).toBe(404);
    });

    it('DELETE with path prefix in URL removes only that prefix mapping', async () => {
      const { maslCid } = await uploadBundle(runtimePrefixStore);
      await request(runtimePrefixApp)
        .put('/mount-points/mp.example.com/app')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const del = await request(runtimePrefixApp)
        .delete('/mount-points/mp.example.com/app')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(del.status).toBe(200);

      // After deletion the mount point is gone from the store.
      expect(runtimePrefixStore.runtimeMountPoints.some(m => m.hostname === 'mp.example.com')).toBe(false);
    });

    it('DELETE without path prefix targets the root mapping', async () => {
      const { maslCid } = await uploadBundle(runtimePrefixStore);
      await request(runtimePrefixApp)
        .put('/mount-points/mp2.example.com')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const del = await request(runtimePrefixApp)
        .delete('/mount-points/mp2.example.com')
        .set('x-rasl-operator-secret', 'test-secret');
      expect(del.status).toBe(200);
      expect(runtimePrefixStore.runtimeMountPoints.some(m => m.hostname === 'mp2.example.com')).toBe(false);
    });

    it('GET /mount-points shows mountPath for runtime entry', async () => {
      const { maslCid } = await uploadBundle(runtimePrefixStore);
      await request(runtimePrefixApp)
        .put('/mount-points/mp.example.com/app')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const res = await request(runtimePrefixApp)
        .get('/mount-points')
        .set('x-rasl-operator-secret', 'test-secret');
      const entry = res.body.find(e => e.hostname === 'mp.example.com');
      expect(entry).toBeDefined();
      expect(entry.mountPath).toBe('/app');
      expect(entry.source).toBe('runtime');
    });

    it('runtime mount with prefix persists across store restarts', async () => {
      const { maslCid } = await uploadBundle(runtimePrefixStore);
      await request(runtimePrefixApp)
        .put('/mount-points/mp.example.com/app')
        .set('x-rasl-operator-secret', 'test-secret')
        .send({ maslCid });

      const { Store } = await import('../../src/storage/store.js');
      const store2 = new Store(runtimePrefixStore.db, runtimePrefixStore.dataDir, 10 * 1024 * 1024);
      const mp = store2.runtimeMountPoints.find(m => m.hostname === 'mp.example.com' && m.prefix === '/app');
      expect(mp?.maslCid).toBe(maslCid);
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
