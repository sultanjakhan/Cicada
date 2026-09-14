import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROFILE = 'hanni-mvp-content-v1';
const LABEL = /^[a-z][a-z0-9-]{0,31}$/;

class ProvisionError extends Error {}

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--endpoint', '--output-dir', '--devices'].includes(name)
        || Object.hasOwn(options, name) || !args[index + 1]
        || args[index + 1].startsWith('--')) {
      throw new ProvisionError('expected_endpoint_output_dir_and_devices');
    }
    options[name] = args[index + 1];
  }
  if (Object.keys(options).length !== 3) {
    throw new ProvisionError('expected_endpoint_output_dir_and_devices');
  }
  return { endpoint: options['--endpoint'], outputDir: options['--output-dir'],
    devices: options['--devices'].split(',') };
}

function validate(options) {
  let endpoint;
  try { endpoint = new URL(options.endpoint); }
  catch { throw new ProvisionError('invalid_mvp_endpoint'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.port || endpoint.pathname !== '/'
      || !/^hanni-mvp-relay-v1\.[a-z0-9-]+\.workers\.dev$/.test(endpoint.hostname)) {
    throw new ProvisionError('expected_dedicated_mvp_workers_dev_origin');
  }
  if (!isAbsolute(options.outputDir) || ['.', '..'].includes(basename(options.outputDir))) {
    throw new ProvisionError('absolute_new_output_directory_required');
  }
  if (!Array.isArray(options.devices) || options.devices.length < 1 || options.devices.length > 8
      || options.devices.some(label => !LABEL.test(label))
      || new Set(options.devices).size !== options.devices.length) {
    throw new ProvisionError('expected_one_to_eight_unique_device_labels');
  }
  return endpoint.href;
}

async function requireOutsideGit(parent) {
  for (let current = parent;; current = dirname(current)) {
    try {
      await lstat(join(current, '.git'));
      throw new ProvisionError('output_directory_must_be_outside_git');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) return;
  }
}

export async function provision(options) {
  const endpoint = validate(options);
  // Node's Unix modes do not enforce Windows ACLs. Generate on Mac/Linux, then
  // import the per-device file on any supported client platform.
  if (process.platform === 'win32') throw new ProvisionError('provision_on_mac_or_linux');
  const parent = await realpath(dirname(resolve(options.outputDir)));
  await requireOutsideGit(parent);
  const outputDir = join(parent, basename(options.outputDir));
  // Exclusive directory creation also refuses existing directories and symlinks.
  await mkdir(outputDir, { mode: 0o700 });
  const key = randomBytes(32).toString('base64url');
  const keyId = `mvp_${randomBytes(16).toString('base64url')}`;
  const hashes = {};
  const files = [];
  for (const label of options.devices) {
    const token = randomBytes(32).toString('base64url');
    const deviceId = `mvp_${randomBytes(16).toString('base64url')}`;
    const config = { v: 1, profile: PROFILE, endpoint, device_id: deviceId,
      key_id: keyId, token, key, enabled: true };
    const filename = `device-${label}.json`;
    await writeFile(join(outputDir, filename), JSON.stringify(config, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    hashes[deviceId] = createHash('sha256').update(token).digest('hex');
    files.push(filename);
  }
  const bindings = { HANNI_DEVICE_TOKEN_HASHES: JSON.stringify(hashes) };
  await writeFile(join(outputDir, 'worker-secrets.json'), JSON.stringify(bindings, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  files.push('worker-secrets.json');
  return { profile: PROFILE, device_count: options.devices.length, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await provision(parseArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const code = error instanceof ProvisionError ? error.message : 'provision_failed_no_sensitive_details';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  }
}
