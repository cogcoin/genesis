#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const KNOWN_GENESIS_PARAMS_SHA256 =
  '8320ab7cc763c9d3a3c6242fede3f4f2e10612759bd47331e12be4fcf4836462';
const EXPECTED_PROTOCOL = 'cogcoin';
const EXPECTED_PACKAGE_NAME = '@cogcoin/genesis';
const KNOWN_LEGACY_MESSAGE_ADDRESS = '1Ndf2baN7oQffJwzVbZYqvHAhzJQyZgYcA';
const EXPECTED_PACKAGE_MANIFEST_FILES = [
  'genesis_params.json',
  'genesis_tx.json',
  'canonical_constants.json',
  'bip39_english.txt',
  'cogcoin_whitepaper.md',
  'scoring_bundle/manifest.sha256',
  'scoring_bundle/cogcoin_scoring.wasm',
  'scoring_bundle/cgsm_blob.bin',
  'scoring_bundle/coglex_token_table.json',
  'scoring_bundle/scoring_module.md',
  'scoring_bundle/test_vectors.json',
  'verify.mjs',
];

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATORS = [
  0x3b6a57b2,
  0x26508e6d,
  0x1ea119fa,
  0x3d4233dd,
  0x2a1462b3,
];

const P = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const GX = BigInt('55066263022277343669578718895168534326250603453777594175500187360389116729240');
const GY = BigInt('32670510020758816978083085130507043184471273380659243275938904335757337482424');
const G = { x: GX, y: GY };

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  ensure(size) {
    if (this.offset + size > this.bytes.length) {
      throw new Error('Unexpected end of data');
    }
  }

  readUInt8() {
    this.ensure(1);
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  peekUInt8(ahead = 0) {
    const index = this.offset + ahead;
    if (index >= this.bytes.length) {
      return undefined;
    }
    return this.bytes[index];
  }

  readBytes(size) {
    this.ensure(size);
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  readVarInt() {
    const first = this.readUInt8();
    if (first < 0xfd) {
      return first;
    }
    if (first === 0xfd) {
      const bytes = this.readBytes(2);
      return bytes[0] | (bytes[1] << 8);
    }
    if (first === 0xfe) {
      const bytes = this.readBytes(4);
      return (
        bytes[0] +
        bytes[1] * 2 ** 8 +
        bytes[2] * 2 ** 16 +
        bytes[3] * 2 ** 24
      );
    }
    const bytes = this.readBytes(8);
    let value = 0n;
    for (let i = 0; i < 8; i += 1) {
      value += BigInt(bytes[i]) << (8n * BigInt(i));
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('VarInt exceeds safe integer range');
    }
    return Number(value);
  }
}

function fail(message) {
  throw new Error(message);
}

function mod(value, modulus) {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let current = mod(base, modulus);
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) {
      result = mod(result * current, modulus);
    }
    current = mod(current * current, modulus);
    power >>= 1n;
  }
  return result;
}

function modInverse(value, modulus) {
  let a = mod(value, modulus);
  let b = modulus;
  let x0 = 1n;
  let x1 = 0n;
  while (b !== 0n) {
    const quotient = a / b;
    [a, b] = [b, a - quotient * b];
    [x0, x1] = [x1, x0 - quotient * x1];
  }
  if (a !== 1n) {
    throw new Error('Inverse does not exist');
  }
  return mod(x0, modulus);
}

function pointIsOnCurve(point) {
  if (point === null) {
    return true;
  }
  const left = mod(point.y * point.y, P);
  const right = mod(point.x * point.x * point.x + 7n, P);
  return left === right;
}

function pointNegate(point) {
  if (point === null) {
    return null;
  }
  return { x: point.x, y: mod(-point.y, P) };
}

function pointDouble(point) {
  if (point === null) {
    return null;
  }
  if (point.y === 0n) {
    return null;
  }
  const slope = mod(
    (3n * point.x * point.x) * modInverse(2n * point.y, P),
    P,
  );
  const x = mod(slope * slope - 2n * point.x, P);
  const y = mod(slope * (point.x - x) - point.y, P);
  return { x, y };
}

function pointAdd(left, right) {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  if (left.x === right.x) {
    if (mod(left.y + right.y, P) === 0n) {
      return null;
    }
    return pointDouble(left);
  }
  const slope = mod(
    (right.y - left.y) * modInverse(right.x - left.x, P),
    P,
  );
  const x = mod(slope * slope - left.x - right.x, P);
  const y = mod(slope * (left.x - x) - left.y, P);
  return { x, y };
}

function pointMultiply(scalar, point) {
  let k = scalar;
  let addend = point;
  let result = null;
  if (k < 0n) {
    return pointMultiply(-k, pointNegate(point));
  }
  while (k > 0n) {
    if (k & 1n) {
      result = pointAdd(result, addend);
    }
    addend = pointDouble(addend);
    k >>= 1n;
  }
  return result;
}

function sqrtMod(value) {
  const root = modPow(value, (P + 1n) >> 2n, P);
  if (mod(root * root, P) !== mod(value, P)) {
    throw new Error('No square root exists for value');
  }
  return root;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest();
}

function sha256Hex(bytes) {
  return sha256(bytes).toString('hex');
}

function sha256d(bytes) {
  return sha256(sha256(bytes));
}

function ripemd160(bytes) {
  return createHash('ripemd160').update(bytes).digest();
}

function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  return Buffer.from(hex, 'hex');
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function base58Encode(bytes) {
  let value = bigintFromBytes(bytes);
  let encoded = '';
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0x00) {
      break;
    }
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function encodeP2PKHAddress(pubkeyHash) {
  const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(pubkeyHash)]);
  const checksum = sha256d(payload).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function encodeVarInt(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid varint value: ${value}`);
  }
  if (value < 0xfd) {
    return Buffer.from([value]);
  }
  if (value <= 0xffff) {
    const out = Buffer.alloc(3);
    out[0] = 0xfd;
    out.writeUInt16LE(value, 1);
    return out;
  }
  if (value <= 0xffffffff) {
    const out = Buffer.alloc(5);
    out[0] = 0xfe;
    out.writeUInt32LE(value, 1);
    return out;
  }
  const out = Buffer.alloc(9);
  out[0] = 0xff;
  let remaining = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    out[1 + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function parseTransaction(rawHex) {
  const bytes = hexToBytes(rawHex);
  const reader = new ByteReader(bytes);
  const version = reader.readBytes(4);

  let hasWitness = false;
  if (reader.peekUInt8() === 0x00) {
    const flag = reader.peekUInt8(1);
    if (flag !== undefined && flag !== 0x00) {
      hasWitness = true;
      reader.readUInt8();
      reader.readUInt8();
    }
  }

  const inputCount = reader.readVarInt();
  const inputs = [];
  for (let i = 0; i < inputCount; i += 1) {
    const txid = reader.readBytes(32);
    const vout = reader.readBytes(4);
    const scriptLength = reader.readVarInt();
    const scriptSig = reader.readBytes(scriptLength);
    const sequence = reader.readBytes(4);
    inputs.push({ txid, vout, scriptSig, sequence });
  }

  const outputCount = reader.readVarInt();
  const outputs = [];
  for (let i = 0; i < outputCount; i += 1) {
    const value = reader.readBytes(8);
    const scriptLength = reader.readVarInt();
    const scriptPubKey = reader.readBytes(scriptLength);
    outputs.push({ value, scriptPubKey });
  }

  const witnesses = [];
  if (hasWitness) {
    for (let i = 0; i < inputCount; i += 1) {
      const itemCount = reader.readVarInt();
      const items = [];
      for (let j = 0; j < itemCount; j += 1) {
        const itemLength = reader.readVarInt();
        items.push(reader.readBytes(itemLength));
      }
      witnesses.push(items);
    }
  }

  const locktime = reader.readBytes(4);
  if (reader.offset !== bytes.length) {
    throw new Error('Transaction has trailing bytes');
  }

  const nonWitnessParts = [version, encodeVarInt(inputCount)];
  for (const input of inputs) {
    nonWitnessParts.push(
      input.txid,
      input.vout,
      encodeVarInt(input.scriptSig.length),
      input.scriptSig,
      input.sequence,
    );
  }
  nonWitnessParts.push(encodeVarInt(outputCount));
  for (const output of outputs) {
    nonWitnessParts.push(
      output.value,
      encodeVarInt(output.scriptPubKey.length),
      output.scriptPubKey,
    );
  }
  nonWitnessParts.push(locktime);

  const txid = Buffer.from(sha256d(Buffer.concat(nonWitnessParts))).reverse().toString('hex');

  return {
    hasWitness,
    inputs,
    outputs,
    witnesses,
    txid,
  };
}

function parseOpReturnPayload(scriptPubKey) {
  if (scriptPubKey.length < 2 || scriptPubKey[0] !== 0x6a) {
    throw new Error('Script is not OP_RETURN');
  }
  const pushOpcode = scriptPubKey[1];
  let length;
  let cursor;
  if (pushOpcode <= 75) {
    length = pushOpcode;
    cursor = 2;
  } else if (pushOpcode === 0x4c) {
    length = scriptPubKey[2];
    cursor = 3;
  } else if (pushOpcode === 0x4d) {
    length = scriptPubKey[2] | (scriptPubKey[3] << 8);
    cursor = 4;
  } else if (pushOpcode === 0x4e) {
    length =
      scriptPubKey[2] +
      scriptPubKey[3] * 2 ** 8 +
      scriptPubKey[4] * 2 ** 16 +
      scriptPubKey[5] * 2 ** 24;
    cursor = 6;
  } else {
    throw new Error('Unsupported OP_RETURN push opcode');
  }
  const payload = scriptPubKey.subarray(cursor, cursor + length);
  if (payload.length !== length || cursor + length !== scriptPubKey.length) {
    throw new Error('Malformed OP_RETURN payload');
  }
  return payload;
}

function bech32Polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >> i) & 1) {
        chk ^= BECH32_GENERATORS[i];
      }
    }
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i += 1) {
    const code = hrp.charCodeAt(i);
    out.push(code >> 5);
  }
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) {
    out.push(hrp.charCodeAt(i) & 31);
  }
  return out;
}

function bech32CreateChecksum(hrp, data, encoding) {
  const constValue = encoding === 'bech32' ? 1 : 0x2bc830a3;
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const modValue = bech32Polymod(values) ^ constValue;
  const checksum = [];
  for (let i = 0; i < 6; i += 1) {
    checksum.push((modValue >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

function bech32VerifyChecksum(hrp, data) {
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  if (polymod === 1) {
    return 'bech32';
  }
  if (polymod === 0x2bc830a3) {
    return 'bech32m';
  }
  throw new Error('Invalid bech32 checksum');
}

function bech32Decode(address) {
  const lowered = address.toLowerCase();
  const uppered = address.toUpperCase();
  if (address !== lowered && address !== uppered) {
    throw new Error('Bech32 address mixes case');
  }
  const normalized = lowered;
  const separatorIndex = normalized.lastIndexOf('1');
  if (separatorIndex <= 0 || separatorIndex + 7 > normalized.length) {
    throw new Error('Invalid bech32 separator position');
  }
  const hrp = normalized.slice(0, separatorIndex);
  const payload = normalized.slice(separatorIndex + 1);
  const data = [];
  for (const char of payload) {
    const index = BECH32_CHARSET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid bech32 character: ${char}`);
    }
    data.push(index);
  }
  const encoding = bech32VerifyChecksum(hrp, data);
  return {
    hrp,
    data: data.slice(0, -6),
    encoding,
  };
}

function bech32Encode(hrp, data, encoding) {
  const checksum = bech32CreateChecksum(hrp, data, encoding);
  const combined = [...data, ...checksum];
  let output = `${hrp}1`;
  for (const value of combined) {
    output += BECH32_CHARSET[value];
  }
  return output;
}

function convertBits(data, fromBits, toBits, pad) {
  let accumulator = 0;
  let bits = 0;
  const maxValue = (1 << toBits) - 1;
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  const result = [];
  for (const value of data) {
    if (value < 0 || value >> fromBits) {
      throw new Error('Invalid value for bit conversion');
    }
    accumulator = ((accumulator << fromBits) | value) & maxAccumulator;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) {
      result.push((accumulator << (toBits - bits)) & maxValue);
    }
  } else if (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue) !== 0) {
    throw new Error('Invalid padding in bit conversion');
  }
  return result;
}

function decodeSegwitAddress(address) {
  const { hrp, data, encoding } = bech32Decode(address);
  if (data.length === 0) {
    throw new Error('Segwit address is missing witness version');
  }
  const version = data[0];
  if (version > 16) {
    throw new Error('Invalid witness version');
  }
  const program = Buffer.from(convertBits(data.slice(1), 5, 8, false));
  if (program.length < 2 || program.length > 40) {
    throw new Error('Invalid witness program length');
  }
  if (version === 0 && encoding !== 'bech32') {
    throw new Error('Witness v0 address must use bech32');
  }
  if (version !== 0 && encoding !== 'bech32m') {
    throw new Error('Witness v1+ address must use bech32m');
  }
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error('Witness v0 program must be 20 or 32 bytes');
  }
  const versionByte = version === 0 ? 0x00 : 0x50 + version;
  const scriptPubKey = Buffer.concat([Buffer.from([versionByte, program.length]), program]);
  return { hrp, version, program, scriptPubKey };
}

function encodeSegwitAddress(hrp, version, program) {
  const data = [version, ...convertBits([...program], 8, 5, true)];
  const encoding = version === 0 ? 'bech32' : 'bech32m';
  return bech32Encode(hrp, data, encoding);
}

function bigintFromBytes(bytes) {
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
}

function bigintToBuffer(value, length) {
  const hex = value.toString(16).padStart(length * 2, '0');
  return Buffer.from(hex, 'hex');
}

function recoverCompactSignaturePublicKey(messageHash, signature) {
  if (signature.length !== 65) {
    throw new Error('Compact signature must be 65 bytes');
  }
  const header = signature[0];
  let recoveryId;
  if (header >= 27 && header <= 30) {
    recoveryId = header - 27;
  } else if (header >= 31 && header <= 34) {
    recoveryId = header - 31;
  } else if (header >= 35 && header <= 38) {
    recoveryId = header - 35;
  } else if (header >= 39 && header <= 42) {
    recoveryId = header - 39;
  } else {
    throw new Error(`Unsupported compact signature header: ${header}`);
  }

  const r = bigintFromBytes(signature.subarray(1, 33));
  const s = bigintFromBytes(signature.subarray(33, 65));
  if (r <= 0n || r >= N || s <= 0n || s >= N) {
    throw new Error('Compact signature r/s values are out of range');
  }

  const x = r + BigInt(recoveryId >> 1) * N;
  if (x >= P) {
    throw new Error('Recovered x coordinate is out of range');
  }

  const alpha = mod(x * x * x + 7n, P);
  const beta = sqrtMod(alpha);
  const y = (beta & 1n) === BigInt(recoveryId & 1) ? beta : mod(-beta, P);
  const rPoint = { x, y };
  if (!pointIsOnCurve(rPoint)) {
    throw new Error('Recovered point is not on secp256k1');
  }
  if (pointMultiply(N, rPoint) !== null) {
    throw new Error('Recovered point does not have secp256k1 subgroup order');
  }

  const z = bigintFromBytes(messageHash);
  const rInverse = modInverse(r, N);
  const sR = pointMultiply(s, rPoint);
  const zG = pointMultiply(mod(-z, N), G);
  const publicKeyPoint = pointMultiply(rInverse, pointAdd(sR, zG));
  if (publicKeyPoint === null || !pointIsOnCurve(publicKeyPoint)) {
    throw new Error('Recovered public key is invalid');
  }

  const w = modInverse(s, N);
  const u1 = mod(z * w, N);
  const u2 = mod(r * w, N);
  const verificationPoint = pointAdd(pointMultiply(u1, G), pointMultiply(u2, publicKeyPoint));
  if (verificationPoint === null || mod(verificationPoint.x, N) !== r) {
    throw new Error('Recovered public key does not verify the signature');
  }

  return publicKeyPoint;
}

function compressedPublicKeyFromPoint(point) {
  if (point === null) {
    throw new Error('Point at infinity has no public key encoding');
  }
  const prefix = point.y & 1n ? 0x03 : 0x02;
  return Buffer.concat([Buffer.from([prefix]), bigintToBuffer(point.x, 32)]);
}

function bitcoinMessageHash(messageBytes) {
  const prefix = Buffer.from('Bitcoin Signed Message:\n', 'utf8');
  return sha256d(
    Buffer.concat([
      encodeVarInt(prefix.length),
      prefix,
      encodeVarInt(messageBytes.length),
      messageBytes,
    ]),
  );
}

async function readFileBytes(relativePath) {
  return fs.readFile(path.join(ROOT_DIR, relativePath));
}

async function readJson(relativePath) {
  const raw = await readFileBytes(relativePath);
  return JSON.parse(raw.toString('utf8'));
}

async function assertFileHash(relativePath, expectedHash) {
  const raw = await readFileBytes(relativePath);
  const actualHash = sha256Hex(raw);
  if (actualHash !== expectedHash) {
    fail(`${relativePath} hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
}

async function main() {
  console.log('@cogcoin/genesis verification');

  const announcementRaw = await readFileBytes('genesis_announcement.json');
  const announcement = JSON.parse(announcementRaw.toString('utf8'));
  const announcementSigRaw = (await readFileBytes('genesis_announcement.sig')).toString('utf8');
  const genesisParamsRaw = await readFileBytes('genesis_params.json');
  const genesisParams = JSON.parse(genesisParamsRaw.toString('utf8'));
  const genesisTx = await readJson('genesis_tx.json');

  const announcementParamsHash = announcement?.chain_anchor?.genesis_params_sha256;
  const paramsHash = sha256Hex(genesisParamsRaw);
  if (announcement?.protocol !== EXPECTED_PROTOCOL) {
    fail(
      `genesis_announcement.json protocol mismatch: expected ${EXPECTED_PROTOCOL}, got ${announcement?.protocol}`,
    );
  }
  if (announcement?.package !== EXPECTED_PACKAGE_NAME) {
    fail(
      `genesis_announcement.json package mismatch: expected ${EXPECTED_PACKAGE_NAME}, got ${announcement?.package}`,
    );
  }
  if (paramsHash !== KNOWN_GENESIS_PARAMS_SHA256) {
    fail(
      `genesis_params.json hash mismatch against known on-chain value: expected ${KNOWN_GENESIS_PARAMS_SHA256}, got ${paramsHash}`,
    );
  }
  if (announcementParamsHash !== paramsHash) {
    fail(
      `genesis_announcement.json chain_anchor.genesis_params_sha256 mismatch: expected ${paramsHash}, got ${announcementParamsHash}`,
    );
  }
  console.log('  [PASS] genesis_params.json hash matches on-chain commitment');

  const scoringManifestRaw = await readFileBytes('scoring_bundle/manifest.sha256');
  const scoringManifestHash = sha256Hex(scoringManifestRaw);
  if (genesisParams.scoring_bundle_sha256 !== scoringManifestHash) {
    fail(
      `scoring_bundle/manifest.sha256 hash mismatch: expected ${genesisParams.scoring_bundle_sha256}, got ${scoringManifestHash}`,
    );
  }
  console.log('  [PASS] scoring_bundle/manifest.sha256 hash matches genesis_params');

  const bundleManifestLines = scoringManifestRaw
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const line of bundleManifestLines) {
    const match = line.match(/^([0-9a-f]{64})\s+\.\/*(.+)$/);
    if (!match) {
      fail(`Malformed scoring bundle manifest line: ${line}`);
    }
    const [, expectedHash, relativeName] = match;
    const relativePath = path.posix.join('scoring_bundle', relativeName);
    await assertFileHash(relativePath, expectedHash);
    console.log(`  [PASS] bundle manifest: ${path.posix.basename(relativePath)}`);
  }

  const packageManifest = announcement?.package_manifest;
  if (!packageManifest || typeof packageManifest !== 'object' || Array.isArray(packageManifest)) {
    fail('genesis_announcement.json package_manifest is missing or invalid');
  }
  const manifestKeys = Object.keys(packageManifest);
  const expectedManifestSet = new Set(EXPECTED_PACKAGE_MANIFEST_FILES);
  if (manifestKeys.length !== EXPECTED_PACKAGE_MANIFEST_FILES.length) {
    fail(
      `package_manifest must contain ${EXPECTED_PACKAGE_MANIFEST_FILES.length} files, found ${manifestKeys.length}`,
    );
  }
  for (const key of manifestKeys) {
    if (!expectedManifestSet.has(key)) {
      fail(`Unexpected package_manifest entry: ${key}`);
    }
  }
  for (const expectedFile of EXPECTED_PACKAGE_MANIFEST_FILES) {
    if (!(expectedFile in packageManifest)) {
      fail(`Missing package_manifest entry: ${expectedFile}`);
    }
    await assertFileHash(expectedFile, packageManifest[expectedFile]);
  }
  console.log(`  [PASS] package manifest: ${manifestKeys.length}/${manifestKeys.length} files verified`);

  const parsedTx = parseTransaction(genesisTx.raw_hex);
  if (parsedTx.txid !== genesisTx.txid) {
    fail(`genesis txid mismatch: expected ${genesisTx.txid}, got ${parsedTx.txid}`);
  }
  console.log('  [PASS] genesis tx: txid computed from raw_hex matches genesis_tx.json');

  const opReturnOutput = parsedTx.outputs.find((output) => output.scriptPubKey[0] === 0x6a);
  if (!opReturnOutput) {
    fail('Genesis transaction does not contain an OP_RETURN output');
  }
  const opReturnPayload = parseOpReturnPayload(opReturnOutput.scriptPubKey);
  const committedHash = bytesToHex(opReturnPayload.subarray(4, 36));
  if (committedHash !== announcement.chain_anchor.genesis_params_sha256) {
    fail(
      `OP_RETURN hash mismatch: expected ${announcement.chain_anchor.genesis_params_sha256}, got ${committedHash}`,
    );
  }
  console.log('  [PASS] genesis tx: OP_RETURN params hash matches chain_anchor');

  const treasuryFromParams = genesisParams.treasury_address;
  const treasuryFromTx = genesisTx.treasury_address;
  const treasuryFromAnnouncement = announcement?.signing_identity?.treasury_address;
  if (
    treasuryFromParams !== treasuryFromTx ||
    treasuryFromParams !== treasuryFromAnnouncement
  ) {
    fail('Treasury address mismatch across genesis_params.json, genesis_tx.json, and genesis_announcement.json');
  }
  const decodedTreasury = decodeSegwitAddress(treasuryFromParams);
  const treasuryScriptPubKey = bytesToHex(decodedTreasury.scriptPubKey);
  if (treasuryScriptPubKey !== genesisTx.treasury_scriptpubkey) {
    fail(
      `Treasury scriptPubKey mismatch: expected ${genesisTx.treasury_scriptpubkey}, got ${treasuryScriptPubKey}`,
    );
  }
  if (announcement.signing_identity.treasury_scriptpubkey !== genesisTx.treasury_scriptpubkey) {
    fail('Treasury scriptPubKey mismatch between genesis_announcement.json and genesis_tx.json');
  }
  console.log('  [PASS] treasury: bech32 decode matches raw scriptPubKey');

  const announcementPubkey = announcement?.signing_identity?.genesis_pubkey;
  if (announcementPubkey !== genesisParams.genesis_pubkey) {
    fail(
      `genesis pubkey mismatch: expected ${genesisParams.genesis_pubkey}, got ${announcementPubkey}`,
    );
  }
  console.log('  [PASS] genesis pubkey: announcement matches genesis_params');

  const pubkeyBytes = hexToBytes(genesisParams.genesis_pubkey);
  if (pubkeyBytes.length !== 33 || (pubkeyBytes[0] !== 0x02 && pubkeyBytes[0] !== 0x03)) {
    fail('genesis_pubkey is not a compressed secp256k1 public key');
  }
  const derivedSigningAddress = encodeSegwitAddress(
    decodedTreasury.hrp,
    0,
    hash160(pubkeyBytes),
  );
  if (derivedSigningAddress !== treasuryFromParams) {
    fail(
      `Signing address mismatch: expected ${treasuryFromParams}, got ${derivedSigningAddress}`,
    );
  }
  console.log(`  [PASS] signing address: ${derivedSigningAddress} derived from genesis_pubkey`);
  const legacyVerificationAddress = encodeP2PKHAddress(hash160(pubkeyBytes));
  if (legacyVerificationAddress !== KNOWN_LEGACY_MESSAGE_ADDRESS) {
    fail(
      `Legacy verification address mismatch: expected ${KNOWN_LEGACY_MESSAGE_ADDRESS}, got ${legacyVerificationAddress}`,
    );
  }
  console.log(
    `  [PASS] legacy verification address: ${legacyVerificationAddress} derived from genesis_pubkey`,
  );

  if (announcementSigRaw === 'AIRGAP_REQUIRED_REPLACE_WITH_BASE64_SIGNATURE') {
    fail('genesis_announcement.sig still contains the airgapped-signing placeholder');
  }
  const signatureBytes = Buffer.from(announcementSigRaw, 'base64');
  if (signatureBytes.length !== 65) {
    fail('genesis_announcement.sig is not a valid 65-byte compact signature');
  }
  const announcementHashHex = sha256Hex(announcementRaw);
  const messageHash = bitcoinMessageHash(Buffer.from(announcementHashHex, 'utf8'));
  const recoveredPoint = recoverCompactSignaturePublicKey(messageHash, signatureBytes);
  const recoveredPubkey = compressedPublicKeyFromPoint(recoveredPoint);
  if (bytesToHex(recoveredPubkey) !== genesisParams.genesis_pubkey) {
    fail(
      `Announcement signature recovered pubkey mismatch: expected ${genesisParams.genesis_pubkey}, got ${bytesToHex(recoveredPubkey)}`,
    );
  }
  const recoveredAddress = encodeSegwitAddress(decodedTreasury.hrp, 0, hash160(recoveredPubkey));
  if (recoveredAddress !== treasuryFromParams) {
    fail(
      `Announcement signature recovered address mismatch: expected ${treasuryFromParams}, got ${recoveredAddress}`,
    );
  }
  const recoveredLegacyAddress = encodeP2PKHAddress(hash160(recoveredPubkey));
  if (recoveredLegacyAddress !== KNOWN_LEGACY_MESSAGE_ADDRESS) {
    fail(
      `Announcement signature recovered legacy address mismatch: expected ${KNOWN_LEGACY_MESSAGE_ADDRESS}, got ${recoveredLegacyAddress}`,
    );
  }
  console.log('  [PASS] announcement signature: valid (ECDSA against genesis_pubkey)');

  console.log('');
  console.log('All checks passed.');
}

export {
  base58Encode,
  bitcoinMessageHash,
  compressedPublicKeyFromPoint,
  decodeSegwitAddress,
  encodeP2PKHAddress,
  encodeSegwitAddress,
  hash160,
  parseTransaction,
  recoverCompactSignaturePublicKey,
};

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(`  [FAIL] ${error.message}`);
    process.exitCode = 1;
  });
}
