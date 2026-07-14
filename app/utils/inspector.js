const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".ogv",
  ".ogg",
  ".m4v",
  ".avi",
]);

export function cleanJson(raw) {
  return String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

export function parseTemplateJson(raw) {
  return JSON.parse(cleanJson(raw));
}

export function inspectTemplate(json, filename = "template.json") {
  return {
    stats: parseStats(json),
    images: parseImages(json),
    videos: parseVideos(json),
    tree: parseTemplateTree(json, filename),
  };
}

export function parseImages(json) {
  const images = new Set();

  walkJson(json, (value) => {
    if (typeof value === "string" && value.startsWith("shopify://shop_images/")) {
      images.add(value.replace("shopify://shop_images/", ""));
    }
  });

  return [...images];
}

export function parseVideos(json) {
  const videos = new Set();

  walkJson(json, (value) => {
    if (typeof value !== "string") return;

    if (value.startsWith("shopify://files/videos/")) {
      videos.add(value.replace("shopify://files/videos/", "videos/"));
    } else if (value.startsWith("shopify://shop_videos/")) {
      videos.add(value.replace("shopify://shop_videos/", ""));
    } else if (value.startsWith("shopify://shop_files/")) {
      const path = value.replace("shopify://shop_files/", "");
      if (isVideoPath(path)) videos.add(path);
    }
  });

  return [...videos];
}

export function parseStats(json) {
  const sections = json?.sections || {};
  let sectionCount = 0;
  let disabledSections = 0;
  let blockCount = 0;
  let disabledBlocks = 0;

  Object.values(sections).forEach((section) => {
    if (!section || !section.type) return;

    sectionCount += 1;
    if (section.disabled) disabledSections += 1;

    Object.values(section.blocks || {}).forEach((block) => {
      if (!block || !block.type) return;

      blockCount += 1;
      if (block.disabled) disabledBlocks += 1;
    });
  });

  const imageStats = parseImageStats(json);

  return {
    sections: {
      total: sectionCount,
      disabled: disabledSections,
      ratio: sectionCount ? disabledSections / sectionCount : 0,
    },
    blocks: {
      total: blockCount,
      disabled: disabledBlocks,
      ratio: blockCount ? disabledBlocks / blockCount : 0,
    },
    images: imageStats,
    complexity: calcComplexity({
      sections: sectionCount,
      blocks: blockCount,
      images: imageStats.references,
      disabledSections,
    }),
    signals: buildSignals({
      sectionCount,
      blockCount,
      imageStats,
      disabledSectionRatio: sectionCount ? disabledSections / sectionCount : 0,
      disabledBlockRatio: blockCount ? disabledBlocks / blockCount : 0,
    }),
  };
}

export function parseTemplateTree(templateJson, filename = "template.json") {
  const sectionsMap = templateJson.sections || {};
  const order = Array.isArray(templateJson.order)
    ? templateJson.order
    : Object.keys(sectionsMap);

  return {
    label: filename,
    children: order
      .map((sectionId) => {
        const section = sectionsMap[sectionId];
        if (!section) return null;

        return {
          label: sectionId,
          nodeType: "section",
          disabled: section.disabled === true,
          meta: [section.type].filter(Boolean).join(" · "),
          data: section,
          children: Object.entries(section.blocks || {}).map(([blockId, block]) => ({
            label: blockId,
            nodeType: "block",
            disabled: block?.disabled === true,
            meta: block?.type || "unknown",
            data: block,
          })),
        };
      })
      .filter(Boolean),
  };
}

export function normalizeCdn(prefix) {
  let value = String(prefix || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!value.endsWith("/files")) value += "/files";
  return `${value}/`;
}

export function normalizeImageName(rawName) {
  return String(rawName || "")
    .replace(/^shopify:\/\/shop_images\//, "")
    .split("?")[0]
    .replace(/^\/+/, "");
}

export function normalizeVideoName(rawName) {
  return String(rawName || "")
    .replace(/^shopify:\/\/files\/videos\//, "videos/")
    .replace(/^shopify:\/\/shop_videos\//, "")
    .replace(/^shopify:\/\/shop_files\//, "")
    .split("?")[0]
    .replace(/^\/+/, "");
}

export function isVideoName(rawName) {
  const value = normalizeVideoName(rawName).toLowerCase();
  if (value.startsWith("videos/")) return true;

  const index = value.lastIndexOf(".");
  return index !== -1 && VIDEO_EXTENSIONS.has(value.slice(index));
}

export function normalizeMediaName(rawName) {
  return isVideoName(rawName) ? normalizeVideoName(rawName) : normalizeImageName(rawName);
}

export function stripExt(name) {
  const value = String(name || "");
  const index = value.lastIndexOf(".");
  return index > 0 ? value.slice(0, index) : value;
}

function walkJson(value, visitor) {
  visitor(value);

  if (Array.isArray(value)) {
    value.forEach((item) => walkJson(item, visitor));
    return;
  }

  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => walkJson(item, visitor));
  }
}

function isVideoPath(path) {
  const lower = String(path || "").toLowerCase();
  const index = lower.lastIndexOf(".");
  return index !== -1 && VIDEO_EXTENSIONS.has(lower.slice(index));
}

function parseImageStats(json) {
  const map = new Map();

  walkJson(json, (value) => {
    if (typeof value === "string" && value.startsWith("shopify://shop_images/")) {
      const name = value.replace("shopify://shop_images/", "");
      map.set(name, (map.get(name) || 0) + 1);
    }
  });

  return {
    unique: map.size,
    references: [...map.values()].reduce((sum, count) => sum + count, 0),
    reused: [...map.values()].filter((count) => count > 1).length,
  };
}

function calcComplexity({ sections, blocks, images, disabledSections }) {
  const score = sections * 2 + blocks + images * 1.5 + disabledSections * 0.5;
  let level = "Low";
  if (score > 80) level = "High";
  else if (score > 40) level = "Medium";

  return { score: Math.round(score), level };
}

function buildSignals({
  sectionCount,
  blockCount,
  imageStats,
  disabledSectionRatio,
  disabledBlockRatio,
}) {
  const signals = [];

  if (disabledSectionRatio > 0.3) signals.push("已禁用版块占比过高");
  if (disabledBlockRatio > 0.4) signals.push("已禁用块较多");
  if (imageStats.references > 40) signals.push("图片引用较多");
  if (imageStats.reused > imageStats.unique * 0.4) {
    signals.push("图片复用耦合较高");
  }
  if (sectionCount > 18) signals.push("版块数量过多");
  if (blockCount > 50) signals.push("块结构较复杂");

  return signals;
}
