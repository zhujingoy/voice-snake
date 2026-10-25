const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { zipSync } = require('fflate');
const routes = require('./assets.cjs');
const root = path.resolve(__dirname, '..');

async function walk(directory, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await walk(path.join(directory, entry.name), relative + '/'));
    else if (entry.isFile()) result.push(relative);
    // npm's .bin symlinks are not needed by this project's Node-only scripts.
    else if (entry.name !== '.bin' && !entry.isSymbolicLink()) throw new Error(`Unsupported file: ${relative}`);
  }
  return result;
}

async function main() {
  const state = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (state && !process.argv.includes('--allow-dirty')) throw new Error('Commit source first, or explicitly use --allow-dirty for a development package.');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const output = path.join(root, 'test-results');
  await fs.mkdir(output, { recursive: true });
  const directory = await fs.mkdtemp(path.join(output, 'delivery-'));
  const site = path.join(directory, 'site');
  await fs.mkdir(site);
  for (const [route, source] of Object.entries(routes)) {
    if (route === '/' || route === '/models/chinese.tar.gz') continue;
    const target = path.join(site, route.slice(1));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, source), target);
  }
  await fs.writeFile(path.join(site, '.nojekyll'), '');
  const licenses = path.join(site, 'licenses');
  await fs.mkdir(licenses);
  for (const dependency of ['kontra', 'lucide-static', 'fflate', 'tar', 'uuid']) {
    const base = path.join(root, 'node_modules', dependency);
    const license = (await fs.readdir(base)).find(name => /^licen[sc]e(?:\..*)?$/i.test(name));
    if (!license) throw new Error(`Missing license: ${dependency}`);
    await fs.copyFile(path.join(base, license), path.join(licenses, dependency + '.txt'));
  }
  for (const name of ['COPYING', 'NOTICE']) {
    await fs.copyFile(path.join(root, 'third_party/vosk-browser', name),
      path.join(licenses, `vosk-browser-${name}.txt`));
  }
  await fs.writeFile(path.join(licenses, 'model.txt'),
    'vosk-model-small-cn-0.22: Apache-2.0. Publisher: Alpha Cephei.\n' +
    'Source: https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip\n' +
    'Weights unchanged; frames-per-chunk=6. Apache-2.0 text: vosk-browser-COPYING.txt\n');
  const build = { commit, sourceState: state, builtAt: new Date().toISOString(), kind: 'release-candidate',
    model: 'vosk-model-small-cn-0.22-fast-v1', realMicrophone: 'not_verified', macOS: 'not_verified',
    recognition: { default: 'lingxi', localFallback: 'vosk', credentialEndpoint: 'api/lingxi/session',
      requiresBackend: true, lingxiLiveVerified: false } };
  await fs.writeFile(path.join(site, 'build.json'), JSON.stringify(build, null, 2));
  const archive = async (files, base, name) => {
    const entries = {};
    for (const file of files) {
      const bytes = new Uint8Array(await fs.readFile(path.join(base, file)));
      entries[file] = [bytes, { level: file.endsWith('.gz') ? 0 : 6 }];
    }
    const bytes = zipSync(entries), file = path.join(directory, name);
    await fs.writeFile(file, bytes);
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const artifacts = [];
  artifacts.push(await archive(await walk(site), site, 'voice-snake-site.zip'));
  const offline = path.join(directory, 'offline');
  await fs.mkdir(offline);
  const sources = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
  for (const file of [...sources, ...await walk(path.join(root, 'node_modules'), 'node_modules/')]) {
    const target = path.join(offline, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, file), target);
  }
  await fs.mkdir(path.join(offline, '.models'));
  await fs.copyFile(path.join(root, '.models/vosk-model-small-cn-0.22-fast-v1.tar.gz'),
    path.join(offline, '.models/vosk-model-small-cn-0.22-fast-v1.tar.gz'));
  await fs.writeFile(path.join(offline, 'delivery.json'), JSON.stringify(build, null, 2));
  artifacts.push(await archive(await walk(offline), offline, 'voice-snake-offline.zip'));
  const report = { ...build, site, offline,
    siteRelative: path.relative(root, site).split(path.sep).join('/'),
    offlineRelative: path.relative(root, offline).split(path.sep).join('/'), artifacts };
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'),
    artifacts.map(item => `${item.sha256}  ${path.basename(item.file)}`).join('\n') + '\n');
  await fs.writeFile(path.join(output, 'delivery-latest.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
