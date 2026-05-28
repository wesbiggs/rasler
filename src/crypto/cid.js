import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import * as dagCbor from '@ipld/dag-cbor';
import { base32 } from 'multiformats/bases/base32';

export async function computeDataCid(bytes) {
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, raw.code, hash);
  return cid.toString(base32);
}

export async function computeMaslCid(cborBytes) {
  const hash = await sha256.digest(cborBytes);
  const cid = CID.create(1, dagCbor.code, hash);
  return cid.toString(base32);
}

// Returns true when the CID uses the dag-cbor codec (0x71), meaning it is a MASL document.
export function isMaslCid(cidString) {
  try {
    const cid = CID.parse(cidString, base32);
    return cid.code === dagCbor.code;
  } catch {
    return false;
  }
}

// Returns the Unencoded-Digest header value for a CID.
// The SHA-256 bytes are extracted directly from the CID's multihash — no
// additional hashing required. Works for both data and MASL CIDs.
export function cidToUnencodedDigest(cidString) {
  const cid = CID.parse(cidString, base32);
  return 'sha-256=:' + Buffer.from(cid.multihash.digest).toString('base64') + ':';
}

export function getRingPosition(cidString) {
  const cid = CID.parse(cidString, base32);
  const digest = cid.multihash.digest;
  return bufferToBigInt(digest);
}

function bufferToBigInt(bytes) {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}
