import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb } from '../../src/storage/db.js';
import { makeLocalDb } from '../../src/storage/local-db.js';
import { makeLocalBlobs } from '../../src/storage/local-blobs.js';
import { Store } from '../../src/storage/store.js';

function makeTestStore(totalCapacity = 10 * 1024 * 1024) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rasler-test-'));
  const db = makeLocalDb(openDb(dataDir));
  const blobs = makeLocalBlobs(dataDir);
  const store = new Store(db, blobs, totalCapacity);
  return { store, dataDir };
}

describe('Store', () => {
  let store, dataDir;

  beforeEach(() => {
    ({ store, dataDir } = makeTestStore());
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('content operations', () => {
    it('puts and gets content', async () => {
      const bytes = Buffer.from('hello');
      await store.putContent('BCID1', bytes);
      const result = await store.getContent('BCID1');
      expect(result).not.toBeNull();
      expect(result.bytes.toString()).toBe('hello');
      expect(result.meta.cid).toBe('BCID1');
      expect(result.meta.size).toBe(5);
    });

    it('hasContent returns true/false correctly', async () => {
      expect(await store.hasContent('BCID_MISSING')).toBe(false);
      await store.putContent('BCID2', Buffer.from('data'));
      expect(await store.hasContent('BCID2')).toBe(true);
    });

    it('listContent returns all stored CIDs', async () => {
      await store.putContent('BCID_A', Buffer.from('a'));
      await store.putContent('BCID_B', Buffer.from('b'));
      const list = await store.listContent();
      expect(list.map(r => r.cid)).toEqual(expect.arrayContaining(['BCID_A', 'BCID_B']));
    });

    it('deleteContent removes entry', async () => {
      await store.putContent('BCID3', Buffer.from('del'));
      await store.deleteContent('BCID3');
      expect(await store.hasContent('BCID3')).toBe(false);
      expect(await store.getContent('BCID3')).toBeNull();
    });

    it('stores maslCid association', async () => {
      await store.putContent('BCID_DATA', Buffer.from('x'), { maslCid: 'BCID_MASL' });
      const result = await store.getContent('BCID_DATA');
      expect(result.meta.masl_cid).toBe('BCID_MASL');
    });

    it('pinned flag is stored', async () => {
      await store.putContent('BCID_PIN', Buffer.from('pinned'), { pinned: true });
      const result = await store.getContent('BCID_PIN');
      expect(result.meta.pinned).toBe(1);
    });
  });

  describe('capacity', () => {
    it('getPoolUsed reflects unpinned content size', async () => {
      await store.putContent('P1', Buffer.from('aaaaa')); // 5 bytes, unpinned
      await store.putContent('P2', Buffer.from('bbb'), { pinned: true }); // 3 bytes, pinned
      expect(await store.getPoolUsed()).toBe(5);
      expect(await store.getPinnedUsed()).toBe(3);
    });

    it('getPoolAvailable decreases with unpinned pool usage', async () => {
      const { store: s, dataDir: d } = makeTestStore(1024);
      try {
        await s.putContent('X1', Buffer.alloc(100));
        expect(await s.getPoolAvailable()).toBe(924);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });

    it('getPoolAvailable also deducts pinned content from totalCapacity', async () => {
      const { store: s, dataDir: d } = makeTestStore(1000);
      try {
        await s.putContent('PINNED', Buffer.alloc(200), { pinned: true });
        await s.putContent('POOL', Buffer.alloc(100));
        expect(await s.getPoolAvailable()).toBe(700);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });
  });

  describe('eviction', () => {
    it('evictIfNeeded returns true when enough capacity', async () => {
      const { store: s, dataDir: d } = makeTestStore(1024 * 1024);
      try {
        expect(await s.evictIfNeeded(100)).toBe(true);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });
  });
});
