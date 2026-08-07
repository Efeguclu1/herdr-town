'use strict';

// Manifest actions run a command, not a pane — so the bindable "Open Agent
// Town" action asks Herdr to open the plugin's pane entrypoint.
const { call } = require('../src/herdr');

const pluginId = process.env.HERDR_PLUGIN_ID || 'efeguclu.town';
const placement = process.env.HERDR_TOWN_PLACEMENT || 'tab';

call(['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', 'town', '--placement', placement])
  .then(() => process.exit(0))
  .catch((e) => {
    process.stderr.write(`herdr-town: could not open pane: ${e.message}\n`);
    process.exit(1);
  });
