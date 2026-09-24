#!/usr/bin/env node

/**
 * Creates placeholder sidecar binaries for development mode.
 *
 * In dev mode, Tauri requires the sidecar binary files to exist at compile time,
 * even though developers typically run the Python server manually.
 *
 * This script creates minimal placeholder binaries that allow Tauri to compile.
 * The actual server should be started separately with `bun run dev:server`.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BINARIES_DIR = join(__dirname, '..', 'tauri', 'src-tauri', 'binaries');

// Minimum size to consider a binary "real" (placeholder is ~256 bytes, real is MBs)
const MIN_REAL_BINARY_SIZE = 10000;

// Get the current platform's target triple
function getTargetTriple() {
  try {
    const triple = execSync('rustc --print host-tuple', { encoding: 'utf-8' }).trim();
    return triple;
  } catch {
    // Fallback detection. Voicebox runs on Apple Silicon only.
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'darwin' && arch === 'arm64') {
      return 'aarch64-apple-darwin';
    }

    throw new Error(`Unsupported platform: ${platform}/${arch}`);
  }
}

// Create a minimal placeholder executable. ``baseName`` is the
// sidecar identifier as declared in tauri.conf.json's ``externalBin``
// (e.g. "voicebox-server"). Tauri appends the target
// triple to that name at compile time.
function createPlaceholderBinary(targetTriple, baseName) {
  const binaryName = `${baseName}-${targetTriple}`;
  const binaryPath = join(BINARIES_DIR, binaryName);

  // Check if real binary already exists (larger than our placeholder)
  if (existsSync(binaryPath)) {
    try {
      const stats = statSync(binaryPath);
      if (stats.size > MIN_REAL_BINARY_SIZE) {
        console.log(
          `Real binary already exists: ${binaryName} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`,
        );
        return;
      }
    } catch {
      // File exists but can't stat - try to replace it
    }
  }

  // Ensure binaries directory exists
  if (!existsSync(BINARIES_DIR)) {
    mkdirSync(BINARIES_DIR, { recursive: true });
  }

  // Create a minimal shell script for Unix-like systems
  const script = `#!/bin/sh
echo "[${baseName}] Dev mode placeholder - start the real server with: bun run dev:server"
exit 1
`;
  writeFileSync(binaryPath, script, { mode: 0o755 });

  console.log(`Created dev placeholder: ${binaryName}`);
}

// Every sidecar listed in tauri.conf.json's ``externalBin`` needs a
// file on disk at compile time, even in dev. Add to this list whenever
// a new sidecar is introduced.
const SIDECAR_BASE_NAMES = ['voicebox-server'];

function main() {
  const targetTriple = getTargetTriple();
  for (const baseName of SIDECAR_BASE_NAMES) {
    createPlaceholderBinary(targetTriple, baseName);
  }
}

main();
