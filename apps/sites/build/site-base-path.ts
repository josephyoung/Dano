const DEFAULT_SITE_BASE_PATH = "";

export function normalizeSiteBasePath(
  value = process.env.DANO_SITE_BASE_PATH ?? DEFAULT_SITE_BASE_PATH,
): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export const siteBasePath = normalizeSiteBasePath();

export function siteAssetPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${siteBasePath}${normalizedPath}`;
}
