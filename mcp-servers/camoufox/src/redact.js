export function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?..." : "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}
