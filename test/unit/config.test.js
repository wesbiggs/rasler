import { describe, it, expect } from '@jest/globals';
import { parseSize } from '../../src/util/parseSize.js';
import { normalizeMountPath } from '../../src/util/normalizeMountPath.js';

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
