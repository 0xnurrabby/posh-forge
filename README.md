# POSH / FORGE

A local-only vanity wallet generator for EVM networks and Solana.

Open `index.html`, choose a pattern, and generate a wallet directly in the browser. There is no sign-in, backend, CDN dependency, or network connection required.

## What it does

- Generates EVM addresses for Ethereum, BNB Chain, Polygon, and Base.
- Generates Solana addresses with Phantom-compatible secret key export.
- Supports leading zeros, pre-suffix zeros, and custom ending words.
- Renders a live address preview with locked characters highlighted.
- Finds matches with parallel Web Workers and live probability telemetry.
- Keeps generated keys in a local vault with copy, reveal, and backup actions.

## How it works

EVM keys use secp256k1. The public key is hashed with keccak-256, and the last 20 bytes become the address. The display uses the EIP-55 checksum format.

Solana keys use Ed25519. The 32-byte public key is encoded with Base58. A leading Base58 `1` represents a zero byte, so each leading `1` has a probability of `1/256`.

Each worker generates 500 keys per telemetry batch. The main thread combines worker rates with an EWMA and extrapolates the countdown and probability bar with `requestAnimationFrame`.

The interface uses hard complexity caps to keep searches practical:

| Engine | Maximum locked characters |
| --- | --- |
| EVM | 7 |
| Solana, exact case | 5 |
| Solana, case-insensitive | 6 |

Case-insensitive Solana matching multiplies the hit probability by `2^L`, where `L` is the number of letters in the ending word. For example, `RAK1B` has four letters, so enabling the option gives a `16x` probability boost.

## Quick start

Open `index.html` in a current browser.

Or run the bundled local server:

```bash
npm install
npm run serve
```

Then visit `http://localhost:4173`.

## Build

```bash
npm install
npm run build
```

The build creates a single self-contained `index.html` with the app, fonts, crypto libraries, and worker code embedded.

## Security

- Private keys are generated with `crypto.getRandomValues`.
- Key material stays in browser memory and is never sent anywhere.
- The page uses a strict CSP with `connect-src 'none'`.
- Nothing is saved to local storage or cookies automatically.
- Download a `.txt` backup before leaving the result screen.
- The app creates raw single-address keys, not seed phrases.
- Use an offline device for wallets that will hold meaningful funds.

## Project structure

```text
index.html        self-contained production app
src/app.js        UI, pattern logic, telemetry, vault
src/worker.js     crypto and matching workers
src/styles.css    visual system
src/template.html app shell
build.mjs         single-file build
serve.mjs         local static server
```

## Stack

Vanilla JavaScript, inline Web Workers, `@noble/secp256k1`, `@noble/curves`, `@noble/hashes`, `bs58`, Inter, and JetBrains Mono.

All third-party libraries and fonts keep their original licenses. See their respective repositories for details.

## Repository

https://github.com/0xnurrabby/posh-forge
