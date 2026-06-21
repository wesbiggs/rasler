import { describe, it, expect } from 'vitest';
import {
  createSingleMasl,
  createBundleMasl,
  parseMasl,
  maslLinkedCids,
  maslContentHeaders,
  maslIsBundle,
  resolveBundlePath,
  resolveBundleEntry,
} from '../../src/masl/document.js';
import { computeDataCid } from '../../src/crypto/cid.js';

async function makeDataCid(str) {
  return computeDataCid(Buffer.from(str));
}

describe('createSingleMasl', () => {
  it('creates a MASL document with correct fields', async () => {
    const dataCid = await makeDataCid('hello world');
    const { doc, cborBytes, maslCid } = await createSingleMasl({
      name: 'hello.txt',
      type: 'text/plain',
      size: 11,
      dataCid,
    });
    expect(doc.name).toBe('hello.txt');
    expect(doc.type).toBe('text/plain');
    expect(doc['content-length']).toBe(11);
    expect(doc['content-type']).toBe('text/plain');
    expect(doc['content-disposition']).toContain('hello.txt');
    expect(doc.src).toEqual({ $link: dataCid });
    expect(cborBytes).toBeInstanceOf(Uint8Array);
    expect(maslCid).toMatch(/^b[a-z2-7]+=*$/);
  });

  it('is deterministic', async () => {
    const dataCid = await makeDataCid('same input');
    const r1 = await createSingleMasl({ name: 'f.txt', type: 'text/plain', size: 10, dataCid });
    const r2 = await createSingleMasl({ name: 'f.txt', type: 'text/plain', size: 10, dataCid });
    expect(r1.maslCid).toBe(r2.maslCid);
  });

  it('different content produces different MASL CID', async () => {
    const a = await makeDataCid('aaa');
    const b = await makeDataCid('bbb');
    const r1 = await createSingleMasl({ name: 'f.txt', type: 'text/plain', size: 3, dataCid: a });
    const r2 = await createSingleMasl({ name: 'f.txt', type: 'text/plain', size: 3, dataCid: b });
    expect(r1.maslCid).not.toBe(r2.maslCid);
  });
});

describe('createBundleMasl', () => {
  it('creates a bundle MASL with resource map using $link', async () => {
    const indexCid = await makeDataCid('<html>index</html>');
    const cssCid = await makeDataCid('body { color: red }');
    const { doc, maslCid } = await createBundleMasl({
      name: 'My Site',
      resources: [
        { path: '/', cid: indexCid, size: 18, contentType: 'text/html' },
        { path: '/style.css', cid: cssCid, size: 19, contentType: 'text/css' },
      ],
    });
    expect(doc.name).toBe('My Site');
    expect(doc.type).toBeUndefined();
    expect(doc.resources['/'].src).toEqual({ $link: indexCid });
    expect(doc.resources['/style.css'].src).toEqual({ $link: cssCid });
    expect(doc.resources['/']['content-type']).toBe('text/html');
    expect(doc.resources['/style.css']['content-type']).toBe('text/css');
    expect(doc.resources['/']['content-length']).toBe(18);
    expect(maslCid).toMatch(/^b[a-z2-7]+=*$/);
  });

  it('defaults content-type to application/octet-stream when omitted', async () => {
    const c = await makeDataCid('bin');
    const { doc } = await createBundleMasl({
      name: 'Bundle',
      resources: [{ path: '/', cid: c, size: 3 }],
    });
    expect(doc.resources['/']['content-type']).toBe('application/octet-stream');
  });
});

describe('parseMasl', () => {
  it('round-trips a single MASL document', async () => {
    const dataCid = await makeDataCid('round trip');
    const { cborBytes } = await createSingleMasl({
      name: 'test.txt',
      type: 'text/plain',
      size: 10,
      dataCid,
    });
    const parsed = parseMasl(cborBytes);
    expect(parsed.name).toBe('test.txt');
    expect(parsed.type).toBe('text/plain');
    expect(parsed['content-length']).toBe(10);
    expect(parsed.src).toEqual({ $link: dataCid });
  });

  it('round-trips a bundle MASL document', async () => {
    const c = await makeDataCid('page');
    const { cborBytes } = await createBundleMasl({
      name: 'Bundle',
      resources: [{ path: '/', cid: c, size: 4, contentType: 'text/html' }],
    });
    const parsed = parseMasl(cborBytes);
    expect(parsed.resources['/'].src).toEqual({ $link: c });
    expect(parsed.resources['/']['content-length']).toBe(4);
    expect(parsed.resources['/']['content-type']).toBe('text/html');
  });
});

describe('maslLinkedCids', () => {
  it('returns the data CID for single mode', async () => {
    const dataCid = await makeDataCid('linked');
    const { doc } = await createSingleMasl({
      name: 'linked.txt',
      type: 'text/plain',
      size: 6,
      dataCid,
    });
    const links = maslLinkedCids(doc);
    expect(links).toHaveLength(1);
    expect(links[0].cid).toBe(dataCid);
    expect(links[0].size).toBe(6);
  });

  it('returns all resource CIDs for bundle mode', async () => {
    const c1 = await makeDataCid('c1');
    const c2 = await makeDataCid('c2');
    const { doc } = await createBundleMasl({
      name: 'Bundle',
      resources: [
        { path: '/', cid: c1, size: 2, contentType: 'text/html' },
        { path: '/about', cid: c2, size: 2, contentType: 'text/html' },
      ],
    });
    const links = maslLinkedCids(doc);
    expect(links).toHaveLength(2);
    const cids = links.map(l => l.cid);
    expect(cids).toContain(c1);
    expect(cids).toContain(c2);
  });
});

describe('maslContentHeaders', () => {
  it('returns content-type and content-disposition', async () => {
    const dataCid = await makeDataCid('headers test');
    const { doc } = await createSingleMasl({
      name: 'page.html',
      type: 'text/html',
      size: 12,
      dataCid,
    });
    const headers = maslContentHeaders(doc);
    expect(headers['content-type']).toBe('text/html');
    expect(headers['content-disposition']).toContain('page.html');
  });

  it('forwards content-encoding and content-language when present', async () => {
    const dataCid = await makeDataCid('compressed');
    const { doc } = await createSingleMasl({
      name: 'data.json',
      type: 'application/json',
      size: 10,
      dataCid,
      contentEncoding: 'gzip',
      contentLanguage: 'fr',
    });
    const headers = maslContentHeaders(doc);
    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['content-language']).toBe('fr');
  });

  it('omits absent optional headers', async () => {
    const dataCid = await makeDataCid('no extras');
    const { doc } = await createSingleMasl({ name: 'f.bin', type: 'application/octet-stream', size: 8, dataCid });
    const headers = maslContentHeaders(doc);
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['content-language']).toBeUndefined();
  });

  it('defaults content-type to application/octet-stream when absent', async () => {
    const headers = maslContentHeaders({});
    expect(headers['content-type']).toBe('application/octet-stream');
  });
});

describe('resolveBundlePath', () => {
  it('resolves / to root resource CID', async () => {
    const indexCid = await makeDataCid('index');
    const { doc } = await createBundleMasl({
      name: 'Site',
      resources: [{ path: '/', cid: indexCid, size: 5, contentType: 'text/html' }],
    });
    expect(resolveBundlePath(doc, '/')).toBe(indexCid);
    expect(resolveBundlePath(doc, '')).toBe(indexCid);
    expect(resolveBundlePath(doc, null)).toBe(indexCid);
  });

  it('resolves named paths', async () => {
    const cssCid = await makeDataCid('css');
    const indexCid = await makeDataCid('index');
    const { doc } = await createBundleMasl({
      name: 'Site',
      resources: [
        { path: '/', cid: indexCid, size: 5, contentType: 'text/html' },
        { path: '/style.css', cid: cssCid, size: 3, contentType: 'text/css' },
      ],
    });
    expect(resolveBundlePath(doc, '/style.css')).toBe(cssCid);
  });

  it('returns null for single-mode doc', async () => {
    const dataCid = await makeDataCid('single');
    const { doc } = await createSingleMasl({ name: 'f', type: 'text/plain', size: 6, dataCid });
    expect(resolveBundlePath(doc, '/')).toBeNull();
  });

  it('returns null for missing path', async () => {
    const c = await makeDataCid('c');
    const { doc } = await createBundleMasl({
      name: 'Site',
      resources: [{ path: '/', cid: c, size: 1, contentType: 'text/html' }],
    });
    expect(resolveBundlePath(doc, '/missing')).toBeNull();
  });
});

describe('resolveBundleEntry', () => {
  it('returns cid and headers for a resolved path', async () => {
    const cssCid = await makeDataCid('css content');
    const { doc } = await createBundleMasl({
      name: 'Site',
      resources: [{ path: '/style.css', cid: cssCid, size: 11, contentType: 'text/css' }],
    });
    const entry = resolveBundleEntry(doc, '/style.css');
    expect(entry).not.toBeNull();
    expect(entry.cid).toBe(cssCid);
    expect(entry.headers['content-type']).toBe('text/css');
  });

  it('includes all present HTTP headers in the headers object', async () => {
    const c = await makeDataCid('encoded');
    const { doc } = await createBundleMasl({
      name: 'Site',
      resources: [{
        path: '/data.gz',
        cid: c,
        size: 7,
        contentType: 'application/json',
        contentDisposition: 'attachment; filename="data.json"',
        contentEncoding: 'gzip',
        contentLanguage: 'en-US',
      }],
    });
    const entry = resolveBundleEntry(doc, '/data.gz');
    expect(entry.headers['content-type']).toBe('application/json');
    expect(entry.headers['content-disposition']).toBe('attachment; filename="data.json"');
    expect(entry.headers['content-encoding']).toBe('gzip');
    expect(entry.headers['content-language']).toBe('en-US');
  });

  it('omits absent optional headers', async () => {
    const c = await makeDataCid('plain');
    const { doc } = await createBundleMasl({
      name: 'Site',
      resources: [{ path: '/', cid: c, size: 5, contentType: 'text/html' }],
    });
    const entry = resolveBundleEntry(doc, '/');
    expect(entry.headers['content-encoding']).toBeUndefined();
    expect(entry.headers['content-language']).toBeUndefined();
    expect(entry.headers['content-disposition']).toBeUndefined();
  });

  it('returns null for missing path', async () => {
    const c = await makeDataCid('x');
    const { doc } = await createBundleMasl({
      name: 'Site',
      resources: [{ path: '/', cid: c, size: 1, contentType: 'text/html' }],
    });
    expect(resolveBundleEntry(doc, '/nope')).toBeNull();
  });

  it('returns null for single-mode doc', async () => {
    const c = await makeDataCid('x');
    const { doc } = await createSingleMasl({ name: 'f', type: 'text/plain', size: 1, dataCid: c });
    expect(resolveBundleEntry(doc, '/')).toBeNull();
  });
});

describe('maslIsBundle', () => {
  it('returns true for bundle', async () => {
    const c = await makeDataCid('x');
    const { doc } = await createBundleMasl({ name: 'b', resources: [{ path: '/', cid: c, size: 1, contentType: 'text/html' }] });
    expect(maslIsBundle(doc)).toBe(true);
  });

  it('returns false for single', async () => {
    const c = await makeDataCid('x');
    const { doc } = await createSingleMasl({ name: 'f', type: 'text/plain', size: 1, dataCid: c });
    expect(maslIsBundle(doc)).toBe(false);
  });
});
