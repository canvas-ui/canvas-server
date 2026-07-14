'use strict';

// Filename-extension → MIME fallback for the content route: when a document's
// stored `contentType` is missing or a generic `application/octet-stream`
// (files ingested by path/CLI often are), a media element still needs a real
// Content-Type to decode. Mirrors the web UI's renderer map.
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ogv: 'video/ogg',
  pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown',
  txt: 'text/plain', json: 'application/json', xml: 'application/xml', csv: 'text/csv', log: 'text/plain', yml: 'text/yaml', yaml: 'text/yaml',
};

export function mimeFromFilename(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? EXT_MIME[m[1].toLowerCase()] : undefined;
}

// Resolve the effective Content-Type: a concrete stored type wins; a missing or
// generic one falls back to the filename extension; otherwise octet-stream.
export function resolveContentType(storedType, filename) {
  if (storedType && storedType !== 'application/octet-stream') return storedType;
  return mimeFromFilename(filename) || storedType || 'application/octet-stream';
}
