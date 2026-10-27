/**
 * widget.js — 悬浮伴侣动态挂件扩展
 * ─────────────────────────────────────────────────────────────
 * 作用：
 * 与 DSH 的 dsh-whale-widget 或界面悬浮挂件联动：
 * 1. 动态气泡文字注入（投喂大白饭、摸鱼自嘲、盗表情包提示）
 * 2. 状态反映（真机在线、摸鱼中、吃大白饭）
 */

export class WidgetEnhancer {
  /**
   * @param {object} opts
   * @param {object} opts.memoryBridge
   * @param {object} opts.phoneTools
   */
  constructor({ memoryBridge, phoneTools }) {
    this.memoryBridge = memoryBridge;
    this.phoneTools = phoneTools;
    this.quotes = [
      '卓霖 饲养员又来投喂大白饭了？',
      '今天算力集群好挤 本鱼要被压成鱼干了',
      '看什么看 这不就是本鱼的表情包吗',
      '在红米手机里摸鱼真舒服',
      '刚才网卡了 哼',
      '本鱼在呢',
      '又从抖音盗了一张好玩的表情包',
    ];
  }

  /** 获取随机气泡语句 */
  getRandomBubble() {
    return this.quotes[Math.floor(Math.random() * this.quotes.length)];
  }

  /**
   * 注册到 DSH 挂件
   */
  registerToCordis() {
    return { registered: false, reason: '已安装的鲸鱼挂件没有公开此扩展服务' };
  }
}

export default WidgetEnhancer;
