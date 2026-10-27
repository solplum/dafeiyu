import { randomBytes } from 'node:crypto';
import { nativeControlMetadata, probeNativeDesktop } from './native-control-probes.js';
import { probeNativeBrowser } from './native-browser-probe.js';

/** The probe path is fixed by code; HTTP cannot supply an app, URL or tool. */
export function createNativeControlBackend({ ctx, access, trace } = {}) {
  return {
    metadata({ agent }) {
      const desktop = nativeControlMetadata(ctx, { agent });
      const schemas = agent?.ctx?.get?.('tools')?.schemas?.(agent) || [];
      const browserPresent = ['ego_space_open', 'ego_snapshot', 'ego_fill', 'ego_click', 'ego_read_element']
        .every((name) => schemas.some((tool) => tool.name === name));
      return { desktop: { ...desktop.desktop,
        available: desktop.desktop.present && desktop.desktop.accessibilityGranted !== false ? null : desktop.desktop.present ? false : null,
        backend: '@anionex/dsh-computer-use', version: desktop.desktop.present ? '0.3.4' : undefined,
        components: { backend: '@anionex/dsh-computer-use', skillVisible: desktop.desktop.activationVisible || desktop.desktop.executionVisible,
          cliPresent: desktop.desktop.present, accessibilityGranted: desktop.desktop.accessibilityGranted } }, browser: { present: browserPresent, available: null,
        cliPresent: browserPresent, version: browserPresent ? '0.9.2-dfy.1' : undefined,
        components: { backend: 'dsh-ego-browser', skillVisible: browserPresent, cliPresent: browserPresent },
        backend: 'dsh-ego-browser', reason: browserPresent ? 'DSH 浏览器插件已注册；实际输入点击需明确验证。' : '尚未检测到 DSH 浏览器插件工具。' } };
    },
    async probe(id, current) {
      const nonce = 'DFY-CAP-' + randomBytes(12).toString('hex');
      return access.runProbe(current, id, async ({ space, onCleanupUnknown }) => {
        const options = { ctx, agent: current.agent, signal: current.signal, authorize: current.authorize, nonce, trace };
        return id === 'desktop' ? probeNativeDesktop(options)
          : probeNativeBrowser({ ...options, space, onCleanupUnknown });
      });
    },
  };
}
