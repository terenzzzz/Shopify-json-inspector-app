import { useEffect, useMemo, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  extractCdnDomain,
  inspectTemplate,
  normalizeCdn,
  parseTemplateJson,
  stripExt,
} from "../utils/inspector";
import styles from "../styles/inspector.css?url";

const CDN_DOMAIN_HISTORY_KEY = "shopify-json-inspector:cdn-domains";
const MAX_CDN_DOMAIN_HISTORY = 8;

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
  const [cdnDomain, setCdnDomain] = useState("");
  const [cdnDomainHistory, setCdnDomainHistory] = useState([]);
  const [zipName, setZipName] = useState("");
  const [downloadMode, setDownloadMode] = useState("original");
  const [selectedImages, setSelectedImages] = useState(new Set());
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [selectedNode, setSelectedNode] = useState(null);
  const [downloadState, setDownloadState] = useState(createEmptyDownloadState());
  const [permanentFailedImages, setPermanentFailedImages] = useState(new Set());
  const [excludedImages, setExcludedImages] = useState(new Set());
  const [originalPreviewSources, setOriginalPreviewSources] = useState({});
  const [originalPreviewLoading, setOriginalPreviewLoading] = useState(false);
  const [shopThemes, setShopThemes] = useState([]);
  const [selectedThemeId, setSelectedThemeId] = useState("");
  const [themeTemplates, setThemeTemplates] = useState([]);
  const [themeTemplatesLoading, setThemeTemplatesLoading] = useState(true);
  const [themeTemplatesError, setThemeTemplatesError] = useState("");
  const [selectedThemeTemplate, setSelectedThemeTemplate] = useState("");
  const [themeTemplateLoading, setThemeTemplateLoading] = useState(false);
  const [themeQuery, setThemeQuery] = useState("");
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [themeHighlightIndex, setThemeHighlightIndex] = useState(0);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [templateHighlightIndex, setTemplateHighlightIndex] = useState(0);
  const themeComboboxRef = useRef(null);
  const selectThemeRef = useRef(null);
  const suppressThemeQuerySyncRef = useRef(false);
  const templateComboboxRef = useRef(null);
  const selectThemeTemplateRef = useRef(null);
  const suppressTemplateQuerySyncRef = useRef(false);

  const matchedThemes = useMemo(
    () =>
      filterByQuery(shopThemes, themeQuery, (theme) => [
        theme.name,
        formatThemeOptionLabel(theme),
        theme.role,
        translateThemeRole(theme.role),
      ]),
    [shopThemes, themeQuery],
  );

  const matchedThemeTemplates = useMemo(
    () =>
      filterByQuery(themeTemplates, templateQuery, (filename) => [
        filename,
        formatThemeTemplateLabel(filename),
      ]),
    [themeTemplates, templateQuery],
  );

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
  const normalizedCdn = normalizeCdn(cdnDomain);
  const visibleImages = useMemo(
    () => images.filter((name) => !excludedImages.has(name)),
    [images, excludedImages],
  );
  const selectedCount = selectedImages.size;
  const selectedVideoCount = selectedVideos.size;
  const defaultZipName = stripExt(sourceName || "shopify-images");
  const selectedVideoList = videos.filter((name) => selectedVideos.has(name));
  const imageKey = images.join("\0");
  const videoKey = videos.join("\0");
  const mediaKey = `${imageKey}\n${videoKey}`;
  const permanentFailedCount = useMemo(
    () => visibleImages.filter((name) => permanentFailedImages.has(name)).length,
    [visibleImages, permanentFailedImages],
  );

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
      const nextTheme = payload.theme || null;
      setSelectedThemeId(nextTheme?.id || "");
      setThemeQuery(nextTheme ? formatThemeOptionLabel(nextTheme) : "");
      setThemeMenuOpen(false);
      setThemeTemplates(Array.isArray(payload.templates) ? payload.templates : []);
      setSelectedThemeTemplate("");
      setTemplateQuery("");
      setTemplateMenuOpen(false);
      if (payload.error) {
        setThemeTemplatesError(payload.error);
      }
    } catch (error) {
      if (signal?.aborted) return;
      console.warn("主题模板列表加载失败:", error);
      setShopThemes([]);
      setSelectedThemeId("");
      setThemeQuery("");
      setThemeMenuOpen(false);
      setThemeTemplates([]);
      setSelectedThemeTemplate("");
      setTemplateQuery("");
      setTemplateMenuOpen(false);
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
    setCdnDomainHistory(loadCdnDomainHistory());
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

  useEffect(() => {
    setExcludedImages(new Set());
    setPermanentFailedImages(new Set());
  }, [imageKey]);

  useEffect(() => {
    setPermanentFailedImages(new Set());
  }, [downloadMode, normalizedCdn]);

  useEffect(() => {
    setThemeHighlightIndex(0);
  }, [themeQuery, shopThemes]);

  useEffect(() => {
    setTemplateHighlightIndex(0);
  }, [templateQuery, themeTemplates]);

  useEffect(() => {
    if (!themeMenuOpen) return undefined;

    const onPointerDown = (event) => {
      if (!themeComboboxRef.current?.contains(event.target)) {
        setThemeMenuOpen(false);
        const selected = shopThemes.find((theme) => theme.id === selectedThemeId);
        setThemeQuery(selected ? formatThemeOptionLabel(selected) : "");
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [themeMenuOpen, selectedThemeId, shopThemes]);

  useEffect(() => {
    const root = themeComboboxRef.current;
    if (!root) return undefined;

    const onKeyDown = (event) => {
      if (themeTemplatesLoading || themeTemplateLoading || shopThemes.length === 0) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setThemeMenuOpen(true);
        setThemeHighlightIndex((index) =>
          matchedThemes.length ? (index + 1) % matchedThemes.length : 0,
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setThemeMenuOpen(true);
        setThemeHighlightIndex((index) =>
          matchedThemes.length
            ? (index - 1 + matchedThemes.length) % matchedThemes.length
            : 0,
        );
        return;
      }

      if (event.key === "Enter" && themeMenuOpen) {
        const theme = matchedThemes[themeHighlightIndex];
        if (!theme) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        selectThemeRef.current?.(theme.id);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setThemeMenuOpen(false);
        const selected = shopThemes.find((item) => item.id === selectedThemeId);
        setThemeQuery(selected ? formatThemeOptionLabel(selected) : "");
      }
    };

    root.addEventListener("keydown", onKeyDown, true);
    return () => root.removeEventListener("keydown", onKeyDown, true);
  }, [
    matchedThemes,
    selectedThemeId,
    shopThemes,
    themeHighlightIndex,
    themeMenuOpen,
    themeTemplateLoading,
    themeTemplatesLoading,
  ]);

  useEffect(() => {
    if (!templateMenuOpen) return undefined;

    const onPointerDown = (event) => {
      if (!templateComboboxRef.current?.contains(event.target)) {
        setTemplateMenuOpen(false);
        setTemplateQuery(
          selectedThemeTemplate ? formatThemeTemplateLabel(selectedThemeTemplate) : "",
        );
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [templateMenuOpen, selectedThemeTemplate]);

  useEffect(() => {
    const root = templateComboboxRef.current;
    if (!root) return undefined;

    const onKeyDown = (event) => {
      if (
        themeTemplatesLoading ||
        themeTemplateLoading ||
        !selectedThemeId ||
        themeTemplates.length === 0
      ) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setTemplateMenuOpen(true);
        setTemplateHighlightIndex((index) =>
          matchedThemeTemplates.length
            ? (index + 1) % matchedThemeTemplates.length
            : 0,
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setTemplateMenuOpen(true);
        setTemplateHighlightIndex((index) =>
          matchedThemeTemplates.length
            ? (index - 1 + matchedThemeTemplates.length) % matchedThemeTemplates.length
            : 0,
        );
        return;
      }

      if (event.key === "Enter" && templateMenuOpen) {
        const filename = matchedThemeTemplates[templateHighlightIndex];
        if (!filename) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        selectThemeTemplateRef.current?.(filename);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setTemplateMenuOpen(false);
        setTemplateQuery(
          selectedThemeTemplate ? formatThemeTemplateLabel(selectedThemeTemplate) : "",
        );
      }
    };

    root.addEventListener("keydown", onKeyDown, true);
    return () => root.removeEventListener("keydown", onKeyDown, true);
  }, [
    matchedThemeTemplates,
    selectedThemeId,
    selectedThemeTemplate,
    templateHighlightIndex,
    templateMenuOpen,
    themeTemplateLoading,
    themeTemplates.length,
    themeTemplatesLoading,
  ]);

  const loadRawJson = (raw, filename) => {
    setRawJson(raw);
    setSourceName(filename);
    setSelectedImages(new Set());
    setSelectedVideos(new Set());
    setSelectedNode(null);
    setOriginalPreviewSources({});
    setExcludedImages(new Set());
    setPermanentFailedImages(new Set());
    setDownloadState(createEmptyDownloadState());
  };

  const syncComboboxFieldValue = (root, label, suppressRef) => {
    requestAnimationFrame(() => {
      const field = root?.querySelector("s-search-field");
      if (field) {
        field.value = label;
        if (typeof field.blur === "function") field.blur();
      }
      requestAnimationFrame(() => {
        suppressRef.current = false;
      });
    });
  };

  const selectTheme = async (themeId) => {
    if (!themeId) return;

    const theme = shopThemes.find((item) => item.id === themeId);
    const label = theme ? formatThemeOptionLabel(theme) : "";
    suppressThemeQuerySyncRef.current = true;
    setThemeQuery(label);
    setThemeMenuOpen(false);
    syncComboboxFieldValue(themeComboboxRef.current, label, suppressThemeQuerySyncRef);

    if (themeId === selectedThemeId) return;

    setSelectedThemeId(themeId);
    setSelectedThemeTemplate("");
    setTemplateQuery("");
    setTemplateMenuOpen(false);

    const controller = new AbortController();
    await loadThemeData(themeId, controller.signal);
  };
  selectThemeRef.current = selectTheme;

  const onThemeQueryInput = (value) => {
    if (suppressThemeQuerySyncRef.current) return;
    setThemeQuery(value);
    setThemeMenuOpen(true);
  };

  const selectThemeTemplate = async (filename) => {
    if (!filename) return;

    const label = formatThemeTemplateLabel(filename);
    suppressTemplateQuerySyncRef.current = true;
    setSelectedThemeTemplate(filename);
    setTemplateQuery(label);
    setTemplateMenuOpen(false);
    syncComboboxFieldValue(
      templateComboboxRef.current,
      label,
      suppressTemplateQuerySyncRef,
    );

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
      setTemplateQuery(formatThemeTemplateLabel(payload.filename || filename));
      shopify.toast.show(`已加载 ${payload.filename || filename}`);
    } catch (error) {
      console.warn("主题模板读取失败:", error);
      shopify.toast.show(error.message || "主题模板读取失败", { isError: true });
    } finally {
      setThemeTemplateLoading(false);
    }
  };
  selectThemeTemplateRef.current = selectThemeTemplate;

  const onTemplateQueryInput = (value) => {
    if (suppressTemplateQuerySyncRef.current) return;
    setTemplateQuery(value);
    setTemplateMenuOpen(true);
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
    setTemplateQuery("");
    setTemplateMenuOpen(false);
  };

  const rememberCdnDomain = (value = cdnDomain) => {
    const domain = extractCdnDomain(value);
    if (!domain) return "";
    setCdnDomain(domain);
    setCdnDomainHistory(saveCdnDomainHistory(domain));
    return domain;
  };

  const clearAll = () => {
    setRawJson("");
    setSourceName("");
    setSelectedThemeTemplate("");
    setThemeQuery("");
    setThemeMenuOpen(false);
    setTemplateQuery("");
    setTemplateMenuOpen(false);
    setCdnDomain("");
    setZipName("");
    setDownloadMode("original");
    setSelectedImages(new Set());
    setSelectedVideos(new Set());
    setSelectedNode(null);
    setOriginalPreviewSources({});
    setOriginalPreviewLoading(false);
    setExcludedImages(new Set());
    setPermanentFailedImages(new Set());
    setDownloadState(createEmptyDownloadState());
    if (fileInputRef.current) fileInputRef.current.value = "";
    import("../utils/downloadImages.client").then(({ clearDownloadSession }) => {
      clearDownloadSession();
    });
    shopify.toast.show("已重置输入和下载设置");
  };

  const applyDownloadResult = (result, fallbackMessage) => {
    const failedCount = result.failedNames?.length || result.failed?.length || 0;
    const total = (result.success || 0) + failedCount;
    const hasPermanent =
      (result.unresolved?.length || 0) > 0 || permanentFailedCount > 0;
    const message =
      fallbackMessage ||
      buildDownloadResultMessage(result, {
        suggestPurge: hasPermanent,
      });

    if (result.unresolved?.length) {
      setPermanentFailedImages((current) => {
        const next = new Set(current);
        for (const name of result.unresolved) next.add(name);
        return next;
      });
    }

    setDownloadState({
      loading: false,
      progress: {
        done: total,
        total,
        failed: failedCount,
      },
      result: message,
      canResume: Boolean(result.canResume),
      failedNames: result.failedNames || result.failed || [],
      unresolved: result.unresolved || [],
      failureReasons: result.failureReasons || {},
      partial: Boolean(result.partial),
    });
    shopify.toast.show(message, { isError: failedCount > 0 });
  };

  const markPermanentFailedImage = (name) => {
    setPermanentFailedImages((current) => {
      if (current.has(name)) return current;
      const next = new Set(current);
      next.add(name);
      return next;
    });
  };

  const purgePermanentFailedImages = () => {
    if (!permanentFailedImages.size) return;

    const removeSet = new Set(permanentFailedImages);
    setExcludedImages((current) => new Set([...current, ...removeSet]));
    setSelectedImages((current) => {
      const next = new Set(current);
      for (const name of removeSet) next.delete(name);
      return next;
    });
    setPermanentFailedImages(new Set());
    import("../utils/downloadImages.client").then(({ clearDownloadSession }) => {
      clearDownloadSession();
    });
    shopify.toast.show(`已剔除 ${removeSet.size} 张永久失效图片`);
  };

  const toggleImage = (name) => {
    setSelectedImages((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const applyDownloadProgress = (done, total, meta = {}) => {
    setDownloadState((state) => ({
      ...state,
      loading: true,
      progress: {
        done,
        total,
        current: meta.current,
        phase: meta.phase,
        failed: meta.failed,
      },
      failedNames: Array.isArray(meta.failedNames) ? meta.failedNames : state.failedNames,
      unresolved: Array.isArray(meta.unresolvedNames)
        ? meta.unresolvedNames
        : state.unresolved,
      failureReasons:
        meta.failureReasons && typeof meta.failureReasons === "object"
          ? meta.failureReasons
          : state.failureReasons,
    }));
  };

  const downloadImages = async (targetImages) => {
    if (!targetImages.length) {
      shopify.toast.show("请先选择图片", { isError: true });
      return;
    }

    let cdnPrefixForDownload = "";
    if (downloadMode === "cdn") {
      const domain = rememberCdnDomain();
      if (!domain) {
        shopify.toast.show("CDN 模式需要先填写店铺域名", { isError: true });
        return;
      }
      cdnPrefixForDownload = normalizeCdn(domain);
    }

    setDownloadState({
      ...createEmptyDownloadState(),
      loading: true,
      progress: { done: 0, total: targetImages.length, phase: downloadMode === "original" ? "resolve" : "download" },
    });

    try {
      const { downloadImagesAsZip } = await import("../utils/downloadImages.client");
      const result = await downloadImagesAsZip({
        images: targetImages,
        cdnPrefix: cdnPrefixForDownload,
        zipBaseName: zipName || defaultZipName,
        mode: downloadMode,
        originalSources: downloadMode === "original" ? originalPreviewSources : undefined,
        onProgress: applyDownloadProgress,
      });

      applyDownloadResult(result);
    } catch (error) {
      setDownloadState({
        ...createEmptyDownloadState(),
        result: error.message,
      });
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

    setDownloadState({
      ...createEmptyDownloadState(),
      loading: true,
      progress: { done: 0, total: targetVideos.length, phase: "resolve" },
    });

    try {
      const { downloadVideosAsZip } = await import("../utils/downloadImages.client");
      const result = await downloadVideosAsZip({
        videos: targetVideos,
        zipBaseName: zipName || defaultZipName,
        mode: downloadMode,
        originalSources: originalPreviewSources,
        onProgress: applyDownloadProgress,
      });

      applyDownloadResult(result);
    } catch (error) {
      setDownloadState({
        ...createEmptyDownloadState(),
        result: error.message,
      });
      shopify.toast.show(error.message, { isError: true });
    }
  };

  const resumeFailedDownload = async () => {
    setDownloadState((state) => ({
      ...state,
      loading: true,
      result: "",
      progress: state.progress || { done: 0, total: state.failedNames.length || 0, phase: "download" },
    }));

    try {
      const { resumeDownload } = await import("../utils/downloadImages.client");
      const result = await resumeDownload({
        onProgress: applyDownloadProgress,
      });

      if (!result) {
        setDownloadState((state) => ({
          ...state,
          loading: false,
          canResume: false,
          result: "没有可重试的失败项",
        }));
        return;
      }

      applyDownloadResult(result);
    } catch (error) {
      setDownloadState((state) => ({
        ...state,
        loading: false,
        result: error.message,
      }));
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
          <s-section accessibilityLabel="输入">
            <s-stack direction="block" gap="base">
              <div className="inspector-input-header">
                <s-heading>输入</s-heading>
                <s-button
                  variant="secondary"
                  onClick={clearAll}
                  disabled={downloadState.loading}
                >
                  重置
                </s-button>
              </div>
              <div
                className={`inspector-combobox ${themeMenuOpen ? "is-open" : ""}`}
                ref={themeComboboxRef}
              >
                <s-search-field
                  label="选择主题"
                  placeholder={
                    themeTemplatesLoading
                      ? "正在加载主题..."
                      : shopThemes.length === 0
                        ? "未找到可用主题"
                        : "输入关键字搜索主题…"
                  }
                  value={themeQuery}
                  autocomplete="off"
                  disabled={
                    themeTemplatesLoading ||
                    themeTemplateLoading ||
                    shopThemes.length === 0
                  }
                  details={
                    themeQuery.trim()
                      ? `匹配 ${matchedThemes.length}/${shopThemes.length} 个主题`
                      : shopThemes.length > 0
                        ? `共 ${shopThemes.length} 个主题`
                        : undefined
                  }
                  onFocus={() => {
                    if (shopThemes.length > 0) setThemeMenuOpen(true);
                  }}
                  onInput={(event) => onThemeQueryInput(event.currentTarget.value)}
                  onChange={(event) => onThemeQueryInput(event.currentTarget.value)}
                ></s-search-field>
                {themeMenuOpen && shopThemes.length > 0 && (
                  <div className="inspector-combobox-menu" role="listbox">
                    {matchedThemes.length === 0 ? (
                      <div className="inspector-combobox-empty">无匹配主题</div>
                    ) : (
                      matchedThemes.map((theme, index) => {
                        const selected = theme.id === selectedThemeId;
                        const active = index === themeHighlightIndex;
                        return (
                          <button
                            key={theme.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`inspector-combobox-option ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
                            onMouseEnter={() => setThemeHighlightIndex(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => selectTheme(theme.id)}
                          >
                            {formatThemeOptionLabel(theme)}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
              <div
                className={`inspector-combobox ${templateMenuOpen ? "is-open" : ""}`}
                ref={templateComboboxRef}
              >
                <s-search-field
                  label="选择模板 JSON"
                  placeholder={
                    themeTemplatesLoading
                      ? "正在加载主题模板..."
                      : themeTemplates.length === 0
                        ? "当前主题未找到模板 JSON"
                        : "输入关键字搜索，如 product、index…"
                  }
                  value={templateQuery}
                  autocomplete="off"
                  disabled={
                    themeTemplatesLoading ||
                    themeTemplateLoading ||
                    !selectedThemeId ||
                    themeTemplates.length === 0
                  }
                  details={
                    templateQuery.trim()
                      ? `匹配 ${matchedThemeTemplates.length}/${themeTemplates.length} 个模板`
                      : themeTemplates.length > 0
                        ? `共 ${themeTemplates.length} 个 templates/*.json`
                        : undefined
                  }
                  onFocus={() => {
                    if (themeTemplates.length > 0) setTemplateMenuOpen(true);
                  }}
                  onInput={(event) => onTemplateQueryInput(event.currentTarget.value)}
                  onChange={(event) => onTemplateQueryInput(event.currentTarget.value)}
                ></s-search-field>
                {templateMenuOpen && themeTemplates.length > 0 && (
                  <div className="inspector-combobox-menu" role="listbox">
                    {matchedThemeTemplates.length === 0 ? (
                      <div className="inspector-combobox-empty">无匹配模板</div>
                    ) : (
                      matchedThemeTemplates.map((filename, index) => {
                        const selected = filename === selectedThemeTemplate;
                        const active = index === templateHighlightIndex;
                        return (
                          <button
                            key={filename}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`inspector-combobox-option ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
                            onMouseEnter={() => setTemplateHighlightIndex(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => selectThemeTemplate(filename)}
                          >
                            {formatThemeTemplateLabel(filename)}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
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
                  setTemplateQuery("");
                  setTemplateMenuOpen(false);
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
                <s-option value="cdn">CDN 模式（填写店铺域名即可）</s-option>
              </s-select>
              {downloadMode === "original" && (
                <s-text color="subdued">原图模式仅可解析并下载当前店铺内的图片与视频资源。</s-text>
              )}
              {downloadMode === "cdn" && (
                <s-stack direction="block" gap="small-200">
                  <s-text-field
                    label="店铺域名"
                    placeholder="uk.shokz.com"
                    value={cdnDomain}
                    onInput={(event) => setCdnDomain(event.currentTarget.value)}
                    onBlur={() => rememberCdnDomain()}
                  ></s-text-field>
                  {normalizedCdn ? (
                    <s-text color="subdued">自动 CDN 前缀：{normalizedCdn}</s-text>
                  ) : (
                    <s-text color="subdued">
                      输入店铺域名后自动转换为 https://域名/cdn/shop/files/
                    </s-text>
                  )}
                  {cdnDomainHistory.length > 0 && (
                    <div className="cdn-domain-history">
                      <div className="cdn-domain-history-label">历史域名</div>
                      <div className="cdn-domain-history-list">
                        {cdnDomainHistory.map((domain) => (
                          <button
                            type="button"
                            key={domain}
                            className={`cdn-domain-chip${cdnDomain === domain ? " is-active" : ""}`}
                            onClick={() => rememberCdnDomain(domain)}
                          >
                            {domain}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </s-stack>
              )}
              <s-text-field
                label="导出 ZIP 名称"
                placeholder={defaultZipName}
                value={zipName}
                onInput={(event) => setZipName(event.currentTarget.value)}
              ></s-text-field>
              <s-text color="subdued">
                当前模板：{formatMediaCount(images.length, videos.length)}。请在右侧图片/视频区下载。
              </s-text>
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
              images={visibleImages}
              cdnPrefix={normalizedCdn}
              downloadMode={downloadMode}
              originalPreviewSources={originalPreviewSources}
              originalPreviewLoading={originalPreviewLoading}
              selectedImages={selectedImages}
              selectedCount={selectedCount}
              permanentFailedImages={permanentFailedImages}
              permanentFailedCount={permanentFailedCount}
              downloading={downloadState.loading}
              downloadState={downloadState}
              onToggle={toggleImage}
              onSelectAll={() => setSelectedImages(new Set(visibleImages))}
              onClearSelection={() => setSelectedImages(new Set())}
              onMarkFailed={markPermanentFailedImage}
              onPurgeFailed={purgePermanentFailedImages}
              onDownloadAll={() => downloadImages(visibleImages)}
              onDownloadSelected={() =>
                downloadImages(visibleImages.filter((name) => selectedImages.has(name)))
              }
              onResume={resumeFailedDownload}
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
              downloadState={downloadState}
              shopify={shopify}
              onToggle={toggleVideo}
              onSelectAll={() => setSelectedVideos(new Set(videos))}
              onClearSelection={() => setSelectedVideos(new Set())}
              onDownloadAll={() => downloadVideos(videos)}
              onDownloadSelected={() => downloadVideos(selectedVideoList)}
              onResume={resumeFailedDownload}
            />
          )}
          <DownloadProgressPanel downloadState={downloadState} />
          {inspection?.tree && (
            <StructureCard
              tree={inspection.tree}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
            />
          )}
        </s-stack>
      </s-grid>
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
  permanentFailedImages,
  permanentFailedCount,
  downloading,
  downloadState,
  onToggle,
  onSelectAll,
  onClearSelection,
  onMarkFailed,
  onPurgeFailed,
  onDownloadAll,
  onDownloadSelected,
  onResume,
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

      const loadSizes = async () => {
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
      };

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
              const failed = permanentFailedImages.has(name);
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
                  : "需填写域名";
              return (
                <button
                  type="button"
                  key={name}
                  title={failed ? "永久失效（404/未找到）" : undefined}
                  className={`image-card ${selected ? "is-selected" : ""} ${isLarge ? "is-large" : ""} ${failed ? "is-missing" : ""}`}
                  onClick={() => onToggle(name)}
                >
                  <span className="image-preview">
                    {src ? (
                      <img
                        src={src}
                        alt={name}
                        loading="lazy"
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                          onMarkFailed(name);
                        }}
                      />
                    ) : (
                      <span>{emptyPreviewText}</span>
                    )}
                    {failed ? <span className="image-missing-badge">失效</span> : null}
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
            {downloadState?.canResume && (
              <s-button variant="secondary" onClick={onResume} disabled={downloading}>
                恢复下载
              </s-button>
            )}
            {permanentFailedCount > 0 && (
              <s-button variant="secondary" onClick={onPurgeFailed} disabled={downloading}>
                剔除永久失效 ({permanentFailedCount})
              </s-button>
            )}
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
  downloadState,
  shopify,
  onToggle,
  onSelectAll,
  onClearSelection,
  onDownloadAll,
  onDownloadSelected,
  onResume,
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
              {downloadState?.canResume && (
                <s-button variant="secondary" onClick={onResume} disabled={downloading}>
                  恢复下载
                </s-button>
              )}
            </div>
          )}
        </s-stack>
      )}
    </s-section>
  );
}

function DownloadProgressPanel({ downloadState }) {
  if (!downloadState) return null;

  const visible =
    downloadState.loading ||
    Boolean(downloadState.result) ||
    (downloadState.failedNames?.length || 0) > 0;

  if (!visible) return null;

  const progress = downloadState.progress;
  const percent =
    progress?.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const phaseLabel =
    progress?.phase === "resolve"
      ? "解析原图"
      : progress?.phase === "download"
        ? "下载文件"
        : null;
  const progressLabel = progress
    ? [
        phaseLabel,
        `进度：${progress.done} / ${progress.total}`,
        progress.current || null,
        progress.failed > 0 ? `失败 ${progress.failed}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "进度：0 / 0";

  return (
    <s-section heading="下载进度">
      <div className="progress-wrapper">
        <div className="progress-info">
          <span className="progress-text">{progressLabel}</span>
          {downloadState.result ? (
            <span
              className={
                downloadState.failedNames.length > 0 ? "error-text" : "success-text"
              }
            >
              {downloadState.result}
            </span>
          ) : null}
        </div>
        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
        {downloadState.failedNames.length > 0 ? (
          <ul className="download-failed-list">
            {downloadState.failedNames.map((name) => {
              const permanent = downloadState.unresolved.includes(name);
              const reason =
                downloadState.failureReasons[name] ||
                (permanent ? "未找到" : "下载失败");
              return (
                <li key={name}>
                  <code>{name}</code>
                  <span className="fail-tag">{permanent ? "永久" : "可重试"}</span>
                  <span className="fail-reason">{reason}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
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

function createEmptyDownloadState() {
  return {
    loading: false,
    progress: null,
    result: "",
    canResume: false,
    failedNames: [],
    unresolved: [],
    failureReasons: {},
    partial: false,
  };
}

function loadCdnDomainHistory() {
  if (typeof localStorage === "undefined") return [];

  try {
    const raw = localStorage.getItem(CDN_DOMAIN_HISTORY_KEY);
    const list = JSON.parse(raw || "[]");
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => extractCdnDomain(item))
      .filter(Boolean)
      .filter((domain, index, all) => all.indexOf(domain) === index)
      .slice(0, MAX_CDN_DOMAIN_HISTORY);
  } catch {
    return [];
  }
}

function saveCdnDomainHistory(domain) {
  const host = extractCdnDomain(domain);
  if (!host) return loadCdnDomainHistory();

  const next = [host, ...loadCdnDomainHistory().filter((item) => item !== host)].slice(
    0,
    MAX_CDN_DOMAIN_HISTORY,
  );

  try {
    localStorage.setItem(CDN_DOMAIN_HISTORY_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode failures
  }

  return next;
}

function buildDownloadResultMessage(result, options = {}) {
  const { imageCount, videoCount, suggestPurge = false } = options;
  const parts = [];

  if ((result.failed?.length || 0) > 0) {
    parts.push(`完成：成功 ${result.success} 个，失败 ${result.failed.length} 个`);
    if (result.partial) {
      parts.push("已导出含成功项的 ZIP（含 _failed.txt）");
    } else if (result.success === 0) {
      parts.push("无成功项，未生成 ZIP");
    }
    if (result.canResume) {
      parts.push("可点击「恢复下载」重试可恢复项");
    }
    if (suggestPurge || result.unresolved?.length) {
      parts.push("可点击「剔除永久失效」从列表移除");
    }
  } else {
    parts.push(`完成：共 ${result.success} 个文件`);
  }

  if (imageCount != null || videoCount != null) {
    const requested = [];
    if (imageCount > 0) requested.push(`${imageCount} 图`);
    if (videoCount > 0) requested.push(`${videoCount} 视频`);
    if (requested.length) parts.push(`（${requested.join(" / ")}）`);
  }

  if (result.unresolved?.length) {
    parts.push(`永久失败（404/未找到）：${result.unresolved.length} 个`);
  }

  return parts.join(" ");
}

function filterByQuery(items, query, getSearchText) {
  const normalized = String(query || "")
    .trim()
    .toLowerCase();
  if (!normalized) return items;

  return items.filter((item) =>
    getSearchText(item)
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(normalized)),
  );
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
