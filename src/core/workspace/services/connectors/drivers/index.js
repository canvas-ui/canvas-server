'use strict';

/**
 * The connector driver registration point.
 *
 * Adding a connector: create `drivers/<name>/index.js` exporting a class that
 * extends BaseConnector, then add it to the array below. Nothing else in the
 * codebase needs to know it exists — the registry derives the driver list,
 * provenance-scheme routing, secret redaction and the settings-UI form spec
 * from the class's statics.
 */

import GithubConnector from './github/index.js';
import SlackConnector from './slack/index.js';
import GcalConnector from './gcal/index.js';
import CaldavConnector from './caldav/index.js';
import TeamsConnector from './teams/index.js';

export const CONNECTOR_CLASSES = [
    GithubConnector,
    SlackConnector,
    GcalConnector,
    CaldavConnector,
    TeamsConnector,
];

export default CONNECTOR_CLASSES;
