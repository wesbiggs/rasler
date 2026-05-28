import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb } from '../../src/storage/db.js';
import { Store } from '../../src/storage/store.js';

function makeTestStore(totalCapacity = 10 * 1024 * 1024) {
  const dataDir = mkdtempSync(join(tmpdir(), 'crasl-test-'));
  const db = openDb(dataDir);
  const store = new Store(db, dataDir, totalCapacity);
  return { store, db, dataDir };
}

describe('Store', () => {
  let store, dataDir;

  beforeEach(() => {
    const t = makeTestStore();
    store = t.store;
    dataDir = t.dataDir;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('content operations', () => {
    it('puts and gets content', () => {
      const bytes = Buffer.from('hello');
      store.putContent('BCID1', bytes);
      const result = store.getContent('BCID1');
      expect(result).not.toBeNull();
      expect(result.bytes.toString()).toBe('hello');
      expect(result.meta.cid).toBe('BCID1');
      expect(result.meta.size).toBe(5);
    });

    it('hasContent returns true/false correctly', () => {
      expect(store.hasContent('BCID_MISSING')).toBe(false);
      store.putContent('BCID2', Buffer.from('data'));
      expect(store.hasContent('BCID2')).toBe(true);
    });

    it('listContent returns all stored CIDs', () => {
      store.putContent('BCID_A', Buffer.from('a'));
      store.putContent('BCID_B', Buffer.from('b'));
      const list = store.listContent();
      expect(list.map(r => r.cid)).toEqual(expect.arrayContaining(['BCID_A', 'BCID_B']));
    });

    it('deleteContent removes entry', () => {
      store.putContent('BCID3', Buffer.from('del'));
      store.deleteContent('BCID3');
      expect(store.hasContent('BCID3')).toBe(false);
      expect(store.getContent('BCID3')).toBeNull();
    });

    it('stores maslCid association', () => {
      store.putContent('BCID_DATA', Buffer.from('x'), { maslCid: 'BCID_MASL' });
      const result = store.getContent('BCID_DATA');
      expect(result.meta.masl_cid).toBe('BCID_MASL');
    });

    it('pinned flag is stored', () => {
      store.putContent('BCID_PIN', Buffer.from('pinned'), { pinned: true });
      const result = store.getContent('BCID_PIN');
      expect(result.meta.pinned).toBe(1);
    });
  });

  describe('capacity', () => {
    it('getPoolUsed reflects unpinned content size', () => {
      store.putContent('P1', Buffer.from('aaaaa')); // 5 bytes, unpinned
      store.putContent('P2', Buffer.from('bbb'), { pinned: true }); // 3 bytes, pinned
      expect(store.getPoolUsed()).toBe(5);
      expect(store.getPinnedUsed()).toBe(3);
    });

    it('getPoolAvailable decreases with unpinned pool usage', () => {
      const { store: s, dataDir: d } = makeTestStore(1024);
      try {
        s.putContent('X1', Buffer.alloc(100));
        expect(s.getPoolAvailable()).toBe(924);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });

    it('getPoolAvailable also deducts pinned content from totalCapacity', () => {
      const { store: s, dataDir: d } = makeTestStore(1000);
      try {
        s.putContent('PINNED', Buffer.alloc(200), { pinned: true });
        s.putContent('POOL', Buffer.alloc(100));
        // available = 1000 - 100 (pool) - 200 (pinned) = 700
        expect(s.getPoolAvailable()).toBe(700);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });
  });

  describe('eviction', () => {
    it('evictIfNeeded returns true when enough capacity', () => {
      const { store: s, dataDir: d } = makeTestStore(1024 * 1024);
      try {
        expect(s.evictIfNeeded(100)).toBe(true);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });
  });
});
