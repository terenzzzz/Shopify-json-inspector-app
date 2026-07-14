import { authenticate } from "../shopify.server";

const SHOP_THEMES_QUERY = `#graphql
  query ShopThemes {
    themes(first: 50) {
      nodes {
        id
        name
        role
      }
    }
  }
`;

const THEME_BY_ID_QUERY = `#graphql
  query ThemeById($themeId: ID!) {
    theme(id: $themeId) {
      id
      name
      role
    }
  }
`;

const THEME_TEMPLATE_FILES_QUERY = `#graphql
  query ThemeTemplateFiles($themeId: ID!, $filesFirst: Int!, $filesAfter: String) {
    theme(id: $themeId) {
      files(filenames: ["templates/*.json"], first: $filesFirst, after: $filesAfter) {
        nodes {
          filename
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const THEME_FILE_CONTENT_QUERY = `#graphql
  query ThemeFileContent($themeId: ID!, $filename: String!) {
    theme(id: $themeId) {
      files(filenames: [$filename], first: 1) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText {
              content
            }
          }
        }
        userErrors {
          code
          filename
        }
      }
    }
  }
`;

const SELECTABLE_THEME_ROLES = new Set([
  "MAIN",
  "DEVELOPMENT",
  "UNPUBLISHED",
  "DEMO",
]);

const THEME_ROLE_ORDER = {
  DEVELOPMENT: 0,
  MAIN: 1,
  UNPUBLISHED: 2,
  DEMO: 3,
};

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedThemeId = validateThemeId(url.searchParams.get("themeId"));

  try {
    const themes = await listSelectableThemes(admin);
    if (!themes.length) {
      return Response.json({
        themes: [],
        theme: null,
        templates: [],
        error: "未找到可用主题",
      });
    }

    const theme =
      (requestedThemeId && themes.find((item) => item.id === requestedThemeId)) ||
      pickDefaultTheme(themes);

    const templates = await listTemplateJsonFiles(admin, theme.id);

    return Response.json({
      themes,
      theme,
      templates,
    });
  } catch (error) {
    console.warn("主题模板列表加载失败:", error);
    return Response.json(
      {
        themes: [],
        theme: null,
        templates: [],
        error: error.message || "主题模板列表加载失败",
      },
      { status: 500 },
    );
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const body = await request.json().catch(() => ({}));
  const filename = validateTemplateFilename(body.filename);
  const themeId = validateThemeId(body.themeId);

  if (!filename) {
    return Response.json({ error: "无效的模板文件名" }, { status: 400 });
  }

  if (!themeId) {
    return Response.json({ error: "无效的主题 ID" }, { status: 400 });
  }

  try {
    const theme = await getThemeById(admin, themeId);
    if (!theme) {
      return Response.json({ error: "未找到指定主题" }, { status: 404 });
    }

    const response = await admin.graphql(THEME_FILE_CONTENT_QUERY, {
      variables: { themeId: theme.id, filename },
    });
    const payload = await response.json();

    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((item) => item.message).join("; "));
    }

    const fileNode = payload?.data?.theme?.files?.nodes?.[0];
    const content = fileNode?.body?.content;

    if (!content) {
      return Response.json({ error: `无法读取模板：${filename}` }, { status: 404 });
    }

    return Response.json({
      theme,
      filename,
      content,
    });
  } catch (error) {
    console.warn("主题模板读取失败:", filename, error);
    return Response.json(
      { error: error.message || "主题模板读取失败" },
      { status: 500 },
    );
  }
};

async function listSelectableThemes(admin) {
  const response = await admin.graphql(SHOP_THEMES_QUERY);
  const payload = await response.json();

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message).join("; "));
  }

  const themes = (payload?.data?.themes?.nodes || [])
    .filter((theme) => SELECTABLE_THEME_ROLES.has(theme.role))
    .map((theme) => ({
      id: theme.id,
      name: theme.name,
      role: theme.role,
    }));

  return sortThemes(themes);
}

async function getThemeById(admin, themeId) {
  const response = await admin.graphql(THEME_BY_ID_QUERY, {
    variables: { themeId },
  });
  const payload = await response.json();

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message).join("; "));
  }

  const theme = payload?.data?.theme;
  if (!theme) return null;

  return {
    id: theme.id,
    name: theme.name,
    role: theme.role,
  };
}

function pickDefaultTheme(themes) {
  return (
    themes.find((theme) => theme.role === "DEVELOPMENT") ||
    themes.find((theme) => theme.role === "MAIN") ||
    themes[0]
  );
}

function sortThemes(themes) {
  return [...themes].sort((left, right) => {
    const roleDiff =
      (THEME_ROLE_ORDER[left.role] ?? 99) - (THEME_ROLE_ORDER[right.role] ?? 99);
    if (roleDiff !== 0) return roleDiff;
    return left.name.localeCompare(right.name);
  });
}

async function listTemplateJsonFiles(admin, themeId) {
  const filenames = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(THEME_TEMPLATE_FILES_QUERY, {
      variables: { themeId, filesFirst: 50, filesAfter: after },
    });
    const payload = await response.json();

    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((item) => item.message).join("; "));
    }

    const filesConnection = payload?.data?.theme?.files;
    const nodes = filesConnection?.nodes || [];

    filenames.push(...nodes.map((node) => node.filename).filter(Boolean));

    hasNextPage = Boolean(filesConnection?.pageInfo?.hasNextPage);
    after = filesConnection?.pageInfo?.endCursor || null;
  }

  return [...new Set(filenames)].sort((a, b) => a.localeCompare(b));
}

function validateThemeId(themeId) {
  const value = String(themeId || "").trim();
  if (!/^gid:\/\/shopify\/OnlineStoreTheme\/\d+$/.test(value)) {
    return "";
  }
  return value;
}

function validateTemplateFilename(filename) {
  const value = String(filename || "").trim();
  if (!/^templates\/[A-Za-z0-9_.-]+\.json$/.test(value)) {
    return "";
  }
  return value;
}
