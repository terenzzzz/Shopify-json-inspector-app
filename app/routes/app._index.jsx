import { useEffect, useMemo, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  inspectTemplate,
  normalizeCdn,
  parseTemplateJson,
  stripExt,
} from "../utils/inspector";
import styles from "../styles/inspector.css?url";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const links = () => [{ rel: "stylesheet", href: styles }];

export default function Index() {
  const shopify = useAppBridge();
  const fileInputRef = useRef(null);
  const [rawJson, setRawJson] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [cdnPrefix, setCdnPrefix] = useState("");
  const [zipName, setZipName] = useState("");
  const [downloadMode, setDownloadMode] = useState("original");
  const [selectedImages, setSelectedImages] = useState(new Set());
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [selectedNode, setSelectedNode] = useState(null);
  const [downloadState, setDownloadState] = useState({
    loading: false,
    progress: null,
    result: "",
  });
  const [originalPreviewSources, setOriginalPreviewSources] = useState({});
  const [originalPreviewLoading, setOriginalPreviewLoading] = useState(false);
  const [shopThemes, setShopThemes] = useState([]);
  const [selectedThemeId, setSelectedThemeId] = useState("");
  const [themeTemplates, setThemeTemplates] = useState([]);
  const [themeTemplatesLoading, setThemeTemplatesLoading] = useState(true);
  const [themeTemplatesError, setThemeTemplatesError] = useState("");
  const [selectedThemeTemplate, setSelectedThemeTemplate] = useState("");
  const [themeTemplateLoading, setThemeTemplateLoading] = useState(false);

  const inspection = useMemo(() => {
    if (!rawJson.trim()) return null;

    try {
      const json = parseTemplateJson(rawJson);
      return inspectTemplate(json, sourceName || "template.json");
    } catch (error) {
      return { error: error.message };
    }
  }, [rawJson, sourceName]);

  const images = inspection?.images || [];
  const videos = inspection?.videos || [];
  const stats = inspection?.stats;
  const normalizedCdn = normalizeCdn(cdnPrefix);
  const selectedCount = selectedImages.size;
  const selectedVideoCount = selectedVideos.size;
  const defaultZipName = stripExt(sourceName || "shopify-images");
  const selectedImageList = images.filter((name) => selectedImages.has(name));
  const selectedVideoList = videos.filter((name) => selectedVideos.has(name));
  const imageKey = images.join("\0");
  const videoKey = videos.join("\0");
  const mediaKey = `${imageKey}\n${videoKey}`;

  const loadThemeData = async (themeId, signal) => {
    setThemeTemplatesLoading(true);
    setThemeTemplatesError("");

    try {
      const query = themeId ? `?themeId=${encodeURIComponent(themeId)}` : "";
      const response = await fetch(`/app/theme-templates${query}`, { signal });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || `主题模板列表加载失败：HTTP ${response.status}`);
      }

      if (signal?.aborted) return;

      setShopThemes(Array.isArray(payload.themes) ? payload.themes : []);
      setSelectedThemeId(payload.theme?.id || "");
      setThemeTemplates(Array.isArray(payload.templates) ? payload.templates : []);
      setSelectedThemeTemplate("");
      if (payload.error) {
        setThemeTemplatesError(payload.error);
      }
    } catch (error) {
      if (signal?.aborted) return;
      console.warn("主题模板列表加载失败:", error);
      setShopThemes([]);
      setSelectedThemeId("");
      setThemeTemplates([]);
      setSelectedThemeTemplate("");
      setThemeTemplatesError(error.message || "主题模板列表加载失败");
    } finally {
      if (!signal?.aborted) {
        setThemeTemplatesLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    loadThemeData("", controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (downloadMode !== "original" || (!images.length && !videos.length)) {
      setOriginalPreviewSources({});
      setOriginalPreviewLoading(false);
      return;
    }

    const controller = new AbortController();

    async function loadOriginalPreviews() {
      setOriginalPreviewLoading(true);

      try {
        const response = await fetch("/app/original-sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filenames: [...images, ...videos] }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(payload?.error || `原文件预览解析失败：HTTP ${response.status}`);
        }

        if (!controller.signal.aborted) {
          setOriginalPreviewSources(payload.sources || {});
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("原文件预览解析失败:", error);
        setOriginalPreviewSources({});
      } finally {
        if (!controller.signal.aborted) {
          setOriginalPreviewLoading(false);
        }
      }
    }

    loadOriginalPreviews();

    return () => controller.abort();
  }, [downloadMode, mediaKey]);

  const loadRawJson = (raw, filename) => {
    setRawJson(raw);
    setSourceName(filename);
    setSelectedImages(new Set());
    setSelectedVideos(new Set());
    setSelectedNode(null);
    setOriginalPreviewSources({});
    setDownloadState({ loading: false, progress: null, result: "" });
  };

  const onThemeChange = async (event) => {
    const themeId = event.currentTarget.value;
    if (!themeId || themeId === selectedThemeId) return;

    setSelectedThemeId(themeId);
    setSelectedThemeTemplate("");

    const controller = new AbortController();
    await loadThemeData(themeId, controller.signal);
  };

  const onThemeTemplateChange = async (event) => {
    const filename = event.currentTarget.value;
    setSelectedThemeTemplate(filename);

    if (!filename) return;
    if (!selectedThemeId) {
      shopify.toast.show("请先选择主题", { isError: true });
      return;
    }

    setThemeTemplateLoading(true);

    try {
      const response = await fetch("/app/theme-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeId: selectedThemeId, filename }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || `模板读取失败：HTTP ${response.status}`);
      }

      loadRawJson(payload.content || "", payload.filename || filename);
      shopify.toast.show(`已加载 ${payload.filename || filename}`);
    } catch (error) {
      console.warn("主题模板读取失败:", error);
      shopify.toast.show(error.message || "主题模板读取失败", { isError: true });
    } finally {
      setThemeTemplateLoading(false);
    }
  };

  const onFileChange = async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".json")) {
      shopify.toast.show("请选择 .json 文件", { isError: true });
      return;
    }

    loadRawJson(await file.text(), file.name);
    setSelectedThemeTemplate("");
  };

  const clearAll = () => {
    setRawJson("");
    setSourceName("");
    setSelectedThemeTemplate("");
    setCdnPrefix("");
    setZipName("");
    setDownloadMode("original");
    setSelectedImages(new Set());
    setSelectedVideos(new Set());
    setSelectedNode(null);
    setOriginalPreviewSources({});
    setOriginalPreviewLoading(false);
    setDownloadState({ loading: false, progress: null, result: "" });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const toggleImage = (name) => {
    setSelectedImages((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const downloadMedia = async (targetImages, targetVideos) => {
    const videosToDownload = downloadMode === "original" ? targetVideos : [];
    const imageCount = targetImages.length;
    const videoCount = videosToDownload.length;

    if (imageCount === 0 && videoCount === 0) {
      shopify.toast.show("请先选择图片或视频", { isError: true });
      return;
    }

    if (downloadMode === "cdn" && !normalizedCdn) {
      shopify.toast.show("CDN 模式需要先填写 CDN 前缀", { isError: true });
      return;
    }

    const total = imageCount + videoCount;
    setDownloadState({ loading: true, progress: [0, total], result: "" });

    try {
      const { downloadMediaAsZip } = await import("../utils/downloadImages.client");
      const result = await downloadMediaAsZip({
        images: targetImages,
        videos: videosToDownload,
        cdnPrefix: normalizedCdn,
        zipBaseName: zipName || defaultZipName,
        mode: downloadMode,
        onProgress: (done, progressTotal) => {
          setDownloadState((state) => ({ ...state, progress: [done, progressTotal] }));
        },
      });

      const message = buildDownloadResultMessage(result, imageCount, videoCount);
      setDownloadState({ loading: false, progress: null, result: message });
      shopify.toast.show(message, { isError: result.failed.length > 0 });
    } catch (error) {
      setDownloadState({ loading: false, progress: null, result: error.message });
      shopify.toast.show(error.message, { isError: true });
    }
  };

  const downloadImages = async (targetImages) => {
    if (!targetImages.length) {
      shopify.toast.show("请先选择图片", { isError: true });
      return;
    }

    if (downloadMode === "cdn" && !normalizedCdn) {
      shopify.toast.show("CDN 模式需要先填写 CDN 前缀", { isError: true });
      return;
    }

    setDownloadState({ loading: true, progress: [0, targetImages.length], result: "" });

    try {
      const { downloadImagesAsZip } = await import("../utils/downloadImages.client");
      const result = await downloadImagesAsZip({
        images: targetImages,
        cdnPrefix: normalizedCdn,
        zipBaseName: zipName || defaultZipName,
        mode: downloadMode,
        onProgress: (done, total) => {
          setDownloadState((state) => ({ ...state, progress: [done, total] }));
        },
      });

      const message =
        result.failed.length > 0
          ? `完成：成功 ${result.success} 个，失败 ${result.failed.length} 个`
          : `完成：共 ${result.success} 张图片`;
      setDownloadState({ loading: false, progress: null, result: message });
      shopify.toast.show(message, { isError: result.failed.length > 0 });
    } catch (error) {
      setDownloadState({ loading: false, progress: null, result: error.message });
      shopify.toast.show(error.message, { isError: true });
    }
  };

  const toggleVideo = (name) => {
    setSelectedVideos((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const downloadVideos = async (targetVideos) => {
    if (!targetVideos.length) {
      shopify.toast.show("请先选择视频", { isError: true });
      return;
    }

    if (downloadMode !== "original") {
      shopify.toast.show("视频下载目前仅支持原图模式", { isError: true });
      return;
    }

    setDownloadState({ loading: true, progress: [0, targetVideos.length], result: "" });

    try {
      const { downloadVideosAsZip } = await import("../utils/downloadImages.client");
      const result = await downloadVideosAsZip({
        videos: targetVideos,
        zipBaseName: zipName || defaultZipName,
        mode: downloadMode,
        onProgress: (done, total) => {
          setDownloadState((state) => ({ ...state, progress: [done, total] }));
        },
      });

      const message =
        result.failed.length > 0
          ? `完成：成功 ${result.success} 个，失败 ${result.failed.length} 个`
          : `完成：共 ${result.success} 个视频`;
      setDownloadState({ loading: false, progress: null, result: message });
      shopify.toast.show(message, { isError: result.failed.length > 0 });
    } catch (error) {
      setDownloadState({ loading: false, progress: null, result: error.message });
      shopify.toast.show(error.message, { isError: true });
    }
  };

  return (
    <s-page heading="Shopify JSON Inspector" inlineSize="large">
      <s-banner tone="info">
        从主题选择、上传或粘贴模板 JSON，分析版块、图片、视频和结构。
      </s-banner>

      <s-grid gridTemplateColumns="minmax(320px, 420px) 1fr" gap="base" alignItems="start">
        <s-stack direction="block" gap="base">
          <s-section heading="输入">
            <s-stack direction="block" gap="base">
              <s-select
                label="选择主题"
                value={selectedThemeId}
                disabled={themeTemplatesLoading || themeTemplateLoading || shopThemes.length === 0}
                onChange={onThemeChange}
                onInput={onThemeChange}
              >
                <s-option value="">
                  {themeTemplatesLoading
                    ? "正在加载主题..."
                    : shopThemes.length > 0
                      ? "选择主题"
                      : "未找到可用主题"}
                </s-option>
                {shopThemes.map((theme) => (
                  <s-option key={theme.id} value={theme.id}>
                    {formatThemeOptionLabel(theme)}
                  </s-option>
                ))}
              </s-select>
              <s-select
                label="选择模板 JSON"
                value={selectedThemeTemplate}
                disabled={
                  themeTemplatesLoading ||
                  themeTemplateLoading ||
                  !selectedThemeId ||
                  themeTemplates.length === 0
                }
                onChange={onThemeTemplateChange}
                onInput={onThemeTemplateChange}
              >
                <s-option value="">
                  {themeTemplatesLoading
                    ? "正在加载主题模板..."
                    : themeTemplates.length > 0
                      ? "选择 templates/*.json"
                      : "当前主题未找到模板 JSON"}
                </s-option>
                {themeTemplates.map((filename) => (
                  <s-option key={filename} value={filename}>
                    {formatThemeTemplateLabel(filename)}
                  </s-option>
                ))}
              </s-select>
              {themeTemplatesError && (
                <s-banner tone="warning">{themeTemplatesError}</s-banner>
              )}
              <input
                ref={fileInputRef}
                className="native-file-input"
                type="file"
                accept=".json,application/json"
                onChange={onFileChange}
              />
              <div className="inspector-file-input">
                <s-button variant="secondary" onClick={() => fileInputRef.current?.click()}>
                  选择本地文件
                </s-button>
                {sourceName && sourceName !== "粘贴.json" && (
                  <s-text color="subdued">已选：{sourceName}</s-text>
                )}
              </div>
              <s-text-area
                label="粘贴模板 JSON"
                rows={10}
                value={rawJson}
                onInput={(event) => {
                  setSelectedThemeTemplate("");
                  loadRawJson(event.currentTarget.value, "粘贴.json");
                }}
              ></s-text-area>
            </s-stack>
          </s-section>

          <s-section heading="下载设置">
            <s-stack direction="block" gap="base">
              <s-select
                label="下载模式"
                value={downloadMode}
                onChange={(event) => setDownloadMode(event.currentTarget.value)}
                onInput={(event) => setDownloadMode(event.currentTarget.value)}
              >
                <s-option value="original">原图模式（App 授权 Admin API，无需 CDN）</s-option>
                <s-option value="cdn">CDN 模式（需要 CDN 前缀）</s-option>
              </s-select>
              {downloadMode === "original" && (
                <s-text color="subdued">原图模式仅可解析并下载当前店铺内的图片与视频资源。</s-text>
              )}
              {downloadMode === "cdn" && (
                <s-url-field
                  label="CDN 前缀"
                  placeholder="https://uk.shokz.com/cdn/shop/files/"
                  value={cdnPrefix}
                  onInput={(event) => setCdnPrefix(event.currentTarget.value)}
                ></s-url-field>
              )}
              <s-text-field
                label="导出 ZIP 名称"
                placeholder={defaultZipName}
                value={zipName}
                onInput={(event) => setZipName(event.currentTarget.value)}
              ></s-text-field>
              <s-text color="subdued">
                当前模板：{formatMediaCount(images.length, videos.length)}
              </s-text>
              <div className="inspector-download-actions">
                <s-button
                  onClick={() => downloadMedia(selectedImageList, selectedVideoList)}
                  disabled={
                    (selectedCount === 0 && (downloadMode !== "original" || selectedVideoCount === 0)) ||
                    downloadState.loading
                  }
                >
                  下载选中 ({formatMediaCount(selectedCount, downloadMode === "original" ? selectedVideoCount : 0)})
                </s-button>
                <s-button
                  variant="secondary"
                  onClick={() => downloadMedia(images, videos)}
                  disabled={
                    (images.length === 0 && (downloadMode !== "original" || videos.length === 0)) ||
                    downloadState.loading
                  }
                >
                  下载全部 ZIP ({formatMediaCount(images.length, downloadMode === "original" ? videos.length : 0)})
                </s-button>
              </div>
              {downloadState.progress && (
                <s-box padding="small" borderRadius="base" background="subdued">
                  <s-text>
                    下载中：{downloadState.progress[0]} / {downloadState.progress[1]}
                  </s-text>
                </s-box>
              )}
              {downloadState.result && <s-text>{downloadState.result}</s-text>}
            </s-stack>
          </s-section>
        </s-stack>

        <s-stack direction="block" gap="base" className="inspector-results">
          {!rawJson.trim() && <EmptyState />}
          {inspection?.error && (
            <s-banner tone="critical" heading="JSON 解析失败">
              {inspection.error}
            </s-banner>
          )}
          {stats && <StatsCard stats={stats} />}
          {images && (
            <ImagesCard
              images={images}
              cdnPrefix={normalizedCdn}
              downloadMode={downloadMode}
              originalPreviewSources={originalPreviewSources}
              originalPreviewLoading={originalPreviewLoading}
              selectedImages={selectedImages}
              selectedCount={selectedCount}
              downloading={downloadState.loading}
              onToggle={toggleImage}
              onSelectAll={() => setSelectedImages(new Set(images))}
              onClearSelection={() => setSelectedImages(new Set())}
              onDownloadAll={() => downloadImages(images)}
              onDownloadSelected={() =>
                downloadImages(images.filter((name) => selectedImages.has(name)))
              }
            />
          )}
          {videos && (
            <VideosCard
              videos={videos}
              downloadMode={downloadMode}
              originalPreviewSources={originalPreviewSources}
              originalPreviewLoading={originalPreviewLoading}
              selectedVideos={selectedVideos}
              selectedCount={selectedVideoCount}
              downloading={downloadState.loading}
              shopify={shopify}
              onToggle={toggleVideo}
              onSelectAll={() => setSelectedVideos(new Set(videos))}
              onClearSelection={() => setSelectedVideos(new Set())}
              onDownloadAll={() => downloadVideos(videos)}
              onDownloadSelected={() => downloadVideos(selectedVideoList)}
            />
          )}
          {inspection?.tree && (
            <StructureCard
              tree={inspection.tree}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
            />
          )}
        </s-stack>
      </s-grid>

      <s-box slot="aside" padding="base" className="inspector-aside">
        <s-stack direction="block" gap="base">
          <s-section heading="App 信息">
            <s-paragraph>
              <s-text>模式：嵌入式 Shopify Admin App</s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>UI：Polaris web components</s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>权限：read_files、read_themes</s-text>
            </s-paragraph>
          </s-section>

          <s-section heading="使用建议">
            <s-unordered-list>
              <s-list-item>CDN 模式适合预览和轻量下载。</s-list-item>
              <s-list-item>原图模式适合迁移资源，文件 URL 由后端安全解析。</s-list-item>
              <s-list-item>可在已发布、开发中或未发布主题之间切换并选择 templates/ JSON。</s-list-item>
            </s-unordered-list>
          </s-section>
        </s-stack>
      </s-box>
    </s-page>
  );
}

function EmptyState() {
  return (
    <s-section accessibilityLabel="空状态">
      <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
        <s-stack alignItems="center" gap="small-200">
          <s-heading>未加载模板</s-heading>
          <s-paragraph>从主题下拉框选择、上传 JSON 文件或粘贴模板内容以开始检查。</s-paragraph>
        </s-stack>
      </s-grid>
    </s-section>
  );
}

function StatsCard({ stats }) {
  const complexityTone =
    stats.complexity.level === "High"
      ? "critical"
      : stats.complexity.level === "Medium"
        ? "warning"
        : "success";

  return (
    <s-section heading="模板统计">
      <div className="stats-panel">
        <div className="stats-grid">
          <Metric label="版块数" value={stats.sections.total} />
          <Metric
            label="已禁用版块"
            value={stats.sections.disabled}
            detail={toPercent(stats.sections.ratio)}
          />
          <Metric label="块数" value={stats.blocks.total} />
          <Metric
            label="已禁用块"
            value={stats.blocks.disabled}
            detail={toPercent(stats.blocks.ratio)}
          />
          <Metric
            label="图片"
            value={stats.images.unique}
            detail={`${stats.images.references} 次引用 · ${stats.images.reused} 复用`}
            className="stats-metric-wide"
          />
          <Metric
            label="复杂度"
            value={stats.complexity.score}
            badge={translateComplexity(stats.complexity.level)}
            badgeTone={complexityTone}
            isComplexity
          />
        </div>
        {stats.signals.length > 0 && (
          <div className="stats-signals">
            <div className="stats-signals-title">迁移提示</div>
            <ul className="stats-signals-list">
              {stats.signals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </s-section>
  );
}

function Metric({ label, value, detail, badge, badgeTone, isComplexity, className = "" }) {
  return (
    <div
      className={`stats-metric${isComplexity ? " is-complexity" : ""}${className ? ` ${className}` : ""}`}
    >
      <div className="stats-metric-label">{label}</div>
      <div className="stats-metric-row">
        <div className="stats-metric-value">{value}</div>
        {badge ? <s-badge tone={badgeTone}>{badge}</s-badge> : null}
      </div>
      {detail ? <div className="stats-metric-detail">{detail}</div> : null}
    </div>
  );
}

function ImagesCard({
  images,
  cdnPrefix,
  downloadMode,
  originalPreviewSources,
  originalPreviewLoading,
  selectedImages,
  selectedCount,
  downloading,
  onToggle,
  onSelectAll,
  onClearSelection,
  onDownloadAll,
  onDownloadSelected,
}) {
  const [imageSizes, setImageSizes] = useState({});
  const imageKey = images.join("\0");
  const nonWebpCount = images.filter((name) => !/\.webp$/i.test(name)).length;

  useEffect(() => {
    if (!images.length) {
      setImageSizes({});
      return;
    }

    if (downloadMode === "original") {
      if (originalPreviewLoading) return;

      const sizes = {};
      for (const name of images) {
        const fileSize = originalPreviewSources?.[name]?.fileSize;
        if (fileSize != null) sizes[name] = Number(fileSize);
      }
      setImageSizes(sizes);
      return;
    }

    if (downloadMode === "cdn" && cdnPrefix) {
      const controller = new AbortController();

      async function loadSizes() {
        try {
          const { fetchDownloadImageSize } = await import("../utils/downloadImages.client");
          const entries = await Promise.all(
            images.map(async (name) => {
              if (controller.signal.aborted) return [name, null];
              const size = await fetchDownloadImageSize(cdnPrefix, name);
              return [name, size];
            }),
          );

          if (!controller.signal.aborted) {
            setImageSizes(
              Object.fromEntries(entries.filter(([, size]) => typeof size === "number")),
            );
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.warn("图片大小解析失败:", error);
            setImageSizes({});
          }
        }
      }

      loadSizes();
      return () => controller.abort();
    }

    setImageSizes({});
  }, [downloadMode, cdnPrefix, imageKey, originalPreviewSources, originalPreviewLoading]);

  const largeImageCount = images.filter((name) => isLargeFile(imageSizes[name])).length;

  return (
    <s-section heading={`图片 (${images.length})`}>
      {images.length === 0 ? (
        <s-paragraph>该模板中未检测到图片引用。</s-paragraph>
      ) : (
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-button variant="secondary" onClick={onSelectAll}>
              全选
            </s-button>
            <s-button variant="secondary" onClick={onClearSelection}>
              取消选择
            </s-button>
            <s-text color="subdued">{selectedCount > 0 ? `已选 ${selectedCount} 张` : "未选择"}</s-text>
          </s-stack>
          <div className="image-grid">
            {images.map((name) => {
              const selected = selectedImages.has(name);
              const originalSrc = originalPreviewSources?.[name]?.url || "";
              const cdnSrc = cdnPrefix ? `${cdnPrefix}${encodePath(name)}` : "";
              const src = downloadMode === "original" ? originalSrc || cdnSrc : cdnSrc;
              const fileSize = imageSizes[name];
              const isLarge = isLargeFile(fileSize);
              const isNonWebp = !/\.webp$/i.test(name);
              const emptyPreviewText =
                downloadMode === "original"
                  ? originalPreviewLoading
                    ? "解析原图中"
                    : "未匹配原图"
                  : "需配置 CDN";
              return (
                <button
                  type="button"
                  key={name}
                  className={`image-card ${selected ? "is-selected" : ""} ${isLarge ? "is-large" : ""}`}
                  onClick={() => onToggle(name)}
                >
                  <span className="image-preview">
                    {src ? <img src={src} alt={name} loading="lazy" /> : <span>{emptyPreviewText}</span>}
                  </span>
                  <span className="image-name">{name}</span>
                  {(isNonWebp || isLarge) && (
                    <span className="image-badges">
                      {isNonWebp && <span className="format-badge">非 WebP</span>}
                      {isLarge && <span className="size-badge">{formatFileSize(fileSize)}</span>}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {nonWebpCount > 0 && (
            <s-banner tone="warning">
              检测到 {nonWebpCount} 张图片不是 WebP 格式，建议迁移时统一压缩或转换。
            </s-banner>
          )}
          {largeImageCount > 0 && (
            <s-banner tone="warning">
              检测到 {largeImageCount} 张图片超过 300KB，建议压缩后再迁移。
            </s-banner>
          )}
          <div className="inspector-download-actions">
            <s-button onClick={onDownloadSelected} disabled={selectedCount === 0 || downloading}>
              下载选中 ({selectedCount})
            </s-button>
            <s-button variant="secondary" onClick={onDownloadAll} disabled={downloading}>
              下载全部 ZIP
            </s-button>
          </div>
        </s-stack>
      )}
    </s-section>
  );
}

function VideosCard({
  videos,
  downloadMode,
  originalPreviewSources,
  originalPreviewLoading,
  selectedVideos,
  selectedCount,
  downloading,
  shopify,
  onToggle,
  onSelectAll,
  onClearSelection,
  onDownloadAll,
  onDownloadSelected,
}) {
  const copyName = async (rawName) => {
    const name = videoDisplayName(rawName);
    await navigator.clipboard.writeText(name);
    shopify.toast.show("已复制视频文件名");
  };

  const isOriginalMode = downloadMode === "original";

  return (
    <s-section heading={`视频 (${videos.length})`}>
      {videos.length === 0 ? (
        <s-paragraph>该模板中未检测到视频引用。</s-paragraph>
      ) : (
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {isOriginalMode
              ? "原图模式会通过 App 授权解析当前店铺内的视频原文件，可预览并批量下载。"
              : "JSON 通常无法提供 Shopify 视频哈希 CDN 链接；点击下方文件名可复制，并在后台「内容 → 文件」搜索。"}
          </s-paragraph>
          {isOriginalMode && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-button variant="secondary" onClick={onSelectAll}>
                全选
              </s-button>
              <s-button variant="secondary" onClick={onClearSelection}>
                取消选择
              </s-button>
              <s-text color="subdued">{selectedCount > 0 ? `已选 ${selectedCount} 个` : "未选择"}</s-text>
            </s-stack>
          )}
          <div className="video-grid">
            {videos.map((name) => {
              const selected = selectedVideos.has(name);
              const source = originalPreviewSources?.[name];
              const previewUrl = source?.previewUrl || "";
              const videoUrl = source?.url || "";
              const emptyPreviewText = isOriginalMode
                ? originalPreviewLoading
                  ? "解析视频中"
                  : "未匹配视频"
                : "Video";

              return (
                <button
                  type="button"
                  key={name}
                  className={`video-card ${selected ? "is-selected" : ""}`}
                  onClick={() => {
                    if (isOriginalMode) onToggle(name);
                    else copyName(name);
                  }}
                >
                  <span className="video-preview">
                    {isOriginalMode && videoUrl ? (
                      <video
                        src={videoUrl}
                        poster={previewUrl || undefined}
                        preload="metadata"
                        muted
                        playsInline
                      />
                    ) : previewUrl ? (
                      <img src={previewUrl} alt={name} loading="lazy" />
                    ) : (
                      <span className="video-icon">{emptyPreviewText}</span>
                    )}
                  </span>
                  <span className="video-name">{videoDisplayName(name)}</span>
                  {isOriginalMode && source?.fileSize ? (
                    <span className="video-meta">{formatFileSize(source.fileSize)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {isOriginalMode && (
            <div className="inspector-download-actions">
              <s-button onClick={onDownloadSelected} disabled={selectedCount === 0 || downloading}>
                下载选中 ({selectedCount})
              </s-button>
              <s-button variant="secondary" onClick={onDownloadAll} disabled={downloading}>
                下载全部 ZIP ({videos.length})
              </s-button>
            </div>
          )}
        </s-stack>
      )}
    </s-section>
  );
}

function StructureCard({ tree, selectedNode, onSelectNode }) {
  return (
    <s-section heading="结构">
      <div className="tree-panel">
        <TreeNode node={tree} onSelectNode={onSelectNode} />
      </div>
      {selectedNode && (
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="small-200">
            <s-heading>{selectedNode.label}</s-heading>
            <pre className="json-preview">
              <code>{JSON.stringify(selectedNode.data, null, 2)}</code>
            </pre>
          </s-stack>
        </s-box>
      )}
    </s-section>
  );
}

function TreeNode({ node, onSelectNode }) {
  const hasChildren = node.children?.length > 0;

  return (
    <details className="tree-node" open={node.nodeType !== "block"}>
      <summary>
        <button
          type="button"
          className={`tree-label ${node.disabled ? "is-disabled" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (node.data) onSelectNode(node);
          }}
        >
          {node.label}
          {node.meta ? <span> ({node.meta})</span> : null}
        </button>
      </summary>
      {hasChildren && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNode
              key={`${child.nodeType}-${child.label}`}
              node={child}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      )}
    </details>
  );
}

function toPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function translateComplexity(level) {
  if (level === "High") return "高";
  if (level === "Medium") return "中";
  return "低";
}

const LARGE_FILE_BYTES = 300 * 1024;

function isLargeFile(bytes) {
  return typeof bytes === "number" && bytes > LARGE_FILE_BYTES;
}

function formatFileSize(bytes) {
  if (typeof bytes !== "number" || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${Math.round(bytes / 1024)}KB`;
}

function formatMediaCount(imageCount, videoCount) {
  const parts = [];
  if (imageCount > 0) parts.push(`${imageCount} 图`);
  if (videoCount > 0) parts.push(`${videoCount} 视频`);
  return parts.length > 0 ? parts.join(" / ") : "0";
}

function buildDownloadResultMessage(result, imageCount, videoCount) {
  const requested = [];
  if (imageCount > 0) requested.push(`${imageCount} 图`);
  if (videoCount > 0) requested.push(`${videoCount} 视频`);

  if (result.failed.length > 0) {
    return `完成：成功 ${result.success} 个，失败 ${result.failed.length} 个（${requested.join(" / ")}）`;
  }

  return `完成：共 ${result.success} 个文件（${requested.join(" / ")}）`;
}

function formatThemeOptionLabel(theme) {
  return `${theme.name}（${translateThemeRole(theme.role)}）`;
}

function translateThemeRole(role) {
  if (role === "MAIN") return "已发布";
  if (role === "DEVELOPMENT") return "开发中";
  if (role === "UNPUBLISHED") return "未发布";
  if (role === "DEMO") return "试用";
  if (role === "ARCHIVED") return "已归档";
  if (role === "LOCKED") return "已锁定";
  return role || "未知";
}

function formatThemeTemplateLabel(filename) {
  const value = String(filename || "");
  return value.startsWith("templates/") ? value.slice("templates/".length) : value;
}

function encodePath(filename) {
  return filename.split("/").map(encodeURIComponent).join("/");
}

function videoDisplayName(raw) {
  const name = String(raw || "").replace(/^videos\/+/, "").trim();
  return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
