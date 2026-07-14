import { authenticate } from "../shopify.server";
import {
  isVideoName,
  normalizeImageName,
  normalizeMediaName,
  normalizeVideoName,
} from "../utils/inspector";

const RESOLVE_ORIGINALS_QUERY = `#graphql
  query ResolveOriginalFiles($query: String!) {
    files(first: 20, query: $query) {
      nodes {
        ... on MediaImage {
          id
          mimeType
          image {
            url
          }
          imageOriginal: originalSource {
            url
            fileSize
          }
        }
        ... on Video {
          id
          videoOriginal: originalSource {
            url
            fileSize
            mimeType
            format
          }
          preview {
            image {
              url
            }
          }
        }
        ... on GenericFile {
          id
          fileUrl: url
          mimeType
          originalFileSize
        }
      }
    }
  }
`;

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const body = await request.json().catch(() => ({}));
  const filenames = Array.isArray(body.filenames)
    ? [
        ...new Set(
          body.filenames
            .map((filename) => normalizeMediaName(filename))
            .filter(Boolean),
        ),
      ]
    : [];

  if (!filenames.length) {
    return Response.json({ sources: {} });
  }

  const sources = {};
  const unresolved = {};

  await Promise.all(
    filenames.map(async (filename) => {
      try {
        const result = await resolveFileSource(admin, filename);
        const source = extractSourceFromNode(result.node);

        if (source?.url) {
          sources[filename] = source;
        } else {
          unresolved[filename] = result.attempts;
        }
      } catch (error) {
        console.warn("原文件解析失败:", filename, error);
        unresolved[filename] = [error.message || "unknown error"];
      }
    }),
  );

  return Response.json({ sources, unresolved });
};

export const loader = async () => {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

async function resolveFileSource(admin, filename) {
  const isVideo = isVideoName(filename);
  const candidates = buildFilenameCandidates(filename, isVideo);
  const attempts = [];

  for (const candidate of candidates) {
    for (const query of buildSearchQueries(candidate)) {
      attempts.push(query);

      const response = await admin.graphql(RESOLVE_ORIGINALS_QUERY, {
        variables: { query },
      });
      const payload = await response.json();
      if (payload?.errors?.length) {
        attempts.push(...payload.errors.map((error) => error.message));
        continue;
      }

      const nodes = payload?.data?.files?.nodes || [];
      const node = pickBestNode(nodes, filename, candidate, isVideo);

      if (extractSourceFromNode(node)?.url) {
        return { node, attempts };
      }
    }
  }

  return { node: null, attempts };
}

function extractSourceFromNode(node) {
  if (!node) return null;

  if (node.imageOriginal?.url) {
    return {
      url: node.imageOriginal.url,
      fileSize: node.imageOriginal.fileSize ?? null,
      mimeType: node.mimeType || null,
      previewUrl: node.image?.url || null,
      kind: "image",
    };
  }

  if (node.videoOriginal?.url) {
    return {
      url: node.videoOriginal.url,
      fileSize: node.videoOriginal.fileSize ?? null,
      mimeType: node.videoOriginal.mimeType || null,
      previewUrl: node.preview?.image?.url || null,
      kind: "video",
    };
  }

  if (node.fileUrl) {
    return {
      url: node.fileUrl,
      fileSize: node.originalFileSize ?? null,
      mimeType: node.mimeType || null,
      previewUrl: null,
      kind: "file",
    };
  }

  return null;
}

function buildSearchQueries(filename) {
  const value = escapeSearchValue(filename);
  const stem = escapeSearchValue(stripExtension(filename));
  const basename = escapeSearchValue(
    filename.includes("/") ? filename.slice(filename.lastIndexOf("/") + 1) : filename,
  );

  return [
    `filename:${value}`,
    `filename:${basename}`,
    `filename:${stem}*`,
    value,
    basename,
    stem,
  ].filter((query, index, list) => query && list.indexOf(query) === index);
}

function escapeSearchValue(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function buildFilenameCandidates(filename, isVideo) {
  const normalize = isVideo ? normalizeVideoName : normalizeImageName;
  const raw = normalize(filename);
  const decoded = safeDecode(raw);
  const withoutVideosPrefix = raw.replace(/^videos\//, "");
  const basename = basenameFromUrl(decoded);
  const withoutTransform = stripShopifyTransformSuffix(basename);
  const withoutExtension = stripExtension(withoutTransform);

  return [
    raw,
    decoded,
    withoutVideosPrefix,
    basename,
    withoutTransform,
    withoutExtension,
  ].filter((value, index, list) => value && list.indexOf(value) === index);
}

function pickBestNode(nodes, filename, candidate, isVideo) {
  if (!nodes?.length) return null;

  const wanted = new Set(buildFilenameCandidates(filename, isVideo));
  if (candidate) wanted.add(candidate);

  const exact = nodes.find((node) => {
    const matchValues = collectMatchValues(node, isVideo);
    return matchValues.some(
      (value) => wanted.has(value) || wanted.has(stripExtension(value)),
    );
  });
  if (extractSourceFromNode(exact)?.url) return exact;

  return nodes.find((node) => extractSourceFromNode(node)?.url) || nodes[0];
}

function collectMatchValues(node, isVideo) {
  const values = [];

  if (node?.image?.url) {
    const fromImageUrl = stripShopifyTransformSuffix(basenameFromUrl(node.image.url));
    values.push(fromImageUrl, stripExtension(fromImageUrl));
  }

  if (isVideo && node?.preview?.image?.url) {
    const fromPreview = basenameFromUrl(node.preview.image.url);
    values.push(fromPreview, stripExtension(fromPreview));
  }

  if (node?.fileUrl) {
    const fromFileUrl = basenameFromUrl(node.fileUrl);
    values.push(fromFileUrl, stripExtension(fromFileUrl));
  }

  return values.filter(Boolean);
}

function basenameFromUrl(url) {
  if (!url) return "";
  const clean = String(url).split("?")[0];
  const parts = clean.split("/");
  return safeDecode(parts[parts.length - 1] || "");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function stripExtension(filename) {
  const value = String(filename || "");
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(0, index) : value;
}

function stripShopifyTransformSuffix(filename) {
  const value = String(filename || "");
  return value.replace(
    /(_(?:pico|icon|thumb|small|compact|medium|large|grande|original|master|[0-9]+x[0-9]*|x[0-9]+))(?=\.[^.]+$)/i,
    "",
  );
}
