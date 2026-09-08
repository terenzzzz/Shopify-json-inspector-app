import JSZip from "jszip";
import {
  normalizeCdn,
  normalizeImageName,
  normalizeMediaName,
  normalizeVideoName,
} from "./inspector";

const SHOPIFY_MAX_IMAGE_WIDTH = 5760;
/** 图片请求超时（含响应体） */
const IMAGE_FETCH_TIMEOUT_MS = 30000;
/** 视频建连超时；传输出空闲超时；硬上限按体积估算 */
const VIDEO_CONNECT_TIMEOUT_MS = 45000;
const VIDEO_IDLE_TIMEOUT_MS = 25000;
const VIDEO_FETCH_TIMEOUT_MS = 180000;
const VIDEO_FETCH_TIMEOUT_MAX_MS = 600000;
/** 视频过大时分片并行拉取（CDN 支持 Range 时可显著提速） */
const VIDEO_PARALLEL_MIN_BYTES = 6 * 1024 * 1024;
const VIDEO_PARALLEL_PARTS = 3;
/** 图片可略高并发；视频 3 路 + 分片，兼顾吞吐与稳定性 */
const IMAGE_DOWNLOAD_CONCURRENCY = 6;
const VIDEO_DOWNLOAD_CONCURRENCY = 3;
const MIXED_DOWNLOAD_CONCURRENCY = 4;
/** @deprecated 兼容旧调用；等同图片超时 */
const FETCH_TIMEOUT_MS = IMAGE_FETCH_TIMEOUT_MS;

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
  originalSources,
}) {
  clearDownloadSession();
  currentDownloadSession = createDownloadSession({
    images,
    videos: [],
    cdnPrefix,
    zipBaseName,
    mode,
    zipSuffix: "",
    originalSources,
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
  originalSources,
}) {
  clearDownloadSession();
  currentDownloadSession = createDownloadSession({
    images,
    videos: mode === "original" ? videos : [],
    cdnPrefix,
    zipBaseName,
    mode,
    zipSuffix: "",
    originalSources,
  });
  return runDownloadSession(currentDownloadSession, onProgress);
}

export async function downloadVideosAsZip({
  videos,
  zipBaseName,
  mode,
  onProgress,
  originalSources,
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
    originalSources,
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

function createDownloadSession({
  images,
  videos,
  cdnPrefix,
  zipBaseName,
  mode,
  zipSuffix,
  originalSources,
}) {
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
    originalSources: seedOriginalSources(originalSources),
    unresolved: [],
    failureReasons: new Map(),
    kindByName,
  };
}

function seedOriginalSources(sources) {
  const map = new Map();
  if (!sources) return map;

  const entries =
    sources instanceof Map
      ? sources.entries()
      : Object.entries(sources || {});

  for (const [rawName, source] of entries) {
    const name = normalizeMediaName(rawName);
    if (!name || !source) continue;
    map.set(name, source);
  }

  return map;
}

async function runDownloadSession(session, onProgress) {
  const total = session.images.length + session.videos.length;
  let lastProgressAt = 0;
  let pendingProgress = null;
  let progressFlushTimer = null;

  const flushProgress = () => {
    if (!pendingProgress) return;
    const { done, meta } = pendingProgress;
    pendingProgress = null;
    progressFlushTimer = null;
    lastProgressAt = Date.now();

    const failedNames = session.pending.filter(
      (name) => session.failureReasons.has(name) || session.unresolved.includes(name),
    );
    onProgress?.(done, total, {
      current: meta.current,
      phase: meta.phase || "download",
      failed: failedNames.length,
      unresolved: session.unresolved.length,
      failedNames,
      unresolvedNames: [...session.unresolved],
      failureReasons: Object.fromEntries(session.failureReasons),
    });
  };

  const emitProgress = (done, meta = {}, { force = false } = {}) => {
    pendingProgress = { done, meta };
    const elapsed = Date.now() - lastProgressAt;
    if (force || elapsed >= 120 || done >= total || done === 0) {
      if (progressFlushTimer) {
        clearTimeout(progressFlushTimer);
        progressFlushTimer = null;
      }
      flushProgress();
      return;
    }
    if (!progressFlushTimer) {
      progressFlushTimer = setTimeout(flushProgress, 120 - elapsed);
    }
  };

  try {
    if (session.mode === "original") {
      await resolvePendingOriginalSources(session, emitProgress);
    } else if (!normalizeCdn(session.cdnPrefix)) {
      throw new Error("请先填写店铺域名");
    }

    const retryablePending = sortPendingForDownload(
      session,
      session.pending.filter((name) => !session.unresolved.includes(name)),
    );
    let finished = total - retryablePending.length;
    const concurrency = pickDownloadConcurrency(session, retryablePending);

    emitProgress(finished, { phase: "download" }, { force: true });

    await mapPool(retryablePending, concurrency, async (name) => {
      try {
        const kind = session.kindByName.get(name) || "image";
        const entry =
          session.mode === "original" || kind === "video"
            ? await fetchOriginalEntry(name, session.originalSources, kind)
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
        emitProgress(finished, { current: name, phase: "download" });
      }
    });

    emitProgress(finished, { phase: "download" }, { force: true });
  } finally {
    if (progressFlushTimer) {
      clearTimeout(progressFlushTimer);
      progressFlushTimer = null;
    }
    flushProgress();
  }

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

async function resolvePendingOriginalSources(session, emitProgress) {
  const toResolve = session.pending.filter((name) => {
    const existing = session.originalSources.get(name);
    return !existing?.url;
  });
  const total = session.images.length + session.videos.length;
  let resolved = total - toResolve.length;

  // 预览阶段已确认无 URL 的文件，直接记为失败
  markMissingOriginalSources(session);
  emitProgress(resolved, { phase: "resolve" });

  if (!toResolve.length) return;

  const BATCH_SIZE = 20;
  for (let offset = 0; offset < toResolve.length; offset += BATCH_SIZE) {
    const batch = toResolve.slice(offset, offset + BATCH_SIZE);
    emitProgress(resolved, { current: batch[0], phase: "resolve" });

    const originals = await resolveOriginalSources(batch);

    for (const name of batch) {
      const source = originals.get(name);
      if (source?.url) {
        session.originalSources.set(name, source);
        session.failureReasons.delete(name);
        session.unresolved = session.unresolved.filter((item) => item !== name);
      } else if (!session.unresolved.includes(name)) {
        session.unresolved.push(name);
        session.failureReasons.set(name, "后台 Files 未找到");
      }
      resolved += 1;
      emitProgress(resolved, { current: name, phase: "resolve" });
    }
  }

  markMissingOriginalSources(session);
  emitProgress(resolved, { phase: "resolve" });
}

function markMissingOriginalSources(session) {
  for (const name of session.pending) {
    if (session.originalSources.get(name)?.url) continue;
    if (!session.unresolved.includes(name)) {
      session.unresolved.push(name);
    }
    if (!session.failureReasons.has(name)) {
      session.failureReasons.set(name, "后台 Files 未找到");
    }
  }
}

function buildZipFromSession(session) {
  const zip = new JSZip();
  const folder = zip.folder(normalizeZipBaseName(session.zipBaseName));
  const usedEntryNames = new Set();
  const orderedNames = [...session.images, ...session.videos];
  // 图片/视频本身已压缩，STORE 可大幅加快打包且几乎不增大体积
  const storeOpts = { compression: "STORE" };

  for (const name of orderedNames) {
    const entry = session.completed.get(name);
    if (!entry) continue;
    const fileName = flattenZipEntryName(entry.fileName, usedEntryNames);
    folder.file(fileName, entry.blob, storeOpts);
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
  const content = await zip.generateAsync({
    type: "blob",
    // 媒体已用 STORE；清单等小文本默认压缩即可
    compression: "DEFLATE",
    compressionOptions: { level: 1 },
    streamFiles: true,
  });
  const filename = `${normalizeZipBaseName(zipBaseName)}${zipSuffix || ""}.zip`;
  saveBlob(content, filename);
}

async function resolveOriginalSources(filenames) {
  const response = await fetch("/app/original-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filenames }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.error || `原图解析失败：HTTP ${response.status}`);
  }

  return new Map(
    Object.entries(payload.sources || {}).map(([filename, source]) => [
      normalizeMediaName(filename),
      source,
    ]),
  );
}

async function fetchOriginalEntry(name, originalSources, kind = "image") {
  const source = originalSources.get(name);
  if (!source?.url) {
    throw new DownloadError("后台 Files 未找到", { permanent: true });
  }

  try {
    const blob =
      kind === "video"
        ? await fetchVideoBlob(source.url, source.fileSize)
        : await fetchBlobWithTimeout(source.url, {}, IMAGE_FETCH_TIMEOUT_MS);

    const fileName = keepOriginalOrAddExt(
      name,
      source.mimeType || blob.type || "",
    );

    return { fileName, blob };
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (error?.name === "AbortError") {
      throw new DownloadError(
        `请求超时（${Math.round(timeoutForEntry(kind, source.fileSize) / 1000)}s）`,
      );
    }
    throw error;
  }
}

/**
 * 视频：大文件优先 Range 分片并行；失败则回退单连接流式下载。
 * 用「建连超时 + 传输空闲超时」替代整段绝对超时，避免误杀慢但在传的大文件。
 */
async function fetchVideoBlob(url, knownSize) {
  const size = Number(knownSize) || 0;

  if (size >= VIDEO_PARALLEL_MIN_BYTES) {
    try {
      return await fetchBlobInParallelRanges(url, size);
    } catch (error) {
      console.warn("视频分片并行下载失败，回退单连接:", error);
    }
  }

  return fetchBlobWithIdleTimeout(url, {
    connectTimeoutMs: VIDEO_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: VIDEO_IDLE_TIMEOUT_MS,
    hardTimeoutMs: timeoutForEntry("video", size),
  });
}

async function fetchBlobInParallelRanges(url, fileSize) {
  const parts = VIDEO_PARALLEL_PARTS;
  const chunkSize = Math.ceil(fileSize / parts);
  const hardTimeoutMs = timeoutForEntry("video", fileSize);
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), hardTimeoutMs);

  try {
    const chunks = await Promise.all(
      Array.from({ length: parts }, async (_, index) => {
        const start = index * chunkSize;
        const end = Math.min(fileSize - 1, (index + 1) * chunkSize - 1);
        const response = await fetch(url, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: controller.signal,
        });

        // 必须是 206；若 CDN 忽略 Range 回 200，整文件会下多次，直接失败回退
        if (response.status !== 206) {
          throw new DownloadError(`Range 不受支持（HTTP ${response.status}）`);
        }

        const blob = await readResponseBlobWithIdle(
          response,
          VIDEO_IDLE_TIMEOUT_MS,
          controller,
        );
        return { index, blob };
      }),
    );

    chunks.sort((a, b) => a.index - b.index);
    const blob = new Blob(
      chunks.map((chunk) => chunk.blob),
      { type: chunks[0]?.blob?.type || "" },
    );
    // fileSize 偶发不准；明显偏小则回退整文件下载
    if (blob.size + 1024 < fileSize * 0.95) {
      throw new DownloadError(`分片不完整（${blob.size}/${fileSize}）`);
    }
    return blob;
  } finally {
    clearTimeout(hardTimer);
  }
}

async function fetchBlobWithTimeout(url, options = {}, timeoutMs = IMAGE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 410) {
      throw new DownloadError(`HTTP ${response.status}`, {
        permanent: true,
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new DownloadError(`HTTP ${response.status}`, { status: response.status });
    }
    return await response.blob();
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (error?.name === "AbortError") {
      throw new DownloadError(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBlobWithIdleTimeout(
  url,
  {
    connectTimeoutMs = VIDEO_CONNECT_TIMEOUT_MS,
    idleTimeoutMs = VIDEO_IDLE_TIMEOUT_MS,
    hardTimeoutMs = VIDEO_FETCH_TIMEOUT_MAX_MS,
    headers,
  } = {},
) {
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), hardTimeoutMs);
  const connectTimer = setTimeout(() => controller.abort(), connectTimeoutMs);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(connectTimer);

    if (response.status === 404 || response.status === 410) {
      throw new DownloadError(`HTTP ${response.status}`, {
        permanent: true,
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new DownloadError(`HTTP ${response.status}`, { status: response.status });
    }

    return await readResponseBlobWithIdle(response, idleTimeoutMs, controller);
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (error?.name === "AbortError") {
      throw new DownloadError(
        `请求超时（空闲 ${Math.round(idleTimeoutMs / 1000)}s / 上限 ${Math.round(hardTimeoutMs / 1000)}s）`,
      );
    }
    throw error;
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(connectTimer);
  }
}

async function readResponseBlobWithIdle(response, idleTimeoutMs, controller) {
  if (!response.body?.getReader) {
    return response.blob();
  }

  let idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };

  try {
    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdle();
      chunks.push(value);
    }
    return new Blob(chunks, {
      type: response.headers.get("content-type") || "",
    });
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * 视频并发过高时，排队中的 fetch 会先烧完 AbortController 再真正发出请求。
 * 3 路文件并发 + 大文件分片，在吞吐和稳定性之间折中。
 */
function pickDownloadConcurrency(session, pending) {
  if (!pending.length) return IMAGE_DOWNLOAD_CONCURRENCY;

  let videoCount = 0;
  for (const name of pending) {
    if (session.kindByName.get(name) === "video") videoCount += 1;
  }

  if (videoCount === 0) return IMAGE_DOWNLOAD_CONCURRENCY;
  if (videoCount === pending.length) return VIDEO_DOWNLOAD_CONCURRENCY;
  return MIXED_DOWNLOAD_CONCURRENCY;
}

/** 小文件优先，尽快腾出连接并改善进度反馈 */
function sortPendingForDownload(session, pending) {
  return [...pending].sort((a, b) => {
    const sizeA = Number(session.originalSources.get(a)?.fileSize) || 0;
    const sizeB = Number(session.originalSources.get(b)?.fileSize) || 0;
    if (sizeA !== sizeB) return sizeA - sizeB;

    const kindA = session.kindByName.get(a) === "video" ? 1 : 0;
    const kindB = session.kindByName.get(b) === "video" ? 1 : 0;
    return kindA - kindB;
  });
}

/** 按体积估算硬超时上限：约 1.5s/MB，视频下限 180s、上限 10min */
function timeoutForEntry(kind, fileSize) {
  if (kind !== "video") return IMAGE_FETCH_TIMEOUT_MS;

  const bytes = Number(fileSize) || 0;
  if (!bytes) return VIDEO_FETCH_TIMEOUT_MS;

  const mb = bytes / (1024 * 1024);
  const estimated = Math.ceil(VIDEO_FETCH_TIMEOUT_MS + mb * 1500);
  return Math.min(VIDEO_FETCH_TIMEOUT_MAX_MS, Math.max(VIDEO_FETCH_TIMEOUT_MS, estimated));
}

async function fetchCdnEntry(name, cdnPrefix) {
  const prefix = normalizeCdn(cdnPrefix);
  if (!prefix) throw new Error("请先填写店铺域名");

  const expectedMime = mimeForExt(getExtFromFilename(name));
  const accept = buildAcceptForName(name);
  const blob = await fetchBestQualityBlob(prefix, name, accept, expectedMime);

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

async function fetchBestQualityBlob(cdnPrefix, name, accept, expectedMime) {
  let bestBlob = null;
  const responseStatuses = [];
  let hasNetworkFailure = false;

  // 候选按质量优先排序；成功且格式匹配则立即返回，避免把同一张图下多遍
  for (const url of buildDownloadUrlCandidates(cdnPrefix, name)) {
    try {
      // 按扩展名声明 Accept，避免 CDN 内容协商成错误格式
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: accept,
          "Cache-Control": "no-transform",
        },
      });

      if (!response.ok) {
        responseStatuses.push(response.status);
        continue;
      }

      const blob = await response.blob();
      if (!expectedMime || blob.type === expectedMime || !blob.type) {
        return blob;
      }
      if (!bestBlob || isBetterBlob(blob, bestBlob, expectedMime)) {
        bestBlob = blob;
      }
    } catch {
      hasNetworkFailure = true;
    }
  }

  if (!bestBlob) {
    const onlyNotFound =
      responseStatuses.length > 0 &&
      responseStatuses.every((status) => status === 404 || status === 410) &&
      !hasNetworkFailure;
    if (onlyNotFound) {
      throw new DownloadError("HTTP 404", { permanent: true, status: 404 });
    }
    throw new DownloadError("fetch failed");
  }

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

function buildAcceptForName(filename) {
  const mime = mimeForExt(getExtFromFilename(filename));
  if (mime) return `${mime};q=1.0, image/*;q=0.01`;
  return "image/*";
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
