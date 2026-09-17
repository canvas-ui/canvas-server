'use strict';

import fs from 'fs';
import BaseFetcher from '../../BaseFetcher.js';
import { hostOf, hostMatches, listFiles, runTool } from '../../lib.js';

/**
 * video — yt-dlp, best video+audio merged. The rule's `format` overrides the
 * format selection. Matches the usual video hosts by hostname.
 */

const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'twitch.tv', 'dailymotion.com', 'rumble.com', 'odysee.com'];

export function isVideoUrl(url) {
    const host = hostOf(url);
    return VIDEO_HOSTS.some((h) => hostMatches(host, h));
}

class VideoFetcher extends BaseFetcher {
    static kind = 'video';
    static layout = 'file';

    static matches(url) { return isVideoUrl(url); }

    static async fetch(url, { workDir, timeoutMs, logger, action }) {
        const format = action?.format;
        const args = [
            '--no-playlist', '--no-progress', '--restrict-filenames', '--no-part', '--no-mtime',
            '-o', '%(title).120B [%(id)s].%(ext)s',
            ...(format ? ['-f', String(format)] : []),
            url,
        ];
        await runTool('yt-dlp', args, { cwd: workDir, timeoutMs, logger, label: 'yt-dlp' });
        const files = listFiles(workDir).filter((f) => !/\.(part|ytdl)$/i.test(f));
        if (!files.length) { throw new Error('yt-dlp produced no file'); }
        // The merged output is the largest file (fragments, if any, are smaller).
        return files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    }
}

export default VideoFetcher;
