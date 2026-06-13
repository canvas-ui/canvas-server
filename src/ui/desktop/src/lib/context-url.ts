/** workspace://foo/bar → /foo/bar */
export function contextUrlToPath(url: string, workspaceName?: string): string {
  if (!url) return '/'
  if (workspaceName) {
    const prefix = `${workspaceName}://`
    if (url.startsWith(prefix)) {
      const raw = url.slice(prefix.length).replace(/^\/+/, '').replace(/\/+$/, '')
      return raw ? `/${raw}` : '/'
    }
  }
  const m = url.match(/:\/\/(.*)$/)
  if (m) {
    const raw = m[1].replace(/^\/+/, '').replace(/\/+$/, '')
    return raw ? `/${raw}` : '/'
  }
  return url.startsWith('/') ? url : `/${url}`
}

/** /foo/bar → workspace://foo/bar */
export function pathToContextUrl(path: string, workspaceName?: string): string {
  const clean = path.replace(/^\/+/, '')
  if (workspaceName) return clean ? `${workspaceName}://${clean}` : `${workspaceName}://`
  return clean ? `/${clean}` : '/'
}
