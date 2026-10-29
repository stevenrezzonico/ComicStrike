// Which file a request path may serve: the relative path, or null. Only plain names
// (letters, digits, `_`, `-`, `.`) under the served folders or in the listed files. The
// check runs on the decoded path, as the file system will see it: Deno decodes a file
// URL's %2F into a separator, so `/client/gl%2F..%2F..%2Fcerts%2Fkey.pem` passed a check
// of the raw path and opened the certificate key.
export function staticPath(pathname, dirs, files) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/client/index.html' : pathname).slice(1);
  } catch {
    return null; // broken escapes
  }
  if (!/^[\w./-]+$/.test(rel)) return null; // also no `%` left (double encoding), `\` or NUL
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return dirs.some((d) => rel.startsWith(d)) || files.has(rel) ? rel : null;
}
