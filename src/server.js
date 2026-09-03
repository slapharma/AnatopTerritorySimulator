// Bootstrap. The project folder lives on a Google Drive mount, which cannot hold
// node_modules (npm's writes fail with EBADF) and is a bad home for a SQLite file.
// So packages and data live on the local disk and we point Node at them here.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const defaultBase = path.join(localAppData, 'launch-working-group');

const modulesDir = process.env.LWG_MODULES || path.join(defaultBase, 'node_modules');
const projectModules = path.join(__dirname, '..', 'node_modules');

if (!fs.existsSync(path.join(projectModules, 'express'))) {
  if (!fs.existsSync(path.join(modulesDir, 'express'))) {
    console.error(`Cannot find installed packages.\nLooked in:\n  ${projectModules}\n  ${modulesDir}\nRun the install step in README.md first.`);
    process.exit(1);
  }
  process.env.NODE_PATH = modulesDir + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
  require('module').Module._initPaths();
}

process.env.LWG_DATA_DIR = process.env.LWG_DATA_DIR || path.join(defaultBase, 'data');
fs.mkdirSync(process.env.LWG_DATA_DIR, { recursive: true });

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('./app');
