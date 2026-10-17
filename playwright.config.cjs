const { defineConfig } = require('@playwright/test');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const testDir = mkdtempSync(path.join(tmpdir(), 'roam-browser-tests-'));
module.exports = defineConfig({
  testDir:'./tests/browser',timeout:120000,workers:1,retries:0,
  use:{baseURL:'http://127.0.0.1:5051',browserName:'chromium',screenshot:'only-on-failure',trace:'retain-on-failure'},
  projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}}],
  webServer:{command:'.venv/bin/python -m flask --app app run --host 127.0.0.1 --port 5051 --no-reload',
    url:'http://127.0.0.1:5051',reuseExistingServer:false,
    stderr:'ignore',stdout:'ignore',
    env:{DATABASE_PATH:path.join(testDir,'test.sqlite3'),AUTH_PROVIDER:'local',OPENAI_API_KEY:'',FLASK_SECRET_KEY:'isolated-browser-test-session',COOKIE_SECURE:'false'}},
});
