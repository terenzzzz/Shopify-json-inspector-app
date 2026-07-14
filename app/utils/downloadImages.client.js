import JSZip from "jszip";
import {
  normalizeCdn,
  normalizeImageName,
  normalizeMediaName,
  normalizeVideoName,
} from "./inspector";

const SHOPIFY_MAX_IMAGE_WIDTH = 5760;

export async function downloadImagesAsZip({
  images,
  cdnPrefix,
  zipBaseName,
  mode,
  onProgress,
}) {
  const normalizedImages = images.map(normalizeImageName).filter(Boolean);
  if (!normalizedImages.length) {
    throw new Error("没有可下载的图片");
  }

  const originalSources =
    mode === "original" ? await resolveOriginalSources(normalizedImages) : new Map();

  const zip = new JSZip();
  const folderName = normalizeZipBaseName(zipBaseName);
  const zipFileName = `${folderName}.zip`;
  const folder = zip.folder(folderName);
  const usedEntryNames = new Set();
  let success = 0;
  const failed = [];

  for (const name of normalizedImages) {
    try {
      const entry =
        mode === "original"
          ? await fetchOriginalEntry(name, originalSources)
          : await fetchCdnEntry(name, cdnPrefix);
      const fileName = flattenZipEntryName(entry.fileName, usedEntryNames);
      folder.file(fileName, entry.blob);
      success += 1;
    } catch (error) {
      console.warn("图片下载失败:", name, error);
      failed.push(name);
    } finally {
      onProgress?.(success + failed.length, normalizedImages.length);
    }
  }

  if (success > 0) {
    const content = await zip.generateAsync({ type: "blob" });
    saveBlob(content, zipFileName);
  }

  return {
    success,
    failed,
    unresolved: mode === "original" ? findUnresolved(normalizedImages, originalSources) : [],
  };
}

export async function downloadMediaAsZip({
  images = [],
  videos = [],
  cdnPrefix,
  zipBaseName,
  mode,
  onProgress,
}) {
  const normalizedImages = images.map(normalizeImageName).filter(Boolean);
  const normalizedVideos = mode === "original" ? videos.map(normalizeVideoName).filter(Boolean) : [];
  const total = normalizedImages.length + normalizedVideos.length;

  if (!total) {
    throw new Error("没有可下载的文件");
  }

  const originalSources =
    mode === "original"
      ? await resolveOriginalSources([...normalizedImages, ...normalizedVideos])
      : new Map();

  const zip = new JSZip();
  const folderName = normalizeZipBaseName(zipBaseName);
  const zipFileName = `${folderName}.zip`;
  const folder = zip.folder(folderName);
  const usedEntryNames = new Set();
  let success = 0;
  const failed = [];

  async function addItem(name, fetchEntry) {
    try {
      const entry = await fetchEntry();
      const fileName = flattenZipEntryName(entry.fileName, usedEntryNames);
      folder.file(fileName, entry.blob);
      success += 1;
    } catch (error) {
      console.warn("文件下载失败:", name, error);
      failed.push(name);
    } finally {
      onProgress?.(success + failed.length, total);
    }
  }

  for (const name of normalizedImages) {
    await addItem(name, () =>
      mode === "original"
        ? fetchOriginalEntry(name, originalSources)
        : fetchCdnEntry(name, cdnPrefix),
    );
  }

  for (const name of normalizedVideos) {
    await addItem(name, () => fetchOriginalEntry(name, originalSources));
  }

  if (success > 0) {
    const content = await zip.generateAsync({ type: "blob" });
    saveBlob(content, zipFileName);
  }

  return {
    success,
    failed,
    unresolved:
      mode === "original"
        ? findUnresolved([...normalizedImages, ...normalizedVideos], originalSources)
        : [],
  };
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

  const normalizedVideos = videos.map(normalizeVideoName).filter(Boolean);
  if (!normalizedVideos.length) {
    throw new Error("没有可下载的视频");
  }

  const originalSources = await resolveOriginalSources(normalizedVideos);

  const zip = new JSZip();
  const folderName = normalizeZipBaseName(zipBaseName);
  const zipFileName = `${folderName}-videos.zip`;
  const folder = zip.folder(folderName);
  const usedEntryNames = new Set();
  let success = 0;
  const failed = [];

  for (const name of normalizedVideos) {
    try {
      const entry = await fetchOriginalEntry(name, originalSources);
      const fileName = flattenZipEntryName(entry.fileName, usedEntryNames);
      folder.file(fileName, entry.blob);
      success += 1;
    } catch (error) {
      console.warn("视频下载失败:", name, error);
      failed.push(name);
    } finally {
      onProgress?.(success + failed.length, normalizedVideos.length);
    }
  }

  if (success > 0) {
    const content = await zip.generateAsync({ type: "blob" });
    saveBlob(content, zipFileName);
  }

  return {
    success,
    failed,
    unresolved: findUnresolved(normalizedVideos, originalSources),
  };
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

async function fetchOriginalEntry(name, originalSources) {
  const source = originalSources.get(name);
  if (!source?.url) {
    throw new Error("original source not found");
  }

  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

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
  const accept = expectedMime ? `${expectedMime};q=1.0, image/*;q=0.01` : "image/*";
  const blob = await fetchBestQualityBlob(prefix, name, accept, expectedMime);

  return {
    fileName: keepOriginalOrAddExt(name, blob.type),
    blob,
  };
}

async function fetchBestQualityBlob(cdnPrefix, name, accept, expectedMime) {
  let bestBlob = null;

  for (const url of buildDownloadUrlCandidates(cdnPrefix, name)) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: accept,
          "Cache-Control": "no-transform",
        },
      });
      if (!response.ok) continue;

      const blob = await response.blob();
      if (!bestBlob || isBetterBlob(blob, bestBlob, expectedMime)) {
        bestBlob = blob;
      }
      if (expectedMime && blob.type === expectedMime) return blob;
    } catch (error) {
      console.debug("跳过不可用的图片候选 URL:", url, error);
    }
  }

  if (!bestBlob) throw new Error("fetch failed");
  return bestBlob;
}

function buildDownloadUrlCandidates(cdnPrefix, name) {
  const encoded = encodePathSegment(name);
  const baseUrl = `${cdnPrefix}${encoded}`;
  const urls = [buildDownloadUrl(cdnPrefix, name)];
  const format = extToFormat(getExtFromFilename(name));

  if (format) {
    urls.push(`${baseUrl}?${new URLSearchParams({ width: String(SHOPIFY_MAX_IMAGE_WIDTH) })}`);
    urls.push(`${baseUrl}?format=${format}`);
  }

  urls.push(baseUrl);
  return [...new Set(urls)];
}

function findUnresolved(images, originalSources) {
  return images.filter((name) => !originalSources.get(name)?.url);
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
  const value = String(mime || "").split(";")[0].trim().toLowerCase();
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
