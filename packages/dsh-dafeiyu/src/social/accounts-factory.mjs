import { SocialAccounts } from './accounts.mjs';
import { BilibiliAccountDriver } from './bilibili-account.mjs';
import { BrowserAccountDriver } from './browser-account.mjs';
import { NativeEgoAccountRuntime } from './native-ego-account-runtime.mjs';
import path from 'node:path';

export function createSocialAccounts({ directory, biliPythonPath, isOpen } = {}) {
  const drivers = {};
  if (typeof biliPythonPath === 'string' && biliPythonPath.startsWith('/')) drivers.bilibili = new BilibiliAccountDriver({ python: biliPythonPath, directory: path.join(directory, 'bilibili') });
  for (const key of ['douyin', 'x']) {
    const own = path.join(directory, key);
    drivers[key] = new BrowserAccountDriver({ key, directory: own, runtime: new NativeEgoAccountRuntime({ directory: own }) });
  }
  return new SocialAccounts({ directory, drivers, isOpen });
}
