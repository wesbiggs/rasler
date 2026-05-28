import { describe, it, expect } from '@jest/globals';
import { computeDataCid, computeMaslCid, getRingPosition, cidToUnencodedDigest } from '../../src/crypto/cid.js';

describe('computeDataCid', () => {
  it('produces a deterministic CIDv1 for known input', async () => {
    const bytes = Buffer.from('hello world');
    const cid = await computeDataCid(bytes);
    expect(cid).toMatch(/^b[a-z2-7]+=*$/);
    const cid2 = await computeDataCid(bytes);
    expect(cid).toBe(cid2);
  });

  it('produces different CIDs for different inputs', async () => {
    const a = await computeDataCid(Buffer.from('foo'));
    const b = await computeDataCid(Buffer.from('bar'));
    expect(a).not.toBe(b);
  });

  it('empty bytes produce a valid CID', async () => {
    const cid = await computeDataCid(Buffer.alloc(0));
    expect(typeof cid).toBe('string');
    expect(cid.length).toBeGreaterThan(10);
  });
});

describe('computeMaslCid', () => {
  it('produces a deterministic CIDv1 for CBOR bytes', async () => {
    const bytes = Buffer.from([0xa0]); // CBOR empty map
    const cid = await computeMaslCid(bytes);
    expect(cid).toMatch(/^b[a-z2-7]+=*$/);
    expect(cid).toBe(await computeMaslCid(bytes));
  });

  it('data and MASL CIDs differ for the same bytes due to different codec', async () => {
    const bytes = Buffer.from('test');
    const dataCid = await computeDataCid(bytes);
    const maslCid = await computeMaslCid(bytes);
    expect(dataCid).not.toBe(maslCid);
  });
});

describe('cidToUnencodedDigest', () => {
  it('returns a sha-256 Unencoded-Digest string for a data CID', async () => {
    const bytes = Buffer.from('hello world');
    const cid = await computeDataCid(bytes);
    const digest = cidToUnencodedDigest(cid);
    expect(digest).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
  });

  it('digest value matches the SHA-256 of the original bytes', async () => {
    const bytes = Buffer.from('hello world');
    const cid = await computeDataCid(bytes);
    const { sha256 } = await import('multiformats/hashes/sha2');
    const hash = await sha256.digest(bytes);
    const expected = 'sha-256=:' + Buffer.from(hash.digest).toString('base64') + ':';
    expect(cidToUnencodedDigest(cid)).toBe(expected);
  });

  it('works for MASL (dag-cbor) CIDs too', async () => {
    const bytes = Buffer.from([0xa0]); // CBOR empty map
    const cid = await computeMaslCid(bytes);
    const digest = cidToUnencodedDigest(cid);
    expect(digest).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
  });

  it('produces different digests for different CIDs', async () => {
    const a = await computeDataCid(Buffer.from('foo'));
    const b = await computeDataCid(Buffer.from('bar'));
    expect(cidToUnencodedDigest(a)).not.toBe(cidToUnencodedDigest(b));
  });
});

describe('getRingPosition', () => {
  it('extracts a BigInt ring position from a CID', async () => {
    const cid = await computeDataCid(Buffer.from('ring test'));
    const pos = getRingPosition(cid);
    expect(typeof pos).toBe('bigint');
    expect(pos).toBeGreaterThan(0n);
    expect(pos).toBeLessThan(2n ** 256n);
  });

  it('same CID gives same position', async () => {
    const cid = await computeDataCid(Buffer.from('stable'));
    expect(getRingPosition(cid)).toBe(getRingPosition(cid));
  });

  it('different CIDs give different positions', async () => {
    const a = await computeDataCid(Buffer.from('a'));
    const b = await computeDataCid(Buffer.from('b'));
    expect(getRingPosition(a)).not.toBe(getRingPosition(b));
  });
});
