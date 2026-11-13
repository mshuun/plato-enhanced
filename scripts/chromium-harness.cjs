'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect(url, errors) {
  const ws = new WebSocket(url), pending = new Map(), listeners = new Map();
  let counter = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), task = pending.get(message.id);
    if (task) {
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
    }
    for (const listener of listeners.get(message.method) || []) {
      Promise.resolve().then(() => listener(message.params)).catch(error => errors.push(error.message));
    }
  });
  ws.addEventListener('close', () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP connection closed')); }
    pending.clear();
  });
  const client = {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    async evaluate(fn, ...args) {
      const expression = '(' + fn.toString() + ')(' + args.map(arg => JSON.stringify(arg)).join(',') + ')';
      const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    close() { ws.close(); }
  };
  client.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  return client;
}

async function launch(output, extraFlags = []) {
  const browser = process.env.PLATO_TEST_BROWSER || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(file => fs.existsSync(file));
  if (!browser) throw new Error('Set PLATO_TEST_BROWSER to an installed Chromium browser.');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(output, 'profile-'));
  const child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, ...extraFlags, 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '', browserClient;
  const errors = [], clients = [];
  child.stderr.on('data', data => { log = (log + data.toString()).slice(-4000); });
  child.on('error', error => errors.push(error.message));
  const session = {
    browser, errors,
    async close() {
      if (browserClient) await browserClient.send('Browser.close').catch(() => {});
      for (const client of clients) client.close();
      for (let attempt = 0; child.exitCode === null && attempt < 50; attempt++) await delay(100);
      if (child.exitCode === null) child.kill();
      const resolved = path.resolve(profile);
      if (path.dirname(resolved) !== path.resolve(output) || !path.basename(resolved).startsWith('profile-')) throw new Error('Unexpected profile cleanup path');
      await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
  };
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; !fs.existsSync(portFile) && attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Browser exited (${child.exitCode}): ${log}`);
      await delay(100);
    }
    if (!fs.existsSync(portFile)) throw new Error('Browser did not publish its debugging port: ' + log);
    const [port, socket] = fs.readFileSync(portFile, 'utf8').trim().split('\n').map(value => value.trim());
    session.base = 'http://127.0.0.1:' + port;
    session.connect = async url => { const client = await connect(url, errors); clients.push(client); return client; };
    session.list = async () => (await fetch(session.base + '/json/list')).json();
    session.protocol = async () => (await fetch(session.base + '/json/protocol')).json();
    session.client = browserClient = await session.connect('ws://127.0.0.1:' + port + socket);
    session.version = (await browserClient.send('Browser.getVersion')).product;
    return session;
  } catch (error) { await session.close(); throw error; }
}

async function until(client, fn, ...args) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await client.evaluate(fn, ...args)) return;
    await delay(100);
  }
  throw new Error('Browser condition did not become ready: ' + fn.toString());
}
module.exports = { launch, delay, until };
