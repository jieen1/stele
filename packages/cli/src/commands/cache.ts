import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  HASH_MANIFEST_RELATIVE_PATH,
  deleteHashManifest,
  readHashManifest,
} from "@stele/core";

export type CacheCleanResult = {
  removed: boolean;
  cachePath: string;
};

export type CacheInfoResult = {
  cachePath: string;
  exists: boolean;
  generatedAt?: string;
  steleVersion?: string;
  backend?: string;
  fileCount?: number;
  outputCount?: number;
  byteSize?: number;
};

export async function runCacheClean(projectDir: string): Promise<CacheCleanResult> {
  const absoluteProjectDir = resolve(projectDir);
  const cachePath = join(absoluteProjectDir, HASH_MANIFEST_RELATIVE_PATH);
  const removed = await deleteHashManifest(absoluteProjectDir);
  return { removed, cachePath };
}

export async function runCacheInfo(projectDir: string): Promise<CacheInfoResult> {
  const absoluteProjectDir = resolve(projectDir);
  const cachePath = join(absoluteProjectDir, HASH_MANIFEST_RELATIVE_PATH);
  const manifest = await readHashManifest(absoluteProjectDir);

  if (manifest === null) {
    return {
      cachePath,
      exists: false,
    };
  }

  let byteSize: number | undefined;
  try {
    byteSize = (await stat(cachePath)).size;
  } catch {
    byteSize = undefined;
  }

  return {
    cachePath,
    exists: true,
    generatedAt: manifest.generated_at,
    steleVersion: manifest.stele_version,
    backend: manifest.backend,
    fileCount: Object.keys(manifest.files).length,
    outputCount: Object.keys(manifest.output_hashes_global).length,
    byteSize,
  };
}

export function formatCacheClean(result: CacheCleanResult): string {
  if (result.removed) {
    return `OK cache cleaned: removed ${HASH_MANIFEST_RELATIVE_PATH}.\n`;
  }
  return `Cache already clean (no ${HASH_MANIFEST_RELATIVE_PATH}).\n`;
}

export function formatCacheInfo(result: CacheInfoResult): string {
  if (!result.exists) {
    return `No cache: ${HASH_MANIFEST_RELATIVE_PATH} does not exist.\n`;
  }

  const sizeKb = result.byteSize === undefined ? "?" : (result.byteSize / 1024).toFixed(1);
  return [
    `Cache: ${result.cachePath}`,
    `  generated_at: ${result.generatedAt}`,
    `  stele_version: ${result.steleVersion}`,
    `  backend: ${result.backend}`,
    `  files: ${result.fileCount}`,
    `  outputs: ${result.outputCount}`,
    `  size: ${sizeKb} KB`,
    "",
  ].join("\n");
}
