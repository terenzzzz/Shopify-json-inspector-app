import JSZip from "jszip";
import {
  normalizeCdn,
  normalizeImageName,
  normalizeMediaName,
  normalizeVideoName,
} from "./inspector";

const SHOPIFY_MAX_IMAGE_WIDTH = 5760;
const FETCH_TIMEOUT_MS = 12000;
const DOWNLOAD_CONCURRENCY = 4;

/** @type {DownloadSession | null} */
let currentDownloadSession = null;

/**
 * @typedef {object} DownloadSession
 * @property {string[]} images
 * @property {string[]} videos
 * @property {string} cdnPrefix
 * @property {string} zipBaseName
 * @property {'cdn'|'original'} mode
 * @property {string} zipSuffix
 * @property {Map<string, { fileName: string, blob: Blob }>} completed
 * @property {string[]} pending
 * @property {Map<string, { url?: string, mimeType?: string }>} originalSources
 * @property {string[]} unresolved
 * @property {Map<string, string>} failureReasons
 * @property {Map<string, 'image'|'video'>} kindByName
 */

class DownloadError extends Error {
  /**
   * @param {string} message
   * @param {{ permanent?: boolean, status?: number }} [opts]
   */
  constructor(message, { permanent = false, status = 0 } = {}) {
    super(message);
    this.name = "DownloadError";
    this.permanent = permanent;
    this.status = status;
  }
}

export function canResumeDownload() {
  return Boolean(
    currentDownloadSession?.pending?.some(
      (name) => !currentDownloadSession.unresolved.includes(name),
    ),
  );
}

export function clearDownloadSession() {
  currentDownloadSession = null;
}

export function getDownloadSessionSnapshot() {
  if (!currentDownloadSession) return null;
  return {
    success: currentDownloadSession.completed.size,
    failed: [...currentDownloadSession.pending],
    unresolved: [...currentDownloadSession.unresolved],
    failureReasons: Object.fromEntries(currentDownloadSession.failureReasons),
    canResume: canResumeDownload(),
    partial: currentDownloadSession.completed.size > 0,
  };
}

export async function resumeDownload({ onProgress } = {}) {
  if (!canResumeDownload()) return null;
  return runDownloadSession(currentDownloadSession, onProgress);
}

export async function downloadImagesAsZip({
  images,
  cdnPrefix,
  zipBaseName,
  mode,
  onProgress,
}) {
  clearDownloadSession();
  currentDownloadSession = createDownloadSession({
    images,
    videos: [],
    cdnPrefix,
    zipBaseName,
    mode,
    zipSuffix: "",
  });
  return runDownloadSession(currentDownloadSession, onProgress);
}

export async function downloadMediaAsZip({
  images = [],
  videos = [],
  cdnPrefix,
  zipBaseName,
  mode,
  onProgress,
}) {
  clearDownloadSession();
  currentDownloadSession = createDownloadSession({
    images,
    videos: mode === "original" ? videos : [],
    cdnPrefix,
    zipBaseName,
    mode,
    zipSuffix: "",
  });
  return runDownloadSession(currentDownloadSession, onProgress);
}

export async function downloadVideosAsZip({
  videos,
  zipBaseName,
  mode,
  onProgress,
}) {
  if (mode !== "original") {
    throw new Error("视频下载目前仅支持原图模式");
  }

  clearDownloadSession();
  currentDownloadSession = createDownloadSession({
    images: [],
    videos,
    cdnPrefix: "",
    zipBaseName,
    mode,
    zipSuffix: "-videos",
  });
  return runDownloadSession(currentDownloadSession, onProgress);
}

export async function fetchDownloadImageSize(cdnPrefix, rawName) {
  if (!cdnPrefix) return null;

  try {
    const { blob } = await fetchCdnEntry(normalizeImageName(rawName), cdnPrefix);
    return blob.size;
  } catch {
    return null;
  }
}

export function buildDownloadUrl(cdnPrefix, name) {
  const prefix = normalizeCdn(cdnPrefix);
  const baseUrl = `${prefix}${encodePathSegment(name)}`;
  const params = new URLSearchParams();
  params.set("width", String(SHOPIFY_MAX_IMAGE_WIDTH));

  const format = extToFormat(getExtFromFilename(name));
  if (format) params.set("format", format);

  return `${baseUrl}?${params.toString()}`;
}

function createDownloadSession({ images, videos, cdnPrefix, zipBaseName, mode, zipSuffix }) {
  const normalizedImages = images.map(normalizeImageName).filter(Boolean);
  const normalizedVideos =
    mode === "original" ? videos.map(normalizeVideoName).filter(Boolean) : [];

  if (!normalizedImages.length && !normalizedVideos.length) {
    throw new Error("没有可下载的文件");
  }

  const kindByName = new Map([
    ...normalizedImages.map((name) => /** @type {const} */ ([name, "image"])),
    ...normalizedVideos.map((name) => /** @type {const} */ ([name, "video"])),
  ]);

  return {
    images: normalizedImages,
    videos: normalizedVideos,
    cdnPrefix,
    zipBaseName,
    mode: mode === "original" ? "original" : "cdn",
    zipSuffix: zipSuffix || "",
    completed: new Map(),
    pending: [...kindByName.keys()],
    originalSources: new Map(),
    unresolved: [],
    failureReasons: new Map(),
    kindByName,
  };
}

async function runDownloadSession(session, onProgress) {
  if (session.mode === "original") {
    await resolvePendingOriginalSources(session, onProgress);
  } else if (!normalizeCdn(session.cdnPrefix)) {
    throw new Error("请先填写 CDN 前缀");
  }

  const retryablePending = session.pending.filter(
    (name) => !session.unresolved.includes(name),
  );
  const total = session.images.length + session.videos.length;
  let finished = total - retryablePending.length;

  onProgress?.(finished, total, {
    failed: session.pending.length,
    unresolved: session.unresolved.length,
  });

  await mapPool(retryablePending, DOWNLOAD_CONCURRENCY, async (name) => {
    try {
      const kind = session.kindByName.get(name) || "image";
      const entry =
        session.mode === "original" || kind === "video"
          ? await fetchOriginalEntry(name, session.originalSources)
          : await fetchCdnEntry(name, session.cdnPrefix);

      session.completed.set(name, entry);
      session.pending = session.pending.filter((item) => item !== name);
      session.failureReasons.delete(name);
    } catch (error) {
      const reason = formatFailureReason(error);
      session.failureReasons.set(name, reason);
      if (isPermanentFailure(error) && !session.unresolved.includes(name)) {
        session.unresolved.push(name);
      }
      console.warn("文件下载失败:", name, error);
    } finally {
      finished += 1;
      onProgress?.(finished, total, {
        current: name,
        failed: session.pending.length,
        unresolved: session.unresolved.length,
      });
    }
  });

  const success = session.completed.size;
  const failed = session.pending.length;
  const canRetry = session.pending.some((name) => !session.unresolved.includes(name));

  if (success > 0) {
    const zip = buildZipFromSession(session);
    await saveZip(zip, session.zipBaseName, session.zipSuffix);
  }

  if (failed === 0) {
    clearDownloadSession();
    return {
      success,
      failed: [],
      unresolved: [],
      canResume: false,
      partial: false,
      failedNames: [],
      failureReasons: {},
      mode: session.mode,
    };
  }

  if (!canRetry) {
    clearDownloadSession();
  }

  return {
    success,
    failed: [...session.pending],
    unresolved: [...session.unresolved],
    canResume: canRetry,
    partial: success > 0,
    failedNames: [...session.pending],
    failureReasons: Object.fromEntries(session.failureReasons),
    mode: session.mode,
  };
}

async function resolvePendingOriginalSources(session, onProgress) {
  const toResolve = session.pending.filter((name) => !session.originalSources.has(name));
  if (!toResolve.length) return;

  const originals = await resolveOriginalSources(toResolve, (done, total) => {
    onProgress?.(session.completed.size + done, session.images.length + session.videos.length + total, {
      phase: "resolve",
    });
  });

  for (const name of toResolve) {
    const source = originals.get(name);
    if (source?.url) {
      session.originalSources.set(name, source);
      continue;
    }

    if (!session.unresolved.includes(name)) {
      session.unresolved.push(name);
    }
    session.failureReasons.set(name, "后台 Files 未找到");
  }
}

function buildZipFromSession(session) {
  const zip = new JSZip();
  const folder = zip.folder(normalizeZipBaseName(session.zipBaseName));
  const usedEntryNames = new Set();
  const orderedNames = [...session.images, ...session.videos];

  for (const name of orderedNames) {
    const entry = session.completed.get(name);
    if (!entry) continue;
    const fileName = flattenZipEntryName(entry.fileName, usedEntryNames);
    folder.file(fileName, entry.blob);
  }

  if (session.pending.length) {
    const lines = session.pending.map((name) => {
      const reason =
        session.failureReasons.get(name) ||
        (session.unresolved.includes(name) ? "未找到" : "下载失败");
      return `${name}\t${reason}`;
    });
    folder.file("_failed.txt", `${lines.join("\n")}\n`);
  }

  const manifest = {
    exportedAt: new Date().toISOString(),
    mode: session.mode,
    success: orderedNames
      .filter((name) => session.completed.has(name))
      .map((name) => ({
        name,
        fileName: session.completed.get(name)?.fileName,
      })),
    failed: session.pending.map((name) => ({
      name,
      reason:
        session.failureReasons.get(name) ||
        (session.unresolved.includes(name) ? "未找到" : "下载失败"),
      permanent: session.unresolved.includes(name),
    })),
  };
  folder.file("_manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  return zip;
}

async function saveZip(zip, zipBaseName, zipSuffix = "") {
  const content = await zip.generateAsync({ type: "blob" });
  const filename = `${normalizeZipBaseName(zipBaseName)}${zipSuffix || ""}.zip`;
  saveBlob(content, filename);
}

async function resolveOriginalSources(filenames, onProgress) {
  const response = await fetch("/app/original-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filenames }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.error || `原图解析失败：HTTP ${response.status}`);
  }

  onProgress?.(filenames.length, filenames.length);

  return new Map(
    Object.entries(payload.sources || {}).map(([filename, source]) => [
      normalizeMediaName(filename),
      source,
    ]),
  );
}

async function fetchOriginalEntry(name, originalSources) {
  const source = originalSources.get(name);
  if (!source?.url) {
    throw new DownloadError("后台 Files 未找到", { permanent: true });
  }

  const response = await fetchWithTimeout(source.url);
  if (response.status === 404 || response.status === 410) {
    throw new DownloadError(`HTTP ${response.status}`, {
      permanent: true,
      status: response.status,
    });
  }
  if (!response.ok) {
    throw new DownloadError(`HTTP ${response.status}`, { status: response.status });
  }

  const fileName = keepOriginalOrAddExt(
    name,
    source.mimeType || response.headers.get("content-type") || "",
  );

  return { fileName, blob: await response.blob() };
}

async function fetchCdnEntry(name, cdnPrefix) {
  const prefix = normalizeCdn(cdnPrefix);
  if (!prefix) throw new Error("请先填写 CDN 前缀");

  const expectedMime = mimeForExt(getExtFromFilename(name));
  const blob = await fetchBestQualityBlob(prefix, name, expectedMime);

  return {
    fileName: keepOriginalOrAddExt(name, blob.type),
    blob,
  };
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} worker
 */
async function mapPool(items, concurrency, worker) {
  if (!items.length) return;

  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new DownloadError(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBestQualityBlob(cdnPrefix, name, expectedMime) {
  let bestBlob = null;
  let lastError = null;

  for (const url of buildDownloadUrlCandidates(cdnPrefix, name)) {
    try {
      // 不带自定义 Header，避免 CORS 预检；http CDN 常会 301 到 https
      const response = await fetchWithTimeout(url);

      if (response.status === 404 || response.status === 410) {
        throw new DownloadError(`HTTP ${response.status}`, {
          permanent: true,
          status: response.status,
        });
      }

      if (!response.ok) {
        lastError = new DownloadError(`HTTP ${response.status}`, { status: response.status });
        continue;
      }

      const blob = await response.blob();
      if (!bestBlob || isBetterBlob(blob, bestBlob, expectedMime)) {
        bestBlob = blob;
      }
      if (expectedMime && blob.type === expectedMime) return blob;
    } catch (error) {
      if (isPermanentFailure(error)) throw error;
      lastError = error;
    }
  }

  if (!bestBlob) throw lastError || new DownloadError("fetch failed");
  return bestBlob;
}

function buildDownloadUrlCandidates(cdnPrefix, name) {
  const encoded = encodePathSegment(name);
  const baseUrl = `${cdnPrefix}${encoded}`;
  const urls = [buildDownloadUrl(cdnPrefix, name)];
  const format = extToFormat(getExtFromFilename(name));

  if (format) {
    urls.push(`${baseUrl}?${new URLSearchParams({ width: String(SHOPIFY_MAX_IMAGE_WIDTH) })}`);
    urls.push(
      baseUrl.includes("?")
        ? `${baseUrl}&format=${format}`
        : `${baseUrl}?format=${format}`,
    );
  }

  urls.push(baseUrl);
  return [...new Set(urls)];
}

function isPermanentFailure(error) {
  return Boolean(error?.permanent);
}

function formatFailureReason(error) {
  if (!error) return "下载失败";
  if (error instanceof DownloadError) return error.message;
  if (error?.message) return error.message;
  return String(error);
}

function saveBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function normalizeZipBaseName(zipBaseName) {
  const name = String(zipBaseName || "shopify-images")
    .replace(/\.zip$/i, "")
    .trim()
    .split(/[/\\]+/)
    .pop();
  return name || "shopify-images";
}

function flattenZipEntryName(filename, usedNames) {
  const basename = String(filename || "")
    .split(/[/\\]+/)
    .pop()
    .trim();
  const safeName = basename || "image";

  if (!usedNames.has(safeName)) {
    usedNames.add(safeName);
    return safeName;
  }

  const ext = getExtFromFilename(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let index = 2;
  let candidate = `${stem}-${index}${ext}`;

  while (usedNames.has(candidate)) {
    index += 1;
    candidate = `${stem}-${index}${ext}`;
  }

  usedNames.add(candidate);
  return candidate;
}

function encodePathSegment(filename) {
  return filename.split("/").map(encodeURIComponent).join("/");
}

function getExtFromFilename(filename) {
  const index = filename.lastIndexOf(".");
  return index === -1 ? "" : filename.slice(index).toLowerCase();
}

function mimeForExt(ext) {
  switch (ext) {
    case ".webp":
      return "image/webp";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    default:
      return "";
  }
}

function extToFormat(ext) {
  switch (ext) {
    case ".webp":
      return "webp";
    case ".jpg":
    case ".jpeg":
      return "jpg";
    case ".png":
      return "png";
    case ".gif":
      return "gif";
    default:
      return "";
  }
}

function isBetterBlob(candidate, current, expectedMime) {
  if (expectedMime) {
    const candidateMatch = candidate.type === expectedMime;
    const currentMatch = current.type === expectedMime;
    if (candidateMatch !== currentMatch) return candidateMatch;
  }
  return candidate.size > current.size;
}

function keepOriginalOrAddExt(filename, mime) {
  if (getExtFromFilename(filename)) return filename;
  const ext = getExtFromMime(mime);
  return ext ? `${filename}${ext}` : filename;
}

function getExtFromMime(mime) {
  const value = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  switch (value) {
    case "image/webp":
      return ".webp";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "video/quicktime":
      return ".mov";
    case "video/ogg":
      return ".ogv";
    default:
      return "";
  }
}
