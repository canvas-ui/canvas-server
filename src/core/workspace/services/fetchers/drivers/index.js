'use strict';

import FileFetcher from './file/index.js';
import VideoFetcher from './video/index.js';
import PageFetcher from './page/index.js';
import WebsiteFetcher from './website/index.js';

// Order is auto-classification priority: the first driver whose `matches(url)`
// answers wins, then content-type probing, then the `fallback` driver.
export default [FileFetcher, VideoFetcher, PageFetcher, WebsiteFetcher];
