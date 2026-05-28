#!/usr/bin/env node
// Builds a DASL-compliant CAR file from a static website directory.
// Usage: npm run website-to-car <input-dir> [output.car]

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, basename, dirname } from 'node:path';
import { CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import { computeDataCid } from '../src/crypto/cid.js';
import { createBundleMasl } from '../src/masl/document.js';
import { mimeType } from '../src/util/mime.js';

async function* walkDir(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDir(full);
    else if (entry.isFile()) yield full;
  }
}

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

async function main() {
  const [,, inputDir, outputArg] = process.argv;
  if (!inputDir) {
    process.stderr.write('Usage: npm run website-to-car <input-dir> [output.car]\n');
    process.exit(1);
  }

  const siteName = basename(inputDir);
  const outPath = outputArg ?? `${siteName}.car`;

  // blocks: Map<cidStr, bytes> — deduplicates files with identical content
  const blocks = new Map();
  const resources = [];

  for await (const filePath of walkDir(inputDir)) {
    const bytes = await readFile(filePath);
    const cid = await computeDataCid(bytes);
    const contentType = mimeType(filePath);
    const relPath = '/' + relative(inputDir, filePath).replace(/\\/g, '/');

    if (!blocks.has(cid)) blocks.set(cid, bytes);

    resources.push({ path: relPath, cid, size: bytes.length, contentType });

    // index.html files also serve their parent directory path
    if (basename(filePath) === 'index.html') {
      const dir = dirname(relPath);
      const dirPath = dir === '/' ? '/' : dir + '/';
      resources.push({ path: dirPath, cid, size: bytes.length, contentType });
    }
  }

  if (resources.length === 0) {
    process.stderr.write(`No files found in ${inputDir}\n`);
    process.exit(1);
  }

  const { cborBytes, maslCid } = await createBundleMasl({ name: siteName, resources });

  const allBlocks = [[maslCid, Buffer.from(cborBytes)], ...blocks.entries()];
  const carBytes = await buildCar(maslCid, allBlocks);

  await writeFile(outPath, carBytes);
  process.stdout.write(`MASL CID: ${maslCid}\n`);
  process.stdout.write(`Output:   ${outPath} (${carBytes.length} bytes, ${blocks.size} data block(s), ${resources.length} resource(s))\n`);
}

main().catch(err => { process.stderr.write(`${err.message}\n`); process.exit(1); });
