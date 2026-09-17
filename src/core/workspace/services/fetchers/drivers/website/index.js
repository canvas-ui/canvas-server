'use strict';

import BaseFetcher from '../../BaseFetcher.js';
import { wgetInto } from '../page/index.js';

/**
 * website — recursive mirror, `depth` levels deep (default 2, max 5). Never
 * auto-selected; a rule has to ask for `kind: website` explicitly.
 */
class WebsiteFetcher extends BaseFetcher {
    static kind = 'website';
    static layout = 'tree';

    static async fetch(url, ctx) {
        return wgetInto(url, { ...ctx, recursive: true, depth: ctx.action?.depth });
    }
}

export default WebsiteFetcher;
