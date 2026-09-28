const fs = require('node:fs');
module.exports = function loadConfig(env) {
  const path = env.CONFIG_PATH;
  if (!path) throw new Error('missing');
  return JSON.parse(fs.readFileSync(path, 'utf8'));
};
