export function publicAssetUrl(
  relativePath: string,
  baseUrl = import.meta.env.BASE_URL,
  documentBaseUrl = document.baseURI
): string {
  if (
    !relativePath ||
    relativePath.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(relativePath)
  ) {
    throw new Error(`Public asset path must be relative: ${relativePath}`);
  }
  return new URL(relativePath, new URL(baseUrl, documentBaseUrl)).toString();
}
