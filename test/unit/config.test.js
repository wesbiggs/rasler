import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { parseSize } from '../../src/util/parseSize.js';
import { normalizeMountPath } from '../../src/util/normalizeMountPath.js';
import { parseJsonStaticRoots, parseJsonMountPoints, sortMountPoints } from '../../src/util/parseJsonConfig.js';

describe('parseSize', () => {
  it('parses plain byte counts', () => {
    expect(parseSize('1073741824')).toBe(1073741824);
    expect(parseSize('0')).toBe(0);
    expect(parseSize('1')).toBe(1);
  });

  it('parses B suffix', () => {
    expect(parseSize('512B')).toBe(512);
    expect(parseSize('512b')).toBe(512);
  });

  it('parses K / KB', () => {
    expect(parseSize('1K')).toBe(1024);
    expect(parseSize('1KB')).toBe(1024);
    expect(parseSize('500K')).toBe(512000);
    expect(parseSize('500k')).toBe(512000);
  });

  it('parses M / MB', () => {
    expect(parseSize('1M')).toBe(1024 ** 2);
    expect(parseSize('1MB')).toBe(1024 ** 2);
    expect(parseSize('200M')).toBe(200 * 1024 ** 2);
    expect(parseSize('200MB')).toBe(200 * 1024 ** 2);
  });

  it('parses G / GB', () => {
    expect(parseSize('1G')).toBe(1024 ** 3);
    expect(parseSize('1GB')).toBe(1024 ** 3);
    expect(parseSize('2G')).toBe(2 * 1024 ** 3);
  });

  it('parses T / TB', () => {
    expect(parseSize('1T')).toBe(1024 ** 4);
    expect(parseSize('1TB')).toBe(1024 ** 4);
  });

  it('handles decimal values', () => {
    expect(parseSize('1.5G')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize('0.5M')).toBe(Math.round(0.5 * 1024 ** 2));
  });

  it('accepts whitespace between number and unit', () => {
    expect(parseSize('4 G')).toBe(4 * 1024 ** 3);
    expect(parseSize('200 MB')).toBe(200 * 1024 ** 2);
  });

  it('is case-insensitive for units', () => {
    expect(parseSize('1g')).toBe(1024 ** 3);
    expect(parseSize('1gb')).toBe(1024 ** 3);
    expect(parseSize('1Gb')).toBe(1024 ** 3);
  });

  it('throws on invalid format', () => {
    expect(() => parseSize('abc')).toThrow();
    expect(() => parseSize('')).toThrow();
    expect(() => parseSize('1X')).toThrow();
    expect(() => parseSize('1GG')).toThrow();
  });
});

describe('normalizeMountPath', () => {
  it('returns empty string for root variants', () => {
    expect(normalizeMountPath('/')).toBe('');
    expect(normalizeMountPath('')).toBe('');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeMountPath(null)).toBe('');
    expect(normalizeMountPath(undefined)).toBe('');
  });

  it('preserves a clean path prefix', () => {
    expect(normalizeMountPath('/docs')).toBe('/docs');
    expect(normalizeMountPath('/a/b/c')).toBe('/a/b/c');
  });

  it('adds a leading slash when missing', () => {
    expect(normalizeMountPath('docs')).toBe('/docs');
    expect(normalizeMountPath('app/v2')).toBe('/app/v2');
  });

  it('strips trailing slashes', () => {
    expect(normalizeMountPath('/docs/')).toBe('/docs');
    expect(normalizeMountPath('/docs///')).toBe('/docs');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeMountPath('  /docs  ')).toBe('/docs');
    expect(normalizeMountPath('  /  ')).toBe('');
  });
});

describe('parseJsonStaticRoots', () => {
  it('returns empty array for empty input', () => {
    expect(parseJsonStaticRoots([])).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(parseJsonStaticRoots()).toEqual([]);
  });

  it('parses a string entry', () => {
    expect(parseJsonStaticRoots(['/var/www/html'])).toEqual([
      { directory: '/var/www/html', watch: false, ignore: [], generateMasl: true },
    ]);
  });

  it('resolves relative paths against CWD', () => {
    expect(parseJsonStaticRoots(['data/site'])).toEqual([
      { directory: resolve('data/site'), watch: false, ignore: [], generateMasl: true },
    ]);
  });

  it('parses an object entry with defaults', () => {
    expect(parseJsonStaticRoots([{ path: '/var/www/html' }])).toEqual([
      { directory: '/var/www/html', watch: false, ignore: [], generateMasl: true },
    ]);
  });

  it('parses an object entry with watch and ignore', () => {
    const result = parseJsonStaticRoots([{ path: '/var/www/html', watch: true, ignore: ['**/*.log', '.DS_Store'] }]);
    expect(result).toEqual([
      { directory: '/var/www/html', watch: true, ignore: ['**/*.log', '.DS_Store'], generateMasl: true },
    ]);
  });

  it('parses generateMasl: false', () => {
    const result = parseJsonStaticRoots([{ path: '/var/www/blobs', generateMasl: false }]);
    expect(result).toEqual([
      { directory: '/var/www/blobs', watch: false, ignore: [], generateMasl: false },
    ]);
  });

  it('defaults generateMasl to true when not specified', () => {
    const result = parseJsonStaticRoots([{ path: '/var/www/html', watch: true }]);
    expect(result[0].generateMasl).toBe(true);
  });

  it('parses a mix of string and object entries', () => {
    const result = parseJsonStaticRoots(['/var/www/a', { path: '/var/www/b', watch: true }]);
    expect(result).toEqual([
      { directory: '/var/www/a', watch: false, ignore: [], generateMasl: true },
      { directory: '/var/www/b', watch: true, ignore: [], generateMasl: true },
    ]);
  });

  it('skips blank string entries', () => {
    expect(parseJsonStaticRoots(['', '  '])).toEqual([]);
  });

  it('skips malformed object entries', () => {
    expect(parseJsonStaticRoots([{ watch: true }, null, 42])).toEqual([]);
  });

  it('ignore defaults to [] when not an array', () => {
    const result = parseJsonStaticRoots([{ path: '/var/www/html', ignore: 'bad' }]);
    expect(result[0].ignore).toEqual([]);
  });
});

describe('parseJsonMountPoints', () => {
  it('returns empty array for empty input', () => {
    expect(parseJsonMountPoints([])).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(parseJsonMountPoints()).toEqual([]);
  });

  it('parses a hostname-only entry', () => {
    const result = parseJsonMountPoints([{ hostname: 'example.com', directory: '/var/www/html' }]);
    expect(result).toEqual([{ hostname: 'example.com', prefix: '', directory: '/var/www/html' }]);
  });

  it('parses an entry with a path prefix', () => {
    const result = parseJsonMountPoints([{ hostname: 'example.com', prefix: '/docs', directory: '/var/www/docs' }]);
    expect(result).toEqual([{ hostname: 'example.com', prefix: '/docs', directory: '/var/www/docs' }]);
  });

  it('normalizes the path prefix (strips trailing slash)', () => {
    const result = parseJsonMountPoints([{ hostname: 'example.com', prefix: '/docs/', directory: '/var/www/docs' }]);
    expect(result).toEqual([{ hostname: 'example.com', prefix: '/docs', directory: '/var/www/docs' }]);
  });

  it('sorts longest prefix first', () => {
    const result = parseJsonMountPoints([
      { hostname: 'example.com', directory: '/var/www/html' },
      { hostname: 'example.com', prefix: '/docs', directory: '/var/www/docs' },
    ]);
    expect(result[0].prefix).toBe('/docs');
    expect(result[1].prefix).toBe('');
  });

  it('resolves relative directory paths against CWD', () => {
    const result = parseJsonMountPoints([{ hostname: 'example.com', directory: 'data/site' }]);
    expect(result).toEqual([{ hostname: 'example.com', prefix: '', directory: resolve('data/site') }]);
  });

  it('treats missing hostname as wildcard (any host)', () => {
    const result = parseJsonMountPoints([{ directory: '/var/www/html' }]);
    expect(result).toEqual([{ hostname: '', prefix: '', directory: '/var/www/html' }]);
  });

  it('treats empty-string hostname as wildcard', () => {
    const result = parseJsonMountPoints([{ hostname: '', directory: '/var/www/html' }]);
    expect(result).toEqual([{ hostname: '', prefix: '', directory: '/var/www/html' }]);
  });

  it('skips entries missing directory', () => {
    expect(parseJsonMountPoints([{ hostname: 'example.com' }])).toEqual([]);
  });

  it('skips non-object entries', () => {
    expect(parseJsonMountPoints(['example.com:/var/www/html', null, 42])).toEqual([]);
  });
});

describe('sortMountPoints', () => {
  it('places longer prefix before shorter prefix regardless of hostname', () => {
    const points = [
      { hostname: '', prefix: '', directory: '/a' },
      { hostname: 'example.com', prefix: '/docs', directory: '/b' },
    ];
    sortMountPoints(points);
    expect(points[0].prefix).toBe('/docs');
    expect(points[1].prefix).toBe('');
  });

  it('places specific hostname before wildcard at equal prefix length', () => {
    const points = [
      { hostname: '', prefix: '/docs', directory: '/a' },
      { hostname: 'example.com', prefix: '/docs', directory: '/b' },
    ];
    sortMountPoints(points);
    expect(points[0].hostname).toBe('example.com');
    expect(points[1].hostname).toBe('');
  });

  it('longer prefix wins over hostname specificity', () => {
    const points = [
      { hostname: 'example.com', prefix: '', directory: '/a' },
      { hostname: '', prefix: '/docs', directory: '/b' },
    ];
    sortMountPoints(points);
    expect(points[0].prefix).toBe('/docs');
    expect(points[0].hostname).toBe('');
  });
});
