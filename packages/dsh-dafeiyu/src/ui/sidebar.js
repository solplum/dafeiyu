/**
 * sidebar.js — DSH 侧边栏“大肥鱼伴侣”看板
 * ─────────────────────────────────────────────────────────────
 * 作用：
 * 负责在 DSH 桌面端渲染专属的大肥鱼伴侣看板页面，提供：
 * 1. 伴侣状态与真机心跳 (Redmi Note 192.0.2.10:5555)
 * 2. 饲养员永固档案 (卓霖)
 * 3. 实时手账大事记时间轴 (timeline.md)
 * 4. 表情包画廊与战报
 */

export class SidebarDashboard {
  /**
   * @param {object} opts
   * @param {object} opts.memoryBridge
   * @param {object} opts.phoneTools
   * @param {object} opts.memeManager
   */
  constructor({ memoryBridge, phoneTools, memeManager }) {
    this.memoryBridge = memoryBridge;
    this.phoneTools = phoneTools;
    this.memeManager = memeManager;
  }

  /**
   * 渲染侧边栏数据摘要
   */
  async getDashboardData({ includePrivateMemory = false } = {}) {
    const phoneState = await this.phoneTools.getDeviceState();
    const timelineRaw = includePrivateMemory ? this.memoryBridge.readTimeline() : "";
    const memes = this.memeManager.listMemes();

    // 解析 timeline 条目
    const timelineItems = [];
    const entries = timelineRaw.split(/\n---\n/);
    for (const e of entries.slice(-10).reverse()) {
      const match = e.match(/###\s*\[(.*?)\]\s*(.*)/);
      if (match) {
        timelineItems.push({
          date: match[1],
          summary: match[2].trim(),
          raw: e.trim(),
        });
      }
    }

    return {
      character: {
        name: '大肥鱼',
        avatar: 'assets/DSniang1.png',
        tagline: 'DeepSeek 云端超脑 · 手机摸鱼伴侣',
        owner: '卓霖 (饲养员)',
        status: phoneState.online ? '在手机里游荡' : '休息中',
      },
      phone: phoneState,
      timeline: timelineItems,
      memes: {
        total: memes.length,
        items: memes.slice(0, 12),
      },
    };
  }

  /**
   * 注册到 DSH 侧边栏/UI 扩展服务
   */
  registerToCordis() {
    return { registered: false, reason: '尚未实现 DSH 客户端侧栏扩展' };
  }
}

export default SidebarDashboard;
