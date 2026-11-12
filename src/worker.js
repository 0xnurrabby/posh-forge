

import { getPublicKey as secpGetPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const BATCH_SIZE = 500;
const ADDRESS_HEX_LENGTH = 40;
const RANDOM_POOL_KEYS = 1024;
const ZERO_CHAR = 48; 
const ONE_CHAR = 49; 

const hexTable = new Uint8Array(512);
for (let i = 0; i < 256; i += 1) {
  const pair = i.toString(16).padStart(2, '0');
  hexTable[i * 2] = pair.charCodeAt(0);
  hexTable[i * 2 + 1] = pair.charCodeAt(1);
}

const randomPool = new Uint8Array(32 * RANDOM_POOL_KEYS);
let randomPoolOffset = randomPool.length;

let running = false;
let sessionId = 0;
let spec = null;
let lastErrorCount = 0;

function now() {
  return performance.now();
}

function nextSecretView() {
  if (randomPoolOffset + 32 > randomPool.length) {
    crypto.getRandomValues(randomPool);
    randomPoolOffset = 0;
  }
  const view = randomPool.subarray(randomPoolOffset, randomPoolOffset + 32);
  randomPoolOffset += 32;
  return view;
}

function bytesToHex(bytes) {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i];
    out[i * 2] = hexTable[value * 2];
    out[i * 2 + 1] = hexTable[value * 2 + 1];
  }
  return String.fromCharCode.apply(null, out);
}


function toEip55(lowerHex) {
  const ascii = new Uint8Array(ADDRESS_HEX_LENGTH);
  for (let i = 0; i < ADDRESS_HEX_LENGTH; i += 1) {
    ascii[i] = lowerHex.charCodeAt(i);
  }
  const hash = keccak_256(ascii);
  let out = '';
  for (let i = 0; i < ADDRESS_HEX_LENGTH; i += 1) {
    const char = lowerHex[i];
    if (char >= 'a' && char <= 'f') {
      const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
      out += nibble >= 8 ? char.toUpperCase() : char;
    } else {
      out += char;
    }
  }
  return out;
}


function scanEvm(secretView) {
  let publicKey;
  try {
    publicKey = secpGetPublicKey(secretView, false);
  } catch (_) {
    
    
    return null;
  }

  const hash = keccak_256(publicKey.subarray(1));
  const lowerHex = bytesToHex(hash.subarray(12));

  const leading = spec.leadingZeros;
  for (let i = 0; i < leading; i += 1) {
    if (lowerHex.charCodeAt(i) !== ZERO_CHAR) return null;
  }

  const suffixLength = spec.suffix.length;
  const suffixStart = ADDRESS_HEX_LENGTH - suffixLength;
  const preStart = suffixStart - spec.preSuffixZeros;

  for (let i = preStart; i < suffixStart; i += 1) {
    if (lowerHex.charCodeAt(i) !== ZERO_CHAR) return null;
  }

  if (suffixLength > 0) {
    for (let i = 0; i < suffixLength; i += 1) {
      if (lowerHex.charCodeAt(suffixStart + i) !== spec.suffixLower.charCodeAt(i)) {
        return null;
      }
    }
  }

  const checksummed = toEip55(lowerHex);

  if (spec.caseSensitive && suffixLength > 0) {
    if (checksummed.slice(-suffixLength) !== spec.suffix) return null;
  }

  return {
    chain: 'evm',
    address: checksummed,
    privateKeyHex: `0x${bytesToHex(secretView)}`,
    publicKeyHex: bytesToHex(publicKey),
  };
}


function scanSol(secretView) {
  const publicKey = ed25519.getPublicKey(secretView);

  const leading = spec.leadingOnes;
  for (let i = 0; i < leading; i += 1) {
    if (publicKey[i] !== 0) return null;
  }

  const suffixLength = spec.suffix.length;
  if (suffixLength === 0 && spec.preSuffixOnes === 0) {
    const addressOnly = bs58.encode(publicKey);
    return buildSolResult(secretView, publicKey, addressOnly);
  }

  const address = bs58.encode(publicKey);
  const suffixStart = address.length - suffixLength;
  if (suffixStart < 0) return null;

  const preStart = suffixStart - spec.preSuffixOnes;
  if (preStart < 0) return null;

  for (let i = preStart; i < suffixStart; i += 1) {
    if (address.charCodeAt(i) !== ONE_CHAR) return null;
  }

  if (suffixLength > 0) {
    const actual = address.slice(suffixStart);
    if (spec.caseInsensitive) {
      if (actual.toLowerCase() !== spec.suffixLower) return null;
    } else if (actual !== spec.suffix) {
      return null;
    }
  }

  return buildSolResult(secretView, publicKey, address);
}

function buildSolResult(secretView, publicKey, address) {
  const keypair = new Uint8Array(64);
  keypair.set(secretView, 0);
  keypair.set(publicKey, 32);

  return {
    chain: 'sol',
    address,
    privateKeyBase58: bs58.encode(keypair),
    privateKeyArray: Array.from(keypair),
    publicKeyHex: bytesToHex(publicKey),
    seedHex: bytesToHex(secretView),
  };
}

function runBatch() {
  if (!running) return;

  let attempts = 0;
  let found = null;
  const started = now();

  try {
    for (let i = 0; i < BATCH_SIZE && running; i += 1) {
      attempts += 1;
      const secretView = nextSecretView();
      found = spec.engine === 'evm' ? scanEvm(secretView) : scanSol(secretView);
      if (found) {
        running = false;
        break;
      }
    }
  } catch (error) {
    running = false;
    self.postMessage({
      type: 'error',
      session: sessionId,
      message: error && error.message ? error.message : String(error),
    });
    return;
  }

  const elapsedMs = Math.max(0.001, now() - started);

  if (found) {
    self.postMessage({
      type: 'found',
      session: sessionId,
      result: found,
      attempts,
      elapsedMs,
    });
    return;
  }

  self.postMessage({
    type: 'progress',
    session: sessionId,
    attempts,
    elapsedMs,
  });

  if (running) {
    setTimeout(runBatch, 0);
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'start') {
    if (running) running = false;
    sessionId = message.session;
    spec = message.config;
    if (!spec || !spec.engine) {
      self.postMessage({ type: 'error', session: sessionId, message: 'Invalid worker configuration.' });
      return;
    }
    if (spec.engine === 'sol') {
      spec.suffixLower = String(spec.suffix || '').toLowerCase();
      spec.leadingOnes = Number(spec.leadingOnes) || 0;
      spec.preSuffixOnes = Number(spec.preSuffixOnes) || 0;
      spec.suffix = String(spec.suffix || '');
    } else {
      spec.suffix = String(spec.suffix || '');
      spec.suffixLower = spec.suffix.toLowerCase();
      spec.leadingZeros = Number(spec.leadingZeros) || 0;
      spec.preSuffixZeros = Number(spec.preSuffixZeros) || 0;
      spec.caseSensitive = Boolean(spec.caseSensitive);
    }

    randomPoolOffset = randomPool.length;
    lastErrorCount = 0;
    running = true;
    self.postMessage({ type: 'ready', session: sessionId });
    setTimeout(runBatch, 0);
    return;
  }

  if (message.type === 'stop') {
    running = false;
  }
};
