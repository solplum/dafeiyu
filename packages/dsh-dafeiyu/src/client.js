/* Native DSH settings module. React and slots are supplied by the host. */
window.__ModuleLoader__.load({
  id: 'dsh-dafeiyu',
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { useState, useRef, useEffect } = React;
    const h = React.createElement;
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const defaults = {
      autoStartOneBot: false, ownerQq: '', qqAccounts: [], onebotSelfId: '', onebotWs: '', onebotHttp: '',
      phoneEnabled: false, phoneDevice: '', autoConnectPhone: false, maxListenSeconds: 3,
      allowedPhoneTools: ['phone_screenshot', 'phone_get_ui_tree', 'phone_key', 'phone_listen'],
      allowedPhoneKeys: ['back'], voiceTranscription: false, allowMemoryWrites: false, allowMemeSync: false,
      backgroundTasksEnabled: true, externalTaskRouting: true,
    };
    const tools = [
      ['phone_screenshot', '查看截图', '读取手机屏幕图片'],
      ['phone_get_ui_tree', '读取界面', '获取当前页面的文字与控件'],
      ['phone_key', '返回按键', '仅允许下方勾选的返回键'],
      ['phone_listen', '短时录音', '单次最多 3 秒；是否听懂以转写回执为准'],
    ];
    // 四页信息架构：首页(状态) / 她(人设) / 聊天(对象与任务) / 高级(服务与运维)。
    // 原子页面 key 全部保留，只是收进分组，页面组件与草稿语义不变。
    const subTabs = { persona: '性格', memory: '记忆', memes: '表情包', life: '生活与成长',
      qq: 'QQ账号', accounts: '聊天对象', background: '任务',
      model: '模型服务', voice: '声音', social: '视频平台', phone: '手机', dependencies: '安装与更新', capabilities: '功能' };
    const tabGroups = [
      { id: 'overview', label: '首页', children: [] },
      { id: 'her', label: '她', children: ['persona', 'memory', 'memes', 'life'] },
      { id: 'chat', label: '聊天', children: ['qq', 'accounts', 'background'] },
      { id: 'advanced', label: '高级', children: ['model', 'voice', 'social', 'phone', 'dependencies', 'capabilities'] },
    ];
    const groupOfKey = new Map(tabGroups.flatMap((group) => group.children.map((key) => [key, group])));
    const everyPageKey = ['overview', ...groupOfKey.keys()];
    const relationPresets = [
      { id: 'existing', name: '沿用当前人设', userRole: '', companionRole: '', userTitle: '', companionTitle: '' },
      { id: 'friends', name: '朋友', userRole: '朋友', companionRole: '朋友', userTitle: '朋友', companionTitle: '大肥鱼' },
      { id: 'master-servant', name: '主仆', userRole: '主人', companionRole: '侍从', userTitle: '主人', companionTitle: '大肥鱼' },
      { id: 'boss-underling', name: '老大和小弟', userRole: '老大', companionRole: '女小弟', userTitle: '老大', companionTitle: '大肥鱼' },
      { id: 'father-daughter', name: '父女', userRole: '父亲', companionRole: '女儿', userTitle: '爸爸', companionTitle: '女儿' },
      { id: 'mother-daughter', name: '母女', userRole: '母亲', companionRole: '女儿', userTitle: '妈妈', companionTitle: '女儿' },
      { id: 'partners', name: '恋人', userRole: '恋人', companionRole: '恋人', userTitle: '亲爱的', companionTitle: '大肥鱼' },
      { id: 'custom', name: '自定义', userRole: '', companionRole: '', userTitle: '', companionTitle: '' },
    ];
    const fatherDaughterRoles = (identity) => identity?.userRole === '父亲' && identity?.companionRole === '女儿';
    const motherDaughterRoles = (identity) => identity?.userRole === '母亲' && identity?.companionRole === '女儿'
      || identity?.userRole === '女儿' && identity?.companionRole === '母亲';
    function presentedRelationType(identity) {
      if (identity?.relationType !== 'parent-child') return identity?.relationType;
      return fatherDaughterRoles(identity) ? 'father-daughter' : motherDaughterRoles(identity) ? 'mother-daughter' : 'custom';
    }
    const relationLabel = (identity) => identity?.relationType === 'parent-child' && presentedRelationType(identity) === 'custom'
      ? '自定义 / 旧设置' : relationPresets.find((item) => item.id === presentedRelationType(identity))?.name || '未设置';
    const relationDirection = (identity) => [identity?.userRole && '你：' + identity.userRole,
      identity?.companionRole && '大肥鱼：' + identity.companionRole].filter(Boolean).join(' · ');
    const freshIdentity = () => ({ id: 'identity-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      name: '新身份', relationType: 'existing', userRole: '', companionRole: '', userTitle: '', companionTitle: '', description: '' });
    function accountValidation(accounts, ownerQq, receiver) {
      const errors = [], numbers = new Set();
      if (!Array.isArray(accounts)) return ['账号列表格式无效，请刷新配置。'];
      if (accounts.length > 20) errors.push('最多配置 20 个用户账号。');
      if (ownerQq && !accounts.some((account) => account?.qq === ownerQq)) errors.push('主要账号必须保留在用户列表中。');
      for (const [index, account] of accounts.entries()) {
        if (!account || typeof account !== 'object' || Array.isArray(account)) { errors.push('账号 ' + (index + 1) + '：配置格式无效。'); continue; }
        const label = (typeof account.name === 'string' ? account.name.trim() : '') || '账号 ' + (index + 1);
        if (!/^[1-9]\d{0,19}$/.test(account.qq || '')) errors.push(label + '：请填写有效 QQ 号。');
        else if (numbers.has(account.qq)) errors.push(label + '：QQ 号重复。');
        numbers.add(account.qq);
        if (receiver && account.qq === receiver) errors.push(label + '：用户 QQ 不能与接收小号相同。');
        if (!Array.isArray(account.identities) || !account.identities.length || account.identities.length > 12) {
          errors.push(label + '：需要保留 1–12 个身份。'); continue;
        }
        if (!account.identities.some((identity) => identity?.id === account.activeIdentityId)) errors.push(label + '：请选择当前身份。');
        const ids = new Set();
        for (const identity of account.identities) {
          if (!identity || typeof identity !== 'object' || Array.isArray(identity)) { errors.push(label + '：身份格式无效。'); continue; }
          if (typeof identity.name !== 'string' || !identity.name.trim()) errors.push(label + '：每个身份都需要名称。');
          const hasRoles = typeof identity.userRole === 'string' && Boolean(identity.userRole.trim())
            && typeof identity.companionRole === 'string' && Boolean(identity.companionRole.trim());
          if (identity.relationType === 'custom' && !hasRoles
            && (typeof identity.description !== 'string' || !identity.description.trim())) {
            errors.push(label + '：自定义关系请填写身份与相处说明。');
          } else if (!['existing', 'custom'].includes(identity.relationType) && !hasRoles) {
            errors.push(label + '：关系预设不完整，请重新选择关系。');
          }
          if (ids.has(identity.id)) errors.push(label + '：身份标识重复，请重新添加。');
          ids.add(identity.id);
        }
      }
      return errors;
    }
    const style = `
.dfy-panel{--dfy-ink:var(--dsw-alias-label-primary,#263449);--dfy-muted:var(--dsw-alias-label-secondary,#6d7b8e);--dfy-border:var(--dsw-alias-border-l2,#dfe6ee);--dfy-surface:var(--dsw-alias-bg-layer-1,#fff);--dfy-soft:var(--dsw-alias-bg-layer-2,#f3f6fa);--dfy-blue:#3273b8;--dfy-green:#24806b;--dfy-amber:#a76612;box-sizing:border-box;width:100%;max-width:980px;margin:0 auto;padding:24px;color:var(--dfy-ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.dfy-panel *{box-sizing:border-box}.dfy-panel h2,.dfy-panel h3,.dfy-panel p{margin:0}.dfy-panel button,.dfy-panel input,.dfy-panel select{font:inherit}.dfy-panel button{cursor:pointer}.dfy-panel button:disabled{cursor:default;opacity:.5}.dfy-panel button:focus-visible,.dfy-panel input:focus-visible,.dfy-panel select:focus-visible{outline:3px solid #559bd780;outline-offset:3px}
.dfy-panel .dfy-hero{display:flex;align-items:center;gap:16px;padding:24px;border:1px solid var(--dfy-border);border-radius:18px;background:linear-gradient(125deg,#5d9dd818,transparent 75%);margin-bottom:18px}.dfy-panel .dfy-mark{display:grid;place-items:center;flex:none;width:54px;height:54px;border-radius:17px;background:linear-gradient(135deg,#4389c8,#66b4ca);color:#fff;font-size:32px;line-height:1;box-shadow:0 5px 16px #4184ba22}.dfy-panel .dfy-hero h2{font-size:24px;font-weight:650;letter-spacing:.02em}.dfy-panel .dfy-eyebrow{font-size:11px;letter-spacing:.12em;color:var(--dfy-blue);font-weight:650;margin-bottom:3px}.dfy-panel .dfy-subtitle{color:var(--dfy-muted);font-size:13px;margin-top:4px}.dfy-panel .dfy-live{margin-left:auto;display:flex;gap:6px;align-items:center;white-space:nowrap;font-size:12px;color:var(--dfy-muted)}
.dfy-panel .dfy-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}.dfy-panel .dfy-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:20px}.dfy-panel .dfy-card{padding:17px 18px;border:1px solid var(--dfy-border);border-radius:13px;min-width:0;background:var(--dfy-surface)}.dfy-panel .dfy-card-label{font-size:12px;color:var(--dfy-muted);margin-bottom:8px}.dfy-panel .dfy-card-value{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600}.dfy-panel .dfy-card-note{font-size:12px;color:var(--dfy-muted);margin-top:6px}.dfy-panel .dfy-good{color:var(--dfy-green)}.dfy-panel .dfy-warn{color:var(--dfy-amber)}.dfy-panel .dfy-neutral{color:var(--dfy-muted)}
.dfy-panel .dfy-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dfy-border);margin-bottom:22px}.dfy-panel .dfy-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dfy-muted);padding:11px 16px;margin-bottom:-1px;white-space:nowrap}.dfy-panel .dfy-tab[aria-selected=true]{color:var(--dfy-blue);border-bottom-color:var(--dfy-blue);font-weight:600}.dfy-panel .dfy-section{border:1px solid var(--dfy-border);border-radius:14px;padding:20px;margin-bottom:16px}.dfy-panel .dfy-section h3{font-size:15px;font-weight:600;margin-bottom:4px}.dfy-panel .dfy-description{color:var(--dfy-muted);font-size:12px;margin-bottom:17px}.dfy-panel .dfy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:20px;row-gap:17px}.dfy-panel .dfy-field{min-width:0}.dfy-panel .dfy-label{display:flex;align-items:center;gap:7px;font-weight:550;margin-bottom:6px;font-size:13px}.dfy-panel .dfy-field input:not([type=checkbox]),.dfy-panel .dfy-field select{display:block;width:100%;min-height:38px;padding:8px 10px;border:1px solid var(--dfy-border);border-radius:8px;background:var(--dfy-surface);color:var(--dfy-ink)}.dfy-panel .dfy-field input:disabled,.dfy-panel .dfy-field select:disabled{background:var(--dfy-soft);opacity:.72}.dfy-panel .dfy-hint{font-size:12px;color:var(--dfy-muted);margin-top:5px;overflow-wrap:anywhere}.dfy-panel .dfy-field-error{font-size:12px;color:#b14545;margin-top:5px}.dfy-panel .dfy-badge{font-size:10px;line-height:1.5;padding:1px 6px;border-radius:5px;background:var(--dfy-soft);color:var(--dfy-muted);font-weight:400;white-space:nowrap}
.dfy-panel .dfy-toggle{display:flex;align-items:center;gap:14px;padding:13px 0;border-bottom:1px solid var(--dfy-border);cursor:pointer}.dfy-panel .dfy-toggle:last-child{border-bottom:0}.dfy-panel .dfy-toggle-copy{flex:1;min-width:0}.dfy-panel .dfy-toggle-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:550}.dfy-panel .dfy-toggle input{width:17px;height:17px;accent-color:var(--dfy-blue);flex:none;margin:0}.dfy-panel .dfy-tool-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px;margin:12px 0}.dfy-panel .dfy-readonly{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid var(--dfy-border);font-size:13px}.dfy-panel .dfy-readonly:last-child{border-bottom:0}.dfy-panel .dfy-readonly span:last-child{text-align:right;color:var(--dfy-muted)}.dfy-panel .dfy-paths{margin-top:10px}.dfy-panel .dfy-path{padding:10px 0;border-top:1px solid var(--dfy-border)}.dfy-panel .dfy-path span{display:block;font-size:12px;color:var(--dfy-muted);margin-bottom:4px}.dfy-panel .dfy-path code{display:block;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;user-select:text}
.dfy-panel .dfy-notice{padding:12px 14px;border:1px solid #8cb7d555;border-radius:9px;background:#5095c910;color:var(--dfy-ink);font-size:12px;margin-bottom:14px;overflow-wrap:anywhere}.dfy-panel .dfy-notice.dfy-error{border-color:#c56d6d66;background:#c55a5a0c}.dfy-panel .dfy-notice.dfy-warning{border-color:#c8a05a66;background:#cba1430c}.dfy-panel .dfy-notice ul{margin:7px 0 0;padding-left:18px}.dfy-panel .dfy-link-button{border:0;background:transparent;padding:0;color:var(--dfy-blue);font-size:12px;text-decoration:underline;text-underline-offset:3px}.dfy-panel .dfy-footer{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 0 5px;margin-top:22px;border-top:1px solid var(--dfy-border);background:var(--dfy-surface)}.dfy-panel .dfy-footer-note{font-size:12px;color:var(--dfy-muted);max-width:46%}.dfy-panel .dfy-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.dfy-panel .dfy-button{min-height:36px;padding:7px 13px;border:1px solid var(--dfy-border);border-radius:8px;background:var(--dfy-surface);color:var(--dfy-ink);font-size:12px}.dfy-panel .dfy-button:hover:not(:disabled){background:var(--dfy-soft)}.dfy-panel .dfy-button.dfy-primary{background:var(--dfy-blue);border-color:var(--dfy-blue);color:white}.dfy-panel .dfy-button.dfy-primary:hover:not(:disabled){filter:brightness(1.08)}.dfy-panel .dfy-empty{padding:35px 16px;text-align:center;color:var(--dfy-muted)}
@media(prefers-color-scheme:dark){.dfy-panel{--dfy-ink:var(--dsw-alias-label-primary,#e1e9f3);--dfy-muted:var(--dsw-alias-label-secondary,#9baabd);--dfy-border:var(--dsw-alias-border-l2,#344253);--dfy-surface:var(--dsw-alias-bg-layer-1,#1b2431);--dfy-soft:var(--dsw-alias-bg-layer-2,#263244);--dfy-blue:#75b2e6;--dfy-green:#72c6ac;--dfy-amber:#e1b46e}.dfy-panel .dfy-button.dfy-primary{background:#326fa7;border-color:#326fa7}}
@media(max-width:640px){.dfy-panel{padding:14px}.dfy-panel .dfy-hero{padding:18px 16px;gap:12px}.dfy-panel .dfy-hero h2{font-size:21px}.dfy-panel .dfy-mark{width:44px;height:44px;font-size:27px}.dfy-panel .dfy-live{display:none}.dfy-panel .dfy-cards{gap:8px}.dfy-panel .dfy-card{padding:12px 10px}.dfy-panel .dfy-card-value{font-size:13px;gap:5px}.dfy-panel .dfy-card-note{font-size:11px}.dfy-panel .dfy-section{padding:16px}.dfy-panel .dfy-grid,.dfy-panel .dfy-tool-grid{grid-template-columns:1fr}.dfy-panel .dfy-tab{padding:10px 12px}.dfy-panel .dfy-footer{align-items:flex-start;flex-direction:column}.dfy-panel .dfy-footer-note{max-width:100%}.dfy-panel .dfy-actions{width:100%}}
.dfy-panel .dfy-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.dfy-panel .dfy-tabs{overflow-x:auto}.dfy-panel [hidden]{display:none!important}.dfy-panel .dfy-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:12px 0}.dfy-panel .dfy-inline-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dfy-panel .dfy-search{display:flex;align-items:flex-end;gap:8px;flex:1;min-width:220px}.dfy-panel .dfy-search .dfy-field{flex:1}.dfy-panel .dfy-search .dfy-button{min-height:38px}.dfy-panel .dfy-meta{font-size:12px;color:var(--dfy-muted);overflow-wrap:anywhere}.dfy-panel .dfy-state-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:16px 0}.dfy-panel .dfy-state-cell{padding:12px;border:1px solid var(--dfy-border);border-radius:9px;min-width:0}.dfy-panel .dfy-state-cell span{display:block;font-size:11px;color:var(--dfy-muted);margin-bottom:4px}.dfy-panel .dfy-state-cell strong{font-size:13px;font-weight:550}.dfy-panel .dfy-qr{display:flex;gap:20px;align-items:center;margin-top:16px;padding:16px;border:1px solid var(--dfy-border);border-radius:10px}.dfy-panel .dfy-qr img{width:210px;height:210px;object-fit:contain;background:white;border:10px solid white;border-radius:8px}.dfy-panel .dfy-qr-copy{font-size:12px;color:var(--dfy-muted);max-width:300px}.dfy-panel .dfy-gallery{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0}.dfy-panel .dfy-meme{border:1px solid var(--dfy-border);border-radius:10px;overflow:hidden;min-width:0;background:var(--dfy-surface)}.dfy-panel .dfy-thumbnail{display:flex;width:100%;height:136px;align-items:center;justify-content:center;border:0;border-bottom:1px solid var(--dfy-border);padding:8px;background:var(--dfy-soft);color:var(--dfy-muted);font-size:12px}.dfy-panel .dfy-thumbnail img{max-width:100%;max-height:120px;object-fit:contain}.dfy-panel .dfy-meme-copy{padding:10px}.dfy-panel .dfy-meme-title{font-size:12px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dfy-panel .dfy-meme-file{font-size:10px;color:var(--dfy-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.dfy-panel .dfy-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px;min-height:17px}.dfy-panel .dfy-preview{margin:14px 0;padding:16px;border:1px solid var(--dfy-border);border-radius:10px;text-align:center;background:var(--dfy-soft)}.dfy-panel .dfy-preview img{display:block;max-width:100%;max-height:420px;object-fit:contain;margin:12px auto}.dfy-panel .dfy-preview figcaption{font-size:12px;overflow-wrap:anywhere}.dfy-panel .dfy-persona{width:100%;min-height:330px;resize:vertical;padding:14px;border:1px solid var(--dfy-border);border-radius:9px;background:var(--dfy-surface);color:var(--dfy-ink);font:13px/1.8 ui-monospace,SFMono-Regular,Menlo,"Microsoft YaHei",monospace;tab-size:2}.dfy-panel .dfy-persona:focus-visible{outline:3px solid #559bd780;outline-offset:3px}.dfy-panel .dfy-persona:read-only{background:var(--dfy-soft)}.dfy-panel .dfy-persona-latest{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;font:12px/1.7 ui-monospace,monospace;margin:10px 0 0}.dfy-panel .dfy-detail{font-size:12px;color:var(--dfy-muted);margin:12px 0}.dfy-panel .dfy-detail summary{cursor:pointer}
@media(max-width:760px){.dfy-panel .dfy-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.dfy-panel .dfy-gallery{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:480px){.dfy-panel .dfy-cards{grid-template-columns:1fr}.dfy-panel .dfy-gallery{grid-template-columns:repeat(2,minmax(0,1fr))}.dfy-panel .dfy-state-grid{grid-template-columns:1fr}.dfy-panel .dfy-qr{flex-direction:column;align-items:flex-start}.dfy-panel .dfy-qr img{align-self:center}.dfy-panel .dfy-search{min-width:100%}.dfy-panel .dfy-persona{min-height:290px}}
.dfy-panel{padding:16px 20px}.dfy-panel .dfy-hero{padding:0 0 13px;gap:10px;border:0;border-bottom:1px solid var(--dfy-border);border-radius:0;background:none;margin-bottom:10px}.dfy-panel .dfy-mark{width:32px;height:32px;font-size:23px;border-radius:9px;box-shadow:none}.dfy-panel .dfy-hero h2{font-size:17px;letter-spacing:0}.dfy-panel .dfy-eyebrow{display:none}.dfy-panel .dfy-subtitle{font-size:11px;margin-top:0}.dfy-panel .dfy-live{font-size:11px}.dfy-panel .dfy-tabs{margin-bottom:14px;gap:0}.dfy-panel .dfy-tab{padding:9px 11px;font-size:12px}.dfy-panel .dfy-cards{gap:8px;margin-bottom:14px}.dfy-panel .dfy-card{padding:10px 12px;border-radius:9px}.dfy-panel .dfy-card-label{margin-bottom:4px}.dfy-panel .dfy-card-value{font-size:13px}.dfy-panel .dfy-card-note{font-size:11px;margin-top:4px}.dfy-panel .dfy-section{padding:16px;border-radius:10px;margin-bottom:12px}.dfy-panel .dfy-description{margin-bottom:10px}.dfy-panel .dfy-status-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.dfy-panel .dfy-status-title{display:flex;align-items:center;gap:8px;font-size:19px;font-weight:600}.dfy-panel .dfy-status-note{font-size:11px;color:var(--dfy-muted);margin-top:4px}.dfy-panel .dfy-status-table{display:grid;grid-template-columns:1fr 1fr;column-gap:22px}.dfy-panel .dfy-status-table .dfy-readonly{align-items:flex-start;padding:9px 0;font-size:12px}.dfy-panel .dfy-status-table .dfy-readonly span:first-child{white-space:nowrap}.dfy-panel .dfy-status-table .dfy-readonly span:last-child{overflow-wrap:anywhere}.dfy-panel .dfy-footer{margin-top:14px;padding-top:12px}.dfy-panel .dfy-resource{padding:14px 0;border-bottom:1px solid var(--dfy-border)}.dfy-panel .dfy-resource:first-child{padding-top:4px}.dfy-panel .dfy-resource:last-child{border-bottom:0}.dfy-panel .dfy-resource-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dfy-panel .dfy-resource-name{font-size:14px;font-weight:600}.dfy-panel .dfy-resource-details{display:flex;gap:6px 18px;flex-wrap:wrap;font-size:12px;margin-top:9px}.dfy-panel .dfy-resource-details span{color:var(--dfy-muted)}.dfy-panel .dfy-resource-details strong{color:var(--dfy-ink);font-weight:500}.dfy-panel .dfy-resource .dfy-inline-actions{margin-top:11px}.dfy-panel .dfy-resource .dfy-description{margin-top:4px;margin-bottom:0}.dfy-panel .dfy-action-note{font-size:11px;color:var(--dfy-muted);margin-top:7px}.dfy-panel .dfy-heading-actions{display:flex;align-items:center;gap:8px}.dfy-panel .dfy-check-label{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dfy-muted)}.dfy-panel .dfy-check-label input{accent-color:var(--dfy-blue)}.dfy-panel .dfy-card-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.dfy-panel .dfy-card-actions .dfy-button{min-height:30px;padding:4px 8px;font-size:11px}.dfy-panel .dfy-card .dfy-detail{margin:9px 0 0}.dfy-panel .dfy-guide-copy{margin-top:8px;line-height:1.65}.dfy-panel .dfy-guide-copy ol{padding-left:19px;margin:6px 0}.dfy-panel .dfy-guide-copy li+li{margin-top:6px}.dfy-panel .dfy-guide-copy a{color:var(--dfy-blue)}.dfy-panel .dfy-suite-component{margin-top:12px;padding:12px;border:1px solid var(--dfy-border);border-radius:8px}.dfy-panel .dfy-suite-component .dfy-resource-details{margin-top:6px}
@media(max-width:640px){.dfy-panel{padding:12px}.dfy-panel .dfy-hero{padding:0 0 10px;gap:8px}.dfy-panel .dfy-hero h2{font-size:16px}.dfy-panel .dfy-mark{width:30px;height:30px}.dfy-panel .dfy-status-table{grid-template-columns:1fr}.dfy-panel .dfy-status-head{align-items:flex-start}.dfy-panel .dfy-resource-heading{flex-wrap:wrap}.dfy-panel .dfy-tab{padding:9px 10px}}
.dfy-panel .dfy-meme-editor{padding:14px;margin:14px 0;border:1px solid var(--dfy-border);border-radius:10px;background:var(--dfy-surface)}.dfy-panel .dfy-meme-text{display:block;width:100%;min-height:104px;resize:vertical;padding:10px;border:1px solid var(--dfy-border);border-radius:8px;background:var(--dfy-surface);color:var(--dfy-ink);font:13px/1.7 system-ui,-apple-system,"Microsoft YaHei",sans-serif}.dfy-panel .dfy-meme-text:focus-visible{outline:3px solid #559bd780;outline-offset:3px}.dfy-panel .dfy-meme-text:disabled{background:var(--dfy-soft);opacity:.72}.dfy-panel .dfy-meme-meaning{font-size:11px;line-height:1.6;margin:7px 0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.dfy-panel .dfy-preserve-lines{white-space:pre-wrap;overflow-wrap:anywhere}.dfy-panel .dfy-meme-copy .dfy-link-button{margin-top:7px}
.dfy-panel .dfy-account-layout{display:grid;grid-template-columns:minmax(150px,1fr) minmax(0,3fr);gap:16px}.dfy-panel .dfy-account-list{display:flex;flex-direction:column;gap:7px}.dfy-panel .dfy-account-choice{width:100%;text-align:left;white-space:normal;overflow-wrap:anywhere}.dfy-panel .dfy-account-choice[aria-pressed=true],.dfy-panel .dfy-identity-choice[aria-pressed=true]{border-color:var(--dfy-blue);background:#5095c910}.dfy-panel .dfy-account-choice strong{display:block;font-size:12px}.dfy-panel .dfy-account-choice span{display:block;font-size:11px;color:var(--dfy-muted);margin-top:3px}.dfy-panel .dfy-identity-list{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.dfy-panel .dfy-identity-choice{max-width:100%;overflow-wrap:anywhere}.dfy-panel .dfy-identity-editor{border-top:1px solid var(--dfy-border);padding-top:14px;margin-top:14px}.dfy-panel .dfy-relation-preview{padding:12px;border:1px solid var(--dfy-border);border-radius:8px;background:var(--dfy-soft);font-size:12px;margin-top:14px;overflow-wrap:anywhere}.dfy-panel .dfy-relation-preview p+p{margin-top:5px}.dfy-panel .dfy-account-running{margin-top:8px;padding-top:8px;border-top:1px solid var(--dfy-border);font-size:12px;overflow-wrap:anywhere}
@media(max-width:640px){.dfy-panel .dfy-account-layout{grid-template-columns:1fr}.dfy-panel .dfy-account-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

    const consumerStyle = `
.dfy-panel{padding:18px 20px;max-width:1040px;--dfy-radius:12px}.dfy-panel .dfy-hero{padding:0 0 14px;background:none;border:0;border-radius:0;gap:10px;margin-bottom:0}.dfy-panel .dfy-hero h2{font-size:20px;letter-spacing:0}.dfy-panel .dfy-mark{width:32px;height:32px;border-radius:10px;font-size:22px;box-shadow:none}.dfy-panel .dfy-live{font-size:11px}.dfy-panel .dfy-tabs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:2px;overflow:visible;margin:0 0 18px}.dfy-panel .dfy-tab{padding:10px 7px;text-align:center;font-size:13px}.dfy-panel .dfy-settings-nav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px;padding:10px;background:var(--dfy-soft);border-radius:12px}.dfy-panel .dfy-settings-tab{padding:7px 11px;border:0;border-radius:7px;background:transparent;color:var(--dfy-muted);font-size:12px}.dfy-panel .dfy-settings-tab[aria-selected=true]{background:var(--dfy-surface);color:var(--dfy-ink);box-shadow:0 1px 4px #1825360a;font-weight:600}.dfy-panel .dfy-section{padding:18px;border-radius:var(--dfy-radius)}.dfy-panel .dfy-toolbar{gap:10px;flex-wrap:wrap}.dfy-panel .dfy-titleline{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}.dfy-panel .dfy-titleline .dfy-label{margin-bottom:0}.dfy-panel .dfy-titleline h3{margin:0}.dfy-panel .dfy-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}.dfy-panel .dfy-section-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dfy-panel .dfy-section-title{font-size:16px!important;font-weight:650!important;margin:0!important}.dfy-panel .dfy-help{display:inline-flex;position:relative;align-items:center;vertical-align:middle;font-weight:400;line-height:1.4}.dfy-panel .dfy-help-button{display:inline-grid;place-items:center;width:27px;height:27px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dfy-muted);font-size:15px;line-height:1}.dfy-panel .dfy-help-button:hover,.dfy-panel .dfy-help-button:focus-visible{background:var(--dfy-soft);color:var(--dfy-ink)}.dfy-panel .dfy-help-content{position:fixed;z-index:2147483000;padding:11px 13px;border:1px solid var(--dfy-border);border-radius:9px;background:var(--dfy-surface);box-shadow:0 8px 26px #14233424;color:var(--dfy-ink);font-size:12px;line-height:1.65;white-space:normal;overflow:auto;max-height:240px;font-weight:400;overflow-wrap:anywhere}.dfy-panel .dfy-help-content[hidden],.dfy-panel .dfy-advanced-content[hidden]{display:none!important}.dfy-panel .dfy-advanced{border-top:1px solid var(--dfy-border);margin-top:16px;padding-top:10px}.dfy-panel .dfy-advanced>summary{cursor:pointer;color:var(--dfy-muted);font-size:12px;padding:5px 0;list-style:none;display:flex;gap:8px;align-items:center}.dfy-panel .dfy-advanced>summary::-webkit-details-marker{display:none}.dfy-panel .dfy-advanced>summary:before{content:'›';font-size:17px;line-height:1;transition:transform .15s}.dfy-panel .dfy-advanced[open]>summary:before{transform:rotate(90deg)}.dfy-panel .dfy-advanced-content{padding-top:12px}.dfy-panel .dfy-feature-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}.dfy-panel .dfy-feature-card{border:1px solid var(--dfy-border);border-radius:12px;padding:15px;background:var(--dfy-surface);min-width:0}.dfy-panel .dfy-feature-title{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.dfy-panel .dfy-feature-title strong{font-size:14px;font-weight:600}.dfy-panel .dfy-feature-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.dfy-panel .dfy-feature-card .dfy-advanced{margin-top:12px}.dfy-panel .dfy-feature-card .dfy-badge{font-size:11px;padding:3px 7px}.dfy-panel .dfy-home-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.dfy-panel .dfy-home-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dfy-panel .dfy-home-summary .dfy-card{padding:16px;margin:0}.dfy-panel .dfy-home-summary .dfy-card-note{margin-top:8px}.dfy-panel .dfy-home-status{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}.dfy-panel .dfy-home-status-title{font-size:20px;font-weight:650}.dfy-panel .dfy-footer{margin-top:14px}.dfy-panel .dfy-field>.dfy-titleline{margin-bottom:6px}.dfy-panel .dfy-help .dfy-hint{margin:0}.dfy-panel .dfy-status-head{margin-bottom:8px}
.dfy-panel .dfy-dependency-panel .dfy-resource-statuses{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;flex:0 1 auto;max-width:100%}.dfy-panel .dfy-dependency-panel .dfy-resource-status{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-height:28px;padding:4px 9px;border:1px solid var(--dfy-status-border,#cdd6e2);border-radius:999px;background:var(--dfy-status-bg,#f0f3f7);color:var(--dfy-status-ink,#526173);font-size:12px;font-weight:650;line-height:1.35;white-space:nowrap}.dfy-panel .dfy-dependency-panel .dfy-resource-status-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;font-size:13px;font-weight:700;line-height:1}.dfy-panel .dfy-dependency-panel .dfy-resource-status--ready{--dfy-status-ink:#17654b;--dfy-status-bg:#e9f6ef;--dfy-status-border:#b3dbc5}.dfy-panel .dfy-dependency-panel .dfy-resource-status--warning{--dfy-status-ink:#8a4c08;--dfy-status-bg:#fff4de;--dfy-status-border:#e9c997}.dfy-panel .dfy-dependency-panel .dfy-resource-status--danger{--dfy-status-ink:#a83232;--dfy-status-bg:#fff0ef;--dfy-status-border:#ebc0bd}.dfy-panel .dfy-dependency-panel .dfy-resource-status--info{--dfy-status-ink:#275f9e;--dfy-status-bg:#eaf3ff;--dfy-status-border:#b9d2f0}.dfy-panel .dfy-dependency-panel .dfy-dependency-job{display:flex;align-items:flex-start;gap:10px}.dfy-panel .dfy-dependency-panel .dfy-dependency-job-copy{min-width:0}.dfy-panel .dfy-dependency-panel .dfy-dependency-job-copy>p{margin:3px 0 0;overflow-wrap:anywhere}
@media(prefers-color-scheme:dark){.dfy-panel .dfy-dependency-panel .dfy-resource-status{--dfy-status-ink:#c0ccda;--dfy-status-bg:#2a3543;--dfy-status-border:#465568}.dfy-panel .dfy-dependency-panel .dfy-resource-status--ready{--dfy-status-ink:#9de3bc;--dfy-status-bg:#183b2c;--dfy-status-border:#35634a}.dfy-panel .dfy-dependency-panel .dfy-resource-status--warning{--dfy-status-ink:#f1cb87;--dfy-status-bg:#3d301d;--dfy-status-border:#6e542f}.dfy-panel .dfy-dependency-panel .dfy-resource-status--danger{--dfy-status-ink:#ffb4ae;--dfy-status-bg:#422728;--dfy-status-border:#744244}.dfy-panel .dfy-dependency-panel .dfy-resource-status--info{--dfy-status-ink:#a8d3ff;--dfy-status-bg:#20394f;--dfy-status-border:#3e6180}}
@media(max-width:640px){.dfy-panel{padding:12px}.dfy-panel .dfy-hero h2{font-size:18px}.dfy-panel .dfy-live{display:none}.dfy-panel .dfy-tabs{gap:0}.dfy-panel .dfy-tab{padding:10px 3px;font-size:12px}.dfy-panel .dfy-settings-nav{gap:3px;padding:7px}.dfy-panel .dfy-settings-tab{padding:7px 9px}.dfy-panel .dfy-feature-grid{grid-template-columns:1fr}.dfy-panel .dfy-home-summary{grid-template-columns:1fr}.dfy-panel .dfy-section{padding:15px}.dfy-panel .dfy-section-heading{gap:8px}.dfy-panel .dfy-home-status{align-items:flex-start}.dfy-panel .dfy-home-status-title{font-size:18px}.dfy-panel .dfy-help-button{width:30px;height:30px}.dfy-panel .dfy-feature-card{padding:14px}.dfy-panel .dfy-dependency-panel .dfy-resource-statuses{justify-content:flex-start}.dfy-panel .dfy-dependency-panel .dfy-dependency-job{flex-wrap:wrap}}
`;
    const navigationStyle = `
.dfy-panel .dfy-home-status-trigger{display:inline-flex;align-items:center;gap:6px;border:0;padding:0;background:transparent;font-family:inherit;text-align:left;cursor:pointer}.dfy-panel .dfy-home-status-trigger:hover{text-decoration:underline;text-underline-offset:4px}.dfy-panel .dfy-home-status-trigger:focus-visible{outline:3px solid var(--dfy-blue);outline-offset:5px;border-radius:3px}.dfy-panel .dfy-home-issue-details{margin-top:12px;padding-top:12px;border-top:1px solid var(--dfy-border)}.dfy-panel .dfy-home-issue{padding:10px 0;border-bottom:1px solid var(--dfy-border);overflow-wrap:anywhere}.dfy-panel .dfy-home-issue:first-child{padding-top:0}.dfy-panel .dfy-home-issue:last-of-type{border-bottom:0}.dfy-panel .dfy-home-issue p{margin:5px 0 0;font-size:12px;line-height:1.6}.dfy-panel .dfy-home-shortcuts{margin:0 0 16px}.dfy-panel .dfy-conversation-location[data-highlighted=true]{outline:2px solid var(--dfy-blue);outline-offset:3px;border-radius:var(--dfy-radius);scroll-margin-top:12px}
.dfy-panel .dfy-settings-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dfy-panel .dfy-settings-choices>.dfy-button{text-align:left;padding:16px}.dfy-panel [data-dirty=true]:after{content:'';display:inline-block;width:5px;height:5px;background:var(--dfy-blue);border-radius:50%;margin-left:5px;vertical-align:middle}
.dfy-panel .dfy-home-summary{margin-bottom:16px}.dfy-panel .dfy-feature-card{padding:13px}.dfy-panel .dfy-feature-actions{margin-top:8px}.dfy-panel .dfy-feature-card>.dfy-advanced{border:0;margin-top:7px;padding-top:0}.dfy-panel .dfy-feature-card>.dfy-advanced>summary{padding:2px 0;font-size:11px}
@media(max-width:400px){.dfy-panel .dfy-settings-choices{grid-template-columns:1fr}}
@media(min-width:440px) and (max-width:640px){.dfy-panel .dfy-feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
    let helpSerial = 0;
    function HelpTip({ label = '说明', children }) {
      const [open, setOpen] = useState(false);
      const [placement, setPlacement] = useState({ left: 16, top: 80, width: 280 });
      const anchor = useRef(null), container = useRef(null), id = useRef(null);
      const interaction = useRef({ focused: false, pinned: false, hovered: false, timer: null });
      if (!id.current) id.current = 'dfy-help-' + (++helpSerial);
      function cancelClose() { clearTimeout(interaction.current.timer); }
      function close() { cancelClose(); interaction.current.pinned = false; setOpen(false); }
      function show() {
        const rect = anchor.current?.getBoundingClientRect?.();
        const width = typeof window.innerWidth === 'number' ? Math.min(320, Math.max(180, window.innerWidth - 32)) : 280;
        if (rect) {
          const viewportWidth = window.innerWidth || 800, viewportHeight = window.innerHeight || 700;
          const left = Math.max(16, Math.min(rect.left, viewportWidth - width - 16));
          setPlacement({ left, width, ...(viewportHeight - rect.bottom < 180 && rect.top > 200
            ? { bottom: viewportHeight - rect.top + 7 } : { top: Math.max(8, rect.bottom + 7) }) });
        }
        setOpen(true);
      }
      function enter() { cancelClose(); interaction.current.hovered = true; show(); }
      function leave() {
        interaction.current.hovered = false; cancelClose();
        interaction.current.timer = setTimeout(() => {
          if (!interaction.current.focused && !interaction.current.pinned && !interaction.current.hovered) setOpen(false);
        }, 180);
      }
      useEffect(() => () => cancelClose(), []);
      useEffect(() => {
        if (!open) return;
        const dismiss = (event) => { if (!container.current?.contains?.(event.target)) close(); };
        const dismissWithEscape = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault?.(); event.stopPropagation?.(); close();
        };
        document.addEventListener?.('pointerdown', dismiss);
        document.addEventListener?.('keydown', dismissWithEscape, true);
        return () => {
          document.removeEventListener?.('pointerdown', dismiss);
          document.removeEventListener?.('keydown', dismissWithEscape, true);
        };
      }, [open]);
      return h('span', { ref: container, className: 'dfy-help', onMouseEnter: enter, onMouseLeave: leave,
        onBlur: (event) => { if (!event.currentTarget?.contains?.(event.relatedTarget)) { interaction.current.focused = false; close(); } } },
        h('button', { ref: anchor, type: 'button', className: 'dfy-help-button', 'aria-label': label + '说明',
          'aria-expanded': open, 'aria-describedby': open ? id.current : undefined,
          onFocus: () => { interaction.current.focused = true; show(); },
          onClick: () => { if (interaction.current.pinned) close(); else { interaction.current.pinned = true; show(); } },
          onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); close(); } } }, h('span', { 'aria-hidden': true }, 'ⓘ')),
        h('span', { id: id.current, role: 'tooltip', className: 'dfy-help-content', hidden: !open, style: placement,
          onMouseEnter: enter, onMouseLeave: leave }, children));
    }
    function Advanced({ title = '高级设置', children, initiallyOpen = false, className = '' }) {
      const [open, setOpen] = useState(initiallyOpen);
      return h('details', { className: 'dfy-advanced ' + className, open },
        h('summary', { onClick: (event) => { event?.preventDefault?.(); setOpen((value) => !value); }, 'aria-expanded': open }, title),
        h('div', { className: 'dfy-advanced-content', hidden: !open }, children));
    }
    function SectionHeading({ title, help, children }) {
      return h('div', { className: 'dfy-section-heading' },
        h('div', { className: 'dfy-titleline' }, h('h3', { className: 'dfy-section-title' }, title), help ? h(HelpTip, { label: title }, help) : null),
        children ? h('div', { className: 'dfy-section-actions' }, children) : null);
    }
    function baseValues(config) {
      return Object.fromEntries(Object.keys(defaults).map((key) => [key,
        config.overriddenFields?.includes(key) ? config.effective[key]
          : own(config.saved, key) ? config.saved[key] : own(config.effective, key) ? config.effective[key] : defaults[key]]));
    }
    function errorText(error, secret) {
      let message = String(error && error.message || '操作失败，请刷新状态后重试');
      if (secret) message = message.split(secret).join('［令牌已隐藏］');
      return message;
    }
    function qqStatus(runtime) {
      if (!runtime) return ['尚未读取', 'neutral'];
      if (runtime.identityConflict) return ['身份冲突', 'warn'];
      if (!runtime.enabled) return ['未启用', 'neutral'];
      if (!runtime.configured) return ['配置未完成', 'warn'];
      if (!runtime.connected) return ['未连接', 'warn'];
      if (!runtime.loginVerified) return ['登录待确认', 'warn'];
      if (runtime.online === true) return ['已验证在线', 'good'];
      return [runtime.online === false ? '当前离线' : '在线状态未知', 'warn'];
    }
    function phoneStatus(runtime) {
      if (!runtime || runtime.state === 'not-probed') return '尚未检查';
      if (runtime.state === 'disabled') return '未启用';
      if (runtime.state === 'online') return '已连接';
      if (runtime.state === 'offline') return ({ unauthorized: '设备待授权', authentication_failed: '设备认证失败',
        adb_missing: '缺少 ADB', adb_not_executable: 'ADB 无法执行', adb_server_unavailable: 'ADB 服务异常',
        device_permission_denied: '设备访问权限不足', address_unresolved: '设备地址无法解析', network_unreachable: '设备网络不可达',
        connection_refused: '连接端口拒绝', connect_timeout: '连接超时', check_timeout: '检测超时', device_not_found: '未找到配置设备' })[runtime.reasonCode] || '离线';
      return '需工具结果确认';
    }
    function voiceInputStatus(runtime) {
      if (!runtime) return '尚未读取';
      if (runtime.receiveEnabled !== true) return '未开启语音识别';
      if (runtime.configured !== true) return '识别服务未配置';
      return runtime.readiness === 'ready' ? '最近识别成功' : runtime.readiness === 'failed' ? '最近识别失败' : '尚未实际验证';
    }
    function displayTime(candidate) {
      if (!candidate) return '本次运行尚无记录';
      const date = new Date(candidate);
      return Number.isFinite(date.getTime()) ? date.toLocaleString() : '时间未确认';
    }
    const conversationNeedsInput = (item) => item?.state === 'failed' && !item.requiresUncertainAcknowledgement
      && ['unsupported_input', 'empty_input', 'image_unavailable', 'unsupported_message'].includes(item.failureType);
    const currentConversationIssues = (companion) => (Array.isArray(companion?.conversations) ? companion.conversations : [])
      .filter((item) => item && ['failed', 'blocked'].includes(item.state))
      .sort((left, right) => Number(conversationNeedsInput(left)) - Number(conversationNeedsInput(right))
        || (Date.parse(right.failedAt) || 0) - (Date.parse(left.failedAt) || 0));
    const unlocatedConversationIssue = (companion) => (!Array.isArray(companion?.conversations) || !companion.conversations.length)
      && Boolean(companion?.lastError || companion?.blocked);
    function companionStatus(companion, runtime) {
      if (runtime?.error) return ['启动失败', 'warn'];
      if (runtime?.applying) return ['正在更新设置', 'neutral'];
      if (runtime?.ready === false) return ['未启动', 'warn'];
      if (!companion) return ['尚未读取', 'neutral'];
      const issues = currentConversationIssues(companion);
      if (issues.some((item) => item.state === 'blocked')) return ['处理已受限', 'warn'];
      if (Number(companion.backgroundActive) > 0 && companion.foregroundActive === false) return ['后台执行中，可继续聊天', 'good'];
      if (companion.active === true || Number(companion.active) > 0) return ['正在处理', 'good'];
      if (Number(companion.pending) > 0) return ['等待处理', 'neutral'];
      if (issues.length) return issues.every(conversationNeedsInput)
        ? [issues.some(item => item.failureType === 'image_unavailable') ? '图片尚未处理' : issues.some(item => item.failureType === 'unsupported_message') ? '消息暂未处理' : '消息需要补充', 'neutral'] : ['最近处理异常', 'warn'];
      if (unlocatedConversationIssue(companion)) return ['处理记录待核对', 'warn'];
      const qq = runtime?.personalQQ;
      if (qq?.enabled === true && (qq.identityConflict || !qq.configured || !qq.connected || !qq.loginVerified || qq.online !== true)) return qqStatus(qq);
      if (companion.sessionCreated) return ['可以聊天', 'good'];
      return qq?.enabled === true && qq.connected && qq.loginVerified && qq.online === true ? ['等待用户消息', 'neutral']
        : qq?.enabled === false ? ['个人 QQ 未启用', 'neutral'] : ['伴侣已启动', 'neutral'];
    }
    function usePanelApi() {
      const alive = useRef(false);
      const requests = useRef(new Set());
      function cancel() { for (const controller of requests.current) controller.abort(); }
      useEffect(() => { alive.current = true; return () => { alive.current = false; cancel(); }; }, []);
      async function call(route, method, payload, timeoutMs = 20000, externalSignal) {
        const controller = new AbortController(), externalAbort = () => controller.abort();
        externalSignal?.addEventListener('abort', externalAbort, { once: true });
        if (externalSignal?.aborted) controller.abort();
        requests.current.add(controller);
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch('/dafeiyu-panel/api/' + route, {
            method: method || 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
            ...(method === 'POST' ? { body: JSON.stringify(payload || {}) } : {}),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok || !result || result.ok !== true) {
            const failure = new Error(typeof result?.error === 'string' ? result.error
              : result?.error?.message || result?.message || '服务暂不可用，请稍后重试');
            failure.code = result?.code || result?.error?.code || '';
            failure.result = result;
            throw failure;
          }
          return result;
        } finally { clearTimeout(timeout); externalSignal?.removeEventListener('abort', externalAbort); requests.current.delete(controller); }
      }
      return { alive, cancel, call };
    }
    const resourceError = (failure) => failure?.name === 'AbortError' ? '请求未得到确认，请重新读取状态。'
      : String(failure?.message || '读取失败，请重试');
    function selectionLabel(selection) {
      if (typeof selection === 'string') return selection || '尚未选择';
      if (!selection || typeof selection !== 'object') return '尚未选择';
      const provider = selection.provider || selection.providerId || '';
      const model = selection.modelId || selection.model || selection.id || '';
      return [provider, model].filter(Boolean).join(' / ') || '尚未选择';
    }
    const sameModelSelection = (left, right) => Boolean(left && right && left.provider === right.provider
      && (left.model || left.modelId) === (right.model || right.modelId));
    const speechPreparing = (speech) => speech?.job?.state === 'running' || speech?.providers?.some((provider) =>
      ['checking', 'downloading', 'loading', 'waking', 'cancelling', 'preparing'].includes(provider.preparation?.phase));
    function DesktopContextPanel({ active, controlBlocked = false, autoLoad = true }) {
      const api = usePanelApi();
      const [snapshot, setSnapshot] = useState(null), [selected, setSelected] = useState('');
      const [preview, setPreview] = useState(null), [acknowledged, setAcknowledged] = useState(false);
      const [busy, setBusy] = useState(''), [failure, setFailure] = useState(''), [notice, setNotice] = useState('');
      const lock = useRef(false), epoch = useRef(0), latest = useRef({});
      latest.current = { active, controlBlocked, snapshot, selected, preview, acknowledged };
      const current = (stamp) => api.alive.current && latest.current.active && epoch.current === stamp;
      const accept = (value) => {
        if (!value || !Array.isArray(value.sessions) || typeof value.revision !== 'string') throw new Error('会话状态未完整返回，请刷新核对。');
        setSnapshot(value); setPreview(null); setAcknowledged(false);
        setSelected((previous) => value.sessions.some(row => row.sessionId === previous) ? previous
          : value.sessions.find(row => row.paused === true)?.sessionId || value.sessions[0]?.sessionId || '');
      };
      async function refreshCapacity() {
        if (lock.current || !latest.current.active) return;
        const stamp = ++epoch.current; lock.current = true; setBusy('read'); setFailure(''); setPreview(null); setAcknowledged(false);
        try { const result = await api.call('desktop-context/status'); if (current(stamp)) accept(result.desktopContext); }
        catch (error) { if (current(stamp)) setFailure(resourceError(error)); }
        finally { if (epoch.current === stamp) { lock.current = false; if (api.alive.current) setBusy(''); } }
      }
      useEffect(() => {
        if (active && autoLoad) refreshCapacity();
        return () => { epoch.current++; api.cancel(); lock.current = false; setBusy(''); setPreview(null); setAcknowledged(false); };
      }, [active, autoLoad]);
      async function checkCapacity() {
        const value = latest.current, row = value.snapshot?.sessions.find(item => item.sessionId === value.selected);
        if (lock.current || !value.active || value.controlBlocked || !row || row.paused !== true || row.busy === true || !Number.isSafeInteger(row.seq)) return;
        const stamp = ++epoch.current; lock.current = true; setBusy('preview'); setFailure(''); setNotice(''); setPreview(null); setAcknowledged(false);
        try {
          const result = await api.call('desktop-context/preview', 'POST', { sessionId: row.sessionId, expectedSeq: row.seq, maxTokens: 8192 });
          if (current(stamp) && !latest.current.controlBlocked && latest.current.selected === row.sessionId) {
            const next = result.desktopContext;
            if (!next || next.sessionId !== row.sessionId || typeof next.previewId !== 'string' || next.allowed !== true
              || !Number.isSafeInteger(next.totalTokens) || !Number.isSafeInteger(next.limitTokens) || next.totalTokens > next.limitTokens)
              throw new Error('容量检查未通过，仍保持暂停。请刷新状态核对。');
            setPreview(next);
          }
        } catch (error) { if (current(stamp)) setFailure(resourceError(error)); }
        finally { if (epoch.current === stamp) { lock.current = false; if (api.alive.current) setBusy(''); } }
      }
      async function recoverCapacity() {
        const value = latest.current, row = value.snapshot?.sessions.find(item => item.sessionId === value.selected), checked = value.preview;
        if (lock.current || !value.active || value.controlBlocked || !value.acknowledged || !row || row.paused !== true || row.busy === true
          || checked?.sessionId !== row.sessionId || checked?.allowed !== true || !checked.previewId) return;
        const stamp = ++epoch.current; lock.current = true; setBusy('recover'); setFailure(''); setPreview(null); setAcknowledged(false);
        try {
          const result = await api.call('desktop-context/recover', 'POST', { sessionId: row.sessionId,
            previewId: checked.previewId, acknowledgeNoReplay: true });
          if (current(stamp)) {
            if (result.desktopContext?.recovered !== true || result.desktopContext?.automaticReplay !== false)
              throw new Error('恢复结果未确认，请刷新状态核对；不要重复提交。');
            setNotice('已设置本会话的回复上限，并恢复接收新请求。此前请求没有重跑。');
            setSnapshot((previous) => previous ? { ...previous, sessions: previous.sessions.map(item => item.sessionId === row.sessionId
              ? { ...item, paused: false, maxTokens: result.desktopContext.maxTokens } : item) } : previous);
          }
        } catch (error) { if (current(stamp)) setFailure(resourceError(error)); }
        finally { if (epoch.current === stamp) { lock.current = false; if (api.alive.current) setBusy(''); } }
      }
      const rows = snapshot?.sessions || [], row = rows.find(item => item.sessionId === selected);
      return h('section', { className: 'dfy-section', 'aria-label': '桌面聊天容量与恢复' },
        h(SectionHeading, { title: '桌面聊天容量', help: '只管理已授权的桌面聊天。先按较短回复上限检查完整请求容量，再明确恢复接收新请求；原请求不会自动重跑，也不会开启自主活动。' },
          h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked, onClick: refreshCapacity }, busy === 'read' ? '刷新中…' : '刷新容量状态')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        rows.length ? h('label', { className: 'dfy-field' }, '要处理的桌面聊天',
          h('select', { value: selected, disabled: Boolean(busy) || controlBlocked,
            onChange: event => { if (lock.current || latest.current.controlBlocked) return; setSelected(event.target.value); setPreview(null); setAcknowledged(false); setNotice(''); } },
          rows.map((item, index) => h('option', { key: item.sessionId, value: item.sessionId }, '桌面聊天 ' + (index + 1) + (item.paused ? ' · 已暂停' : ' · 可接收新请求')))))
          : h('p', { className: 'dfy-hint' }, snapshot ? '当前没有可管理的已授权桌面聊天。' : '点击刷新容量状态，查看已授权的桌面聊天。'),
        row ? h(React.Fragment, null,
          h('p', { className: 'dfy-meta' }, row.paused ? '已暂停，等待容量检查和本人确认。' : '当前可接收新请求。',
            row.maxTokens ? ' 本会话回复上限：' + row.maxTokens + ' Token。' : ''),
          h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked || row.paused !== true || row.busy === true,
            onClick: checkCapacity }, busy === 'preview' ? '检查容量中…' : '按短回复检查容量'),
          preview ? h('div', { className: 'dfy-notice', role: 'status' },
            h('p', null, '完整请求估算 ', preview.totalTokens.toLocaleString(), '，保护线 ', preview.limitTokens.toLocaleString(), '。回复上限将设为 ', String(preview.maxTokens || 8192), ' Token；容量保护仍生效。'),
            h('label', { className: 'dfy-check' }, h('input', { type: 'checkbox', checked: acknowledged, disabled: Boolean(busy) || controlBlocked,
              onChange: event => { if (!lock.current && !latest.current.controlBlocked) setAcknowledged(event.target.checked === true); } }), '我确认只接收新请求，不重跑此前请求'),
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked || !acknowledged,
              onClick: recoverCapacity }, busy === 'recover' ? '恢复中…' : '设置回复上限并恢复新请求')) : null) : null);
    }

    function ModelPanel({ active, onDirtyChange, canRebind, onRebound }) {
      const api = usePanelApi();
      const [model, setModel] = useState(null);
      const [selected, setSelected] = useState('');
      const [drafts, setDrafts] = useState({});
      const [revisions, setRevisions] = useState({});
      const [selectionDraft, setSelectionDraft] = useState(null);
      const [selectionExpected, setSelectionExpected] = useState(null);
      const [testModels, setTestModels] = useState({});
      const [busy, setBusy] = useState('');
      const [failure, setFailure] = useState(null);
      const [notice, setNotice] = useState('');
      const latest = useRef({ drafts: {}, revisions: {}, selected: '' });
      const lock = useRef(false);
      const fieldId = useRef('dfy-model-' + Math.random().toString(36).slice(2));
      const providerLabel = (item) => item?.provider === 'deepseek-account' ? 'DeepSeek（DSH账号）'
        : item?.provider === 'deepseek-official' ? 'DeepSeek（API Key）' : item?.name || item?.provider || '';
      const dirty = Object.values(drafts).some((patch) => Object.keys(patch).length > 0) || selectionDraft !== null;
      latest.current = { drafts, revisions, selected, selectionDraft, selectionExpected };
      useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
      useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
      function accept(result, savedProvider) {
        const next = result.model;
        if (!next || !Array.isArray(next.providers)) throw new Error('模型配置响应不完整');
        setModel(next);
        if (!latest.current.selectionDraft) setSelectionExpected(next.currentSelection || null);
        setSelected((previous) => next.providers.some((item) => item.provider === previous) ? previous
          : next.providers.find((item) => item.provider === next.currentSelection?.provider)?.provider || next.providers[0]?.provider || '');
        setRevisions((previous) => ({ ...previous, ...Object.fromEntries(next.providers.filter((item) =>
          item.provider === savedProvider || !Object.keys(latest.current.drafts[item.provider] || {}).length)
          .map((item) => [item.provider, item.revision])) }));
        if (savedProvider) setDrafts((previous) => ({ ...previous, [savedProvider]: {} }));
      }
      async function load() {
        if (lock.current) return;
        lock.current = true; setBusy('read'); setFailure(null);
        try {
          const result = await api.call('model/status');
          if (api.alive.current) { accept(result); setNotice(dirty ? '已读取最新设置，未保存的模型草稿已保留。' : ''); }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      useEffect(() => { if (active && !model) load(); }, [active]);
      const provider = model?.providers.find((item) => item.provider === selected);
      const accountBased = provider?.authenticationMode === 'account';
      const testModel = provider?.modelIds?.includes(testModels[selected]) ? testModels[selected]
        : model?.currentSelection?.provider === selected && provider?.modelIds?.includes(model.currentSelection.model) ? model.currentSelection.model
          : provider?.modelIds?.[0] || '';
      const initialProvider = model?.providers.find((item) => item.modelIds?.length);
      const targetSelection = selectionDraft || model?.currentSelection || {
        provider: initialProvider?.provider || model?.providers[0]?.provider || '', model: initialProvider?.modelIds?.[0] || '',
      };
      const targetProvider = model?.providers.find((item) => item.provider === targetSelection.provider);
      const selectionConflict = Boolean(selectionDraft && !equal(selectionExpected, model?.currentSelection || null));
      const patch = drafts[selected] || {};
      const conflict = Boolean(provider && Object.keys(patch).length && own(revisions, selected) && revisions[selected] !== provider.revision);
      const editable = model?.writable === true && provider?.editable === true;
      const testDisabledReason = busy ? ({ read: '正在读取模型设置，请等待完成后再测试。', save: '正在保存连接设置，请等待完成后再测试。',
        probe: '正在检查模型列表，请等待完成后再测试。', test: '模型测试正在执行，请等待原请求结束。', selection: '正在保存聊天模型，请等待完成后再测试。',
        rebind: '正在重新连接 QQ 对话，请等待完成后再测试。' })[busy] || '当前操作尚未完成，请稍后测试。'
        : Object.keys(patch).length ? '请先保存连接设置，再测试连接；测试使用已保存的地址和密钥。'
          : model?.connectionTest?.available === false ? '模型测试入口尚未就绪，请刷新状态后检查 DSH 服务。'
            : model?.connectionTest?.busy === true ? '上次模型测试仍在执行或收尾，请等待结束后刷新；不会重复发送。'
              : model?.connectionTest?.blocked === true ? '上次模型测试的执行或用量仍待核实，请先处理待核实记录；不会自动重试。'
                : model?.available === false ? 'DSH 模型服务尚未就绪，请先检查宿主模型设置。'
                  : provider?.registered === false ? '此服务商尚未在 DSH 启用，请先保存连接设置，再检查模型列表。'
                    : !provider ? '请先选择要测试的连接服务。'
                      : !testModel ? '尚无可用模型，请点击“检查模型列表”；API 服务需先保存连接设置。' : '';
      const inputValue = (name) => own(patch, name) ? patch[name] : provider?.[name] || '';
      function change(name, value) {
        setDrafts((previous) => {
          const next = { ...(previous[selected] || {}) };
          if (name === 'apiKey' ? value === '' : equal(value, provider?.[name] || '')) delete next[name]; else next[name] = value;
          return { ...previous, [selected]: next };
        });
        setFailure(null); setNotice('');
      }
      async function save() {
        if (lock.current || !editable || !Object.keys(patch).length || conflict) return;
        lock.current = true; setBusy('save'); setFailure(null); setNotice('');
        const providerId = selected;
        try {
          const result = await api.call('model/config', 'POST', { provider: providerId,
            revision: revisions[providerId], patch: latest.current.drafts[providerId] });
          if (api.alive.current) { accept(result, providerId); setNotice('连接设置已保存，后续请求会使用新设置。'); }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      async function probe() {
        if (lock.current || !provider || Object.keys(patch).length) return;
        lock.current = true; setBusy('probe'); setFailure(null); setNotice('');
        try {
          const result = await api.call('model/probe', 'POST', { provider: selected }, 65000);
          if (api.alive.current) {
            if (result.model) accept(result);
            else if (result.probe) setModel((previous) => ({ ...previous, providers: previous.providers.map((item) => item.provider === result.probe.provider
              ? { ...item, lastProbe: result.probe } : item) }));
            setNotice(result.probe?.ok
              ? '元数据检查已返回' + (Number.isFinite(result.probe.modelCount) ? '，共 ' + result.probe.modelCount + ' 个模型。' : '。')
                + (result.probe.note || '') : result.probe?.note || 'API 尚未通过检测，请核对设置。');
          }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      async function testActual() {
        if (lock.current || testDisabledReason || !provider || !testModel || Object.keys(patch).length) return;
        lock.current = true; setBusy('test'); setFailure(null); setNotice('');
        try {
          const result = await api.call('model/test', 'POST', { provider: selected, model: testModel });
          if (api.alive.current) {
            if (result.test) setModel((previous) => ({ ...previous, ...(result.connectionTest ? { connectionTest: result.connectionTest } : {}), providers: previous.providers.map((item) => item.provider === selected
              ? { ...item, lastTest: result.test } : item) }));
            setNotice(result.test?.ok ? '实际模型请求已通过。' + (result.test.note || '')
              : '实际模型请求未通过。' + (result.test?.note || '请核对模型、凭据与服务地址。'));
          }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      function changeSelection(next) {
        if (!selectionDraft) setSelectionExpected(model?.currentSelection || null);
        setSelectionDraft(sameModelSelection(next, model?.currentSelection) ? null : next); setFailure(null); setNotice('');
      }
      async function saveSelection() {
        if (lock.current || !model?.selectionEditable || !targetSelection.provider || !targetSelection.model || selectionConflict
          || Object.keys(drafts[targetSelection.provider] || {}).length) return;
        lock.current = true; setBusy('selection'); setFailure(null); setNotice('');
        try {
          const result = await api.call('model/selection', 'POST', { provider: targetSelection.provider, model: targetSelection.model,
            expectedSelection: selectionDraft ? selectionExpected : model.currentSelection || null });
          if (api.alive.current) {
            accept(result); setSelectionDraft(null); setSelectionExpected(result.model.currentSelection || null);
            setNotice('聊天模型已保存。新会话会使用此模型，已有 QQ 对话可到高级设置重新连接。');
          }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      async function rebind() {
        if (lock.current || !canRebind || dirty) return;
        lock.current = true; setBusy('rebind'); setFailure(null); setNotice('');
        try {
          await api.call('model/rebind', 'POST', {});
          if (api.alive.current) { onRebound?.(); setNotice('QQ 对话已重新连接，下条消息会使用所选模型。'); }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const modelField = (name, label, help, choices) => {
        const id = fieldId.current + '-' + name;
        const props = { id, value: inputValue(name), disabled: Boolean(busy) || !editable || provider?.editableFields?.[name] === false
          || name === 'apiKey' && provider?.credential?.writable !== true,
          onChange: (event) => change(name, event.target.value) };
        return h('div', { className: 'dfy-field', key: name },
          h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: id }, label),
            h(HelpTip, { label }, help)),
          choices ? h('select', props, choices.map((choice) => {
            const value = typeof choice === 'string' ? choice : choice.id || choice.value;
            return h('option', { key: value, value }, typeof choice === 'string' ? choice : choice.label || value);
          })) : h('input', { ...props, type: name === 'apiKey' ? 'password' : 'text', autoComplete: name === 'apiKey' ? 'new-password' : 'off',
            spellCheck: false, maxLength: name === 'apiKey' ? 8192 : 2048,
            placeholder: name === 'apiKey' ? provider?.editableFields?.apiKey === false || provider?.credential?.writable === false ? '由宿主管理 · 此处不修改'
              : provider?.credential?.known === false ? '凭据状态未确认 · 留空保留'
              : provider?.credential?.configured ? '已配置 · 可输入新密钥替换，留空保留' : '尚未配置 API Key' : '' }));
      };
      return h('section', { className: 'dfy-section' },
        h(SectionHeading, { title: '模型服务', help: '选择聊天使用的模型，并填写服务商提供的连接信息。更改默认模型用于新会话，已有 QQ 对话可在高级设置中重新连接。' },
          h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: load }, busy === 'read' ? '刷新中…' : '刷新目录')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' },
          failure.code === 'CONFLICT' ? '设置已被其他操作更新。模型草稿已保留，请刷新后核对。' : errorText(failure, patch.apiKey)) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        model ? h(React.Fragment, null,
          h('div', { className: 'dfy-readonly' }, h('span', null, '当前模型'), h('span', null, model.currentSelection
            ? providerLabel(model.providers.find(item => item.provider === model.currentSelection.provider) || { provider: model.currentSelection.provider }) + ' / ' + model.currentSelection.model : selectionLabel(null))),
          h('div', { className: 'dfy-grid', style: { marginTop: 14 } },
            h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', htmlFor: fieldId.current + '-default-provider' }, '聊天服务'),
              h('select', { id: fieldId.current + '-default-provider', value: targetSelection.provider, disabled: Boolean(busy) || !model.selectionEditable,
                onChange: (event) => {
                  const nextProvider = model.providers.find((item) => item.provider === event.target.value);
                  changeSelection({ provider: event.target.value, model: nextProvider?.modelIds?.[0] || '' });
                } }, model.providers.map((item) => h('option', { value: item.provider, key: item.provider }, providerLabel(item))))),
            h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', htmlFor: fieldId.current + '-default-model' }, '聊天模型'),
              h('select', { id: fieldId.current + '-default-model', value: targetSelection.model, disabled: Boolean(busy) || !model.selectionEditable || !targetProvider?.modelIds?.length,
                onChange: (event) => changeSelection({ provider: targetSelection.provider, model: event.target.value }) },
                targetProvider?.modelIds?.length ? targetProvider.modelIds.map((id) => h('option', { value: id, key: id }, id)) : h('option', { value: '' }, '该服务商暂无可选模型')))),
          selectionConflict ? h('div', { className: 'dfy-notice dfy-warning', style: { marginTop: 12 } },
            h('p', null, '默认模型已被其他操作改变，选择草稿已保留。请核对当前默认模型后再提交。'),
            h('button', { type: 'button', className: 'dfy-link-button', disabled: Boolean(busy), onClick: () => {
              setSelectionExpected(model.currentSelection || null); setFailure(null);
            } }, '采用最新默认值版本，保留选择')) : null,
          h('div', { className: 'dfy-toolbar', style: { justifyContent: 'flex-end' } },
            h('div', { className: 'dfy-inline-actions' },
              selectionDraft ? h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: () => {
                setSelectionDraft(null); setSelectionExpected(model.currentSelection || null); setFailure(null);
              } }, '放弃模型选择') : null,
              h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: Boolean(busy) || !model.selectionEditable || !targetSelection.model
                || selectionConflict || sameModelSelection(targetSelection, model.currentSelection) || Object.keys(drafts[targetSelection.provider] || {}).length,
                title: Object.keys(drafts[targetSelection.provider] || {}).length ? '请先保存该服务商的连接设置。' : '', onClick: saveSelection }, busy === 'selection' ? '保存中…' : '使用此模型'))),
          !model.available ? h('div', { className: 'dfy-notice dfy-warning' }, '模型服务暂时不可用，请先检查 DSH 中的模型设置。') : null,
          !model.providers.length ? h('div', { className: 'dfy-empty' }, '还没有可用的模型服务，请先在 DSH 的模型设置中添加。')
            : h(React.Fragment, null,
              h('div', { className: 'dfy-field', style: { marginTop: 14, marginBottom: 16 } },
                h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: fieldId.current + '-provider' }, '连接设置'),
                  h(HelpTip, { label: '连接设置' }, '选择要配置的服务商。连接信息由服务商提供，保存后可以测试是否可用。')),
                h('select', { id: fieldId.current + '-provider', value: selected, disabled: Boolean(busy), onChange: (event) => {
                  setSelected(event.target.value); setFailure(null); setNotice('');
                } }, model.providers.map((item) => h('option', { key: item.provider, value: item.provider },
                  providerLabel(item) + (Object.keys(drafts[item.provider] || {}).length ? ' · 有草稿' : '')))),
                h('p', { className: 'dfy-hint' }, '切换“连接设置”只编辑该服务的连接信息；点击“使用此模型”才会改变聊天模型。')),
              provider ? h(React.Fragment, null,
                h('div', { className: 'dfy-readonly' }, h('span', null, '连接测试'), h('span', null, provider.lastTest
                  ? provider.lastTest.ok ? '已通过' : '未通过' : '尚未测试')),
                provider.lastTest?.ok === false && provider.lastTest.note ? h('p', { className: 'dfy-field-error' }, provider.lastTest.note) : null,
                accountBased ? h(React.Fragment, null,
                  h('p', { className: 'dfy-hint' }, '此服务使用 DSH 账号登录，服务地址由账号服务提供，无需在此填写 API URL 或 API Key。请在 DSH 的“账号与余额”中登录或切换账号，登录状态以该页面为准。'),
                  h('p', { className: 'dfy-hint' }, '要使用自己的 API Key，请在“连接设置”中选择 API 服务商，例如 DeepSeek（API Key），再保存连接设置。'))
                  : editable ? h(React.Fragment, null,
                  modelField('baseURL', '服务地址（API URL）', '填写服务商提供的完整 API 基础地址。'),
                  h('div', { style: { marginTop: 16 } }, modelField('apiKey', 'API Key',
                    provider.credential?.writable === false ? '此服务的密钥由其他设置管理，这里不能修改。' : '留空保留已有密钥。已保存的密钥不会显示出来。')),
                  h('p', { className: 'dfy-hint' }, provider.editableFields?.apiKey === false || provider.credential?.writable === false
                    ? '此服务的 API Key 由 DSH 管理，本页暂不能替换；请在 DSH 的模型设置中调整。'
                    : '可输入新的 API Key 替换已保存密钥，留空保留当前密钥。保存前不会改变正在使用的连接。'))
                  : h('p', { className: 'dfy-hint' }, '此服务由 DSH 管理，请在 DSH 的模型设置中配置账号或连接。'),
                h('div', { className: 'dfy-field', style: { marginTop: 14 } },
                  h('label', { className: 'dfy-label', htmlFor: fieldId.current + '-test-model' }, '测试使用的模型'),
                  h('select', { id: fieldId.current + '-test-model', value: testModel, disabled: Boolean(busy) || !provider.modelIds?.length,
                    onChange: (event) => setTestModels((previous) => ({ ...previous, [selected]: event.target.value })) },
                    provider.modelIds?.length ? provider.modelIds.map((id) => h('option', { key: id, value: id }, id)) : h('option', { value: '' }, '配置并激活服务商后可选')),
                  h('p', { className: 'dfy-hint' }, testModel ? '测试会发送一条短请求，16 Token 是输出上限，实际总用量按用户任务记录，可能产生少量费用；不会发送 QQ 消息。'
                    : '先检查模型列表，再选择用于测试的模型。检查目录不会切换当前聊天模型。'),
                  h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || Object.keys(patch).length > 0 || model.connectionTest?.busy === true,
                    onClick: probe }, busy === 'probe' ? '检查中…' : '检查模型列表')),
                conflict ? h('div', { className: 'dfy-notice dfy-warning', style: { marginTop: 12 } },
                  h('p', null, '最新配置与草稿基于的版本不同，请核对地址和协议后再保存。'),
                  h('button', { className: 'dfy-link-button', type: 'button', disabled: Boolean(busy), onClick: () => {
                    setRevisions((previous) => ({ ...previous, [selected]: provider.revision })); setFailure(null); setNotice('已采用最新版本，模型草稿已保留。');
                  } }, '采用最新版本，保留草稿')) : null,
                h('div', { className: 'dfy-toolbar' }, h('span', { className: 'dfy-meta' },
                  Object.keys(patch).length ? '有未保存的连接设置' : ''),
                h('div', { className: 'dfy-inline-actions' },
                  h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(testDisabledReason),
                    title: testDisabledReason,
                    onClick: testActual }, busy === 'test' ? '测试中…' : '测试连接'),
                  Object.keys(patch).length ? h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: () => {
                    setDrafts((previous) => ({ ...previous, [selected]: {} })); setRevisions((previous) => ({ ...previous, [selected]: provider.revision })); setFailure(null); setNotice('已放弃该服务商的草稿。');
                  } }, '放弃模型草稿') : null,
                  h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: Boolean(busy) || !editable || !Object.keys(patch).length || conflict,
                    onClick: save }, busy === 'save' ? '保存中…' : '保存连接设置'))),
                testDisabledReason ? h('p', { className: 'dfy-hint', role: 'status' }, testDisabledReason) : null,
                h(Advanced, { title: '高级设置' },
                  !accountBased ? modelField('protocol', 'API 协议', '保持服务商推荐的协议；不确定时不要修改。', provider.protocolChoices?.length ? provider.protocolChoices
                    : [{ value: provider.protocol || '', label: provider.protocol || '由 DSH 管理' }]) : null,
                  !accountBased && !editable ? modelField('baseURL', 'API URL', '此服务的地址由 DSH 管理。') : null,
                  h('p', { className: 'dfy-hint' }, '可用模型：', provider.modelIds?.join('、') || '暂无模型列表'),
                  h('div', { className: 'dfy-readonly' }, h('span', null, '模型列表检查'), h('span', null, provider.lastProbe
                    ? (provider.lastProbe.ok ? '已返回列表' : '尚未确认') + ' · ' + displayTime(provider.lastProbe.checkedAt) : '尚未检查')),
                  provider.lastProbe?.note ? h('p', { className: 'dfy-hint' }, provider.lastProbe.note) : null,
                  provider.lastTest ? h('p', { className: 'dfy-hint' }, '上次测试：', provider.lastTest.model || '', ' · ', displayTime(provider.lastTest.checkedAt),
                    Number.isFinite(provider.lastTest.latencyMs) ? ' · ' + provider.lastTest.latencyMs + ' ms' : '', provider.lastTest.note ? ' · ' + provider.lastTest.note : '') : null,
                  h('p', { className: 'dfy-hint' }, '重新连接 QQ 后，下条消息会开始新会话并使用当前默认模型。请先保存所有修改，并等待任务结束。'),
                  h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || !canRebind || dirty,
                    onClick: rebind }, busy === 'rebind' ? '重新连接中…' : '重新连接 QQ 对话'))) : null))
          : !failure ? h('div', { className: 'dfy-empty' }, '正在读取宿主实际模型设置…') : null);
    }
    function SpeechInputPanel({ active, onDirtyChange }) {
      const api = usePanelApi();
      const [speech, setSpeech] = useState(null);
      const [sources, setSources] = useState({});
      const [selectionDraft, setSelectionDraft] = useState(null);
      const [selectionExpected, setSelectionExpected] = useState(null);
      const [busy, setBusy] = useState('');
      const [failure, setFailure] = useState('');
      const [notice, setNotice] = useState('');
      const [selectedAudio, setSelectedAudio] = useState(null);
      const [audioFailure, setAudioFailure] = useState('');
      const [transcription, setTranscription] = useState('');
      const audioSelection = useRef(null);
      const audioReader = useRef(null);
      const latestSpeech = useRef(null);
      const timer = useRef(null);
      const generation = useRef(0);
      const lock = useRef(false);
      const isActive = useRef(active);
      const latestSelection = useRef(null);
      isActive.current = active;
      latestSelection.current = selectionDraft;
      latestSpeech.current = speech;
      useEffect(() => { onDirtyChange?.(selectionDraft !== null); }, [selectionDraft, onDirtyChange]);
      useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
      function accept(result) {
        if (!result.model?.speech || !Array.isArray(result.model.speech.providers)) throw new Error('语音识别状态响应不完整');
        const next = result.model.speech;
        setSpeech(next);
        if (!latestSelection.current) setSelectionExpected(next.selection || null);
        clearTimeout(timer.current);
        if (isActive.current && speechPreparing(next)) timer.current = setTimeout(() => load(true), 2000);
      }
      async function load(poll = false) {
        if (lock.current) return;
        const current = generation.current;
        lock.current = true;
        if (!poll) { setBusy('read'); setFailure(''); }
        try {
          const result = await api.call('model/status');
          if (api.alive.current && current === generation.current) accept(result);
        } catch (error) { if (api.alive.current && current === generation.current) setFailure(resourceError(error)); }
        finally { lock.current = false; if (api.alive.current && current === generation.current && !poll) setBusy(''); }
      }
      useEffect(() => {
        if (active) load();
        else { audioSelection.current = null; setSelectedAudio(null); setTranscription(''); setAudioFailure(''); }
        return () => { generation.current++; clearTimeout(timer.current); audioReader.current?.abort(); audioReader.current = null;
          api.cancel(); lock.current = false; setBusy(''); };
      }, [active]);
      async function prepare(provider) {
        if (lock.current || speechPreparing(speech)) return;
        clearTimeout(timer.current); lock.current = true; setBusy(provider.id); setFailure('');
        try {
          const result = await api.call('speech/prepare', 'POST', { providerId: provider.id,
            ...(sources[provider.id] ? { downloadSource: sources[provider.id] } : {}) });
          if (api.alive.current) accept(result);
        } catch (error) { if (api.alive.current) setFailure(resourceError(error)); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const targetSelection = selectionDraft || speech?.selection || {
        providerId: speech?.providers[0]?.id || '', language: speech?.providers[0]?.languages?.[0] || '',
      };
      const targetProvider = speech?.providers.find((item) => item.id === targetSelection.providerId);
      const selectionConflict = Boolean(selectionDraft && !equal(selectionExpected, speech?.selection || null));
      function changeSelection(next) {
        if (!selectionDraft) setSelectionExpected(speech?.selection || null);
        const changed = equal(next, speech?.selection || null) ? null : next;
        latestSelection.current = changed; setSelectionDraft(changed); setFailure(''); setNotice(''); setTranscription('');
      }
      function chooseAudio(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (lock.current || !api.alive.current || !isActive.current) return;
        audioSelection.current = null; setSelectedAudio(null); setAudioFailure(''); setTranscription('');
        if (!file) return;
        if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
          setAudioFailure('请选择大于 0 且不超过 5 MB 的音频文件。'); return;
        }
        const extension = String(file.name || '').split('.').pop().toLowerCase();
        const fallbackMime = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac' }[extension];
        const mime = String(file.type || '').toLowerCase().split(';')[0];
        if (mime && !mime.startsWith('audio/') || !mime && !fallbackMime) {
          setAudioFailure('请选择音频文件，例如 MP3、WAV 或 M4A。'); return;
        }
        const current = generation.current;
        const reader = new FileReader(); audioReader.current = reader;
        lock.current = true; setBusy('audio-read');
        const finish = () => { if (audioReader.current !== reader) return; audioReader.current = null; lock.current = false;
          if (api.alive.current && current === generation.current) setBusy(''); };
        reader.onload = () => {
          if (api.alive.current && isActive.current && current === generation.current && audioReader.current === reader) {
            const base64 = typeof reader.result === 'string' ? reader.result.split(',')[1] : '';
            if (!base64 || base64.length > 4 * Math.ceil(5 * 1024 * 1024 / 3) || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
              setAudioFailure('无法读取这个音频文件，请重新选择。');
            } else {
              const selected = { fileName: String(file.name || '测试音频').slice(0, 200), audio: { mime: mime || fallbackMime, base64 } };
              audioSelection.current = selected; setSelectedAudio(selected);
            }
          }
          finish();
        };
        reader.onerror = () => { if (api.alive.current && current === generation.current) setAudioFailure('音频文件读取失败，请重新选择。'); finish(); };
        reader.onabort = finish;
        try { reader.readAsDataURL(file); } catch { setAudioFailure('音频文件读取失败，请重新选择。'); finish(); }
      }
      async function testAudio() {
        const currentSpeech = latestSpeech.current;
        const provider = currentSpeech?.providers?.find((item) => item.id === currentSpeech.selection?.providerId);
        const selected = audioSelection.current;
        if (lock.current || !isActive.current || !selected || latestSelection.current || currentSpeech?.available !== true
          || !['ready', 'standby'].includes(provider?.preparation?.phase) || speechPreparing(currentSpeech)) return;
        const current = generation.current;
        clearTimeout(timer.current); lock.current = true; setBusy('audio-test'); setAudioFailure(''); setTranscription('');
        try {
          const result = await api.call('speech/test', 'POST', selected, 180000);
          if (api.alive.current && isActive.current && current === generation.current) {
            if (result.speech) accept({ model: { speech: result.speech } });
            if (result.test?.ok !== true || typeof result.test.text !== 'string' || !result.test.text.trim()) throw new Error(result.test?.note || '没有识别出文字，请换一段清晰人声再试。');
            setTranscription(result.test.text);
          }
        } catch (error) { if (api.alive.current && current === generation.current) setAudioFailure(resourceError(error)); }
        finally { if (current === generation.current) { lock.current = false; if (api.alive.current) setBusy(''); } }
      }
      async function select() {
        if (lock.current || !speech?.selectionEditable || !targetSelection.providerId || !targetSelection.language || selectionConflict) return;
        clearTimeout(timer.current); lock.current = true; setBusy('selection'); setFailure(''); setNotice('');
        try {
          const result = await api.call('speech/selection', 'POST', { ...targetSelection,
            expectedSelection: selectionDraft ? selectionExpected : speech.selection || null });
          if (api.alive.current) {
            accept(result); setSelectionDraft(null); setSelectionExpected(result.model.speech.selection || null);
            setNotice('识别服务与语言已保存，后续转写使用该选择。资源是否就绪请查看下方状态。');
          }
        } catch (error) { if (api.alive.current) setFailure(resourceError(error)); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const phases = { unprepared: '需要准备', checking: '检查中', downloading: '下载中', loading: '启动中',
        waking: '启动中', ready: '已准备', standby: '已准备', failed: '准备失败', cancelled: '已取消',
        cancelling: '正在取消', preparing: '正在准备', idle: '尚未准备', missing: '缺少资源', unavailable: '不可用', 'not-prepared': '尚未准备' };
      const languages = { auto: '自动识别', zh: '中文', en: '英语', yue: '粤语', ja: '日语', ko: '韩语',
        fr: '法语', de: '德语', es: '西班牙语', ru: '俄语' };
      return h('section', { className: 'dfy-section' },
        h(SectionHeading, { title: '识别设置', help: '选择把语音转换成文字的服务。这里检查的是识别服务，不会录音或读取聊天消息。' },
          h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy), onClick: () => load() }, busy === 'read' ? '检查中…' : '检查')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        speech ? h(React.Fragment, null,
          !speech.available ? h('div', { className: 'dfy-notice dfy-warning' }, '尚未开启语音识别，请先在 DSH 语音设置中启用识别服务。') : null,
          h('div', { className: 'dfy-readonly' }, h('span', null, '当前服务'), h('span', null,
            speech.providers.find((item) => item.id === speech.selection?.providerId)?.name || (speech.selection ? '已选择' : '尚未选择'))),
          h('div', { className: 'dfy-grid', style: { marginTop: 14 } },
            h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', style: { display: 'block' } }, '识别服务',
              h('select', { value: targetSelection.providerId, disabled: Boolean(busy) || speech.selectionEditable !== true,
                style: { marginTop: 6 },
                onChange: (event) => {
                  const provider = speech.providers.find((item) => item.id === event.target.value);
                  changeSelection({ providerId: event.target.value, language: provider?.languages?.[0] || '' });
                } }, speech.providers.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.name || provider.id))))),
            h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', style: { display: 'block' } }, '识别语言',
              h('select', { value: targetSelection.language, disabled: Boolean(busy) || speech.selectionEditable !== true || !targetProvider?.languages?.length,
                style: { marginTop: 6 },
                onChange: (event) => changeSelection({ providerId: targetSelection.providerId, language: event.target.value }) },
                targetProvider?.languages?.length ? targetProvider.languages.map((language) => h('option', { key: language, value: language }, languages[language] || language))
                  : h('option', { value: '' }, '暂无可选语言'))))),
          selectionConflict ? h('div', { className: 'dfy-notice dfy-warning', style: { marginTop: 12 } },
            h('p', null, '识别服务已被其他操作修改，请核对当前选择。'),
            h('button', { type: 'button', className: 'dfy-link-button', disabled: Boolean(busy), onClick: () => {
              setSelectionExpected(speech.selection || null); setFailure('');
            } }, '采用最新版本，保留识别选择')) : null,
          h('div', { className: 'dfy-inline-actions', style: { marginTop: 12 } },
            selectionDraft ? h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy), onClick: () => {
              setSelectionDraft(null); setSelectionExpected(speech.selection || null); setFailure('');
            } }, '放弃识别选择') : null,
            h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy) || speech.selectionEditable !== true || selectionConflict
              || !targetSelection.language || equal(targetSelection, speech.selection), onClick: select }, busy === 'selection' ? '保存选择中…' : '使用此识别服务')),
          targetProvider ? h('div', { className: 'dfy-resource' },
            h('div', { className: 'dfy-resource-heading' }, h('strong', null, targetProvider.name || '语音识别'),
              h('span', { className: 'dfy-badge' }, phases[targetProvider.preparation?.phase] || '待检查')),
            !['ready', 'standby'].includes(targetProvider.preparation?.phase) ? h(React.Fragment, null,
              targetProvider.preparation?.error ? h('p', { className: 'dfy-field-error' }, targetProvider.preparation.error) : null,
              h('p', { className: 'dfy-hint' }, speech.canPrepare === true ? '准备完成后，才能识别收到的语音。' : '请先在 DSH 中准备此服务的资源，然后重新检查。'),
              h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy) || speech.canPrepare !== true || speechPreparing(speech),
                onClick: () => prepare(targetProvider) }, busy === targetProvider.id || speechPreparing(speech) ? '准备中…' : '下载并准备资源')) : null,
            Number.isFinite(targetProvider.preparation?.totalBytes) && targetProvider.preparation.totalBytes > 0
              && speechPreparing({ providers: [targetProvider] }) ? h('p', { className: 'dfy-hint', role: 'status' }, '下载进度：',
              Math.min(100, Math.max(0, Math.round((targetProvider.preparation.completedBytes || 0) / targetProvider.preparation.totalBytes * 100))), '%') : null) : null,
          speech.job ? h('div', { className: 'dfy-notice' + (speech.job.state === 'failed' ? ' dfy-error' : ''), role: 'status', style: { marginTop: 12 } },
            speech.job.state === 'running' ? '正在准备识别资源：' : speech.job.state === 'completed' ? '识别资源准备完成：' : '识别资源准备失败：',
            speech.providers.find((item) => item.id === speech.job.providerId)?.name || '语音识别', speech.job.error ? ' · ' + speech.job.error : '') : null,
          !speech.job && speechPreparing(speech) ? h('p', { className: 'dfy-hint', role: 'status', style: { marginTop: 12 } }, '识别资源正在准备，进度会自动更新。') : null,
          h('div', { className: 'dfy-resource', 'aria-label': '音频识别测试' },
            h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label' }, '选择音频测试识别',
              h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm,.flac', disabled: Boolean(busy),
                'aria-label': '选择音频测试识别', onChange: chooseAudio, style: { display: 'block', marginTop: 8, maxWidth: '100%' } })),
              h(HelpTip, { label: '音频识别测试' }, '手动选择不超过 5 MB 的短音频，再点击开始。测试只把音频交给当前识别服务，不录麦克风，不发 QQ，也不加入聊天上下文。')),
            selectedAudio ? h('p', { className: 'dfy-hint' }, '已选择：', selectedAudio.fileName) : null,
            h('p', { className: 'dfy-hint' }, '点击测试后，音频将交给当前识别服务处理。'),
            selectionDraft ? h('p', { className: 'dfy-hint' }, '请先保存识别服务选择，再测试音频。') : null,
            audioFailure ? h('p', { className: 'dfy-field-error', role: 'alert' }, audioFailure) : null,
            h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy) || !selectedAudio || Boolean(selectionDraft) || speech.available !== true
              || !['ready', 'standby'].includes(targetProvider?.preparation?.phase) || speechPreparing(speech), onClick: testAudio },
              busy === 'audio-read' ? '读取音频中…' : busy === 'audio-test' ? '正在识别…' : '开始识别测试'),
            transcription ? h('div', { className: 'dfy-notice', role: 'status', style: { whiteSpace: 'pre-wrap' } },
              h('strong', null, '识别结果'), h('p', null, transcription)) : null),
          speech.providers.length ? h(Advanced, { title: '高级设置' },
            h('p', { className: 'dfy-hint' }, '识别接口：', speech.available ? '已注册' : '未注册'),
            speech.providers.map((provider) => h('article', { className: 'dfy-resource', key: provider.id },
            h('div', { className: 'dfy-resource-heading' }, h('h4', { className: 'dfy-resource-name', style: { margin: 0 } }, provider.name || provider.id),
              h('span', { className: 'dfy-badge' }, phases[provider.preparation?.phase] || provider.preparation?.phase || '资源状态未确认')),
            h('p', { className: 'dfy-hint' }, '支持语言：', provider.languages?.join('、') || '由服务商决定'),
            Number.isFinite(provider.preparation?.totalBytes) && provider.preparation.totalBytes > 0 ? h('p', { className: 'dfy-hint' },
              '下载进度：', Math.min(100, Math.max(0, Math.round((provider.preparation.completedBytes || 0) / provider.preparation.totalBytes * 100))), '%') : null,
            h('div', { className: 'dfy-inline-actions', style: { marginTop: 10 } },
              provider.downloadSources?.length ? h('select', { className: 'dfy-button', 'aria-label': (provider.name || provider.id) + ' 下载来源',
                value: sources[provider.id] || '', disabled: Boolean(busy) || speechPreparing(speech),
                onChange: (event) => setSources((previous) => ({ ...previous, [provider.id]: event.target.value })) },
                h('option', { value: '' }, '默认下载来源'), provider.downloadSources.map((source) => h('option', { key: source, value: source }, source))) : null,
              h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy) || speech.canPrepare !== true || speechPreparing(speech),
                onClick: () => prepare(provider) }, busy === provider.id ? '提交中…'
                  : ['ready', 'standby'].includes(provider.preparation?.phase) ? '检查 / 重新准备资源'
                    : speechPreparing({ providers: [provider] }) ? '准备中…' : '下载并准备资源')))))
            : h('p', { className: 'dfy-hint', style: { marginTop: 12 } }, '当前没有已注册的语音识别服务商。请在 DSH 语音设置中启用识别服务。'))
          : !failure ? h('div', { className: 'dfy-empty' }, '正在读取语音识别服务…') : null);
    }
    function VoiceOutputPanel({ active, refreshKey, onDirtyChange, onSaved }) {
      const api = usePanelApi();
      const savedNotice = '语音发送配置已保存，点击下方“生效”后接入当前运行。';
      const [voice, setVoice] = useState(null);
      const [base, setBase] = useState({});
      const [draft, setDraft] = useState({});
      const [revision, setRevision] = useState('');
      const [key, setKey] = useState('');
      const [clearKey, setClearKey] = useState(false);
      const [busy, setBusy] = useState('');
      const [failure, setFailure] = useState(null);
      const [notice, setNotice] = useState('');
      const [preview, setPreview] = useState(null);
      const audioPlayer = useRef(null);
      const isActive = useRef(active);
      const previewGeneration = useRef(0);
      const lock = useRef(false);
      const latest = useRef({});
      const fieldId = useRef('dfy-tts-' + Math.random().toString(36).slice(2));
      const dirty = Object.keys(draft).length > 0 || key !== '' || clearKey;
      isActive.current = active;
      latest.current = { dirty, draft, revision, key, clearKey, voice };
      useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
      useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
      useEffect(() => { if (!active) { previewGeneration.current++; audioPlayer.current?.pause?.(); } }, [active]);
      useEffect(() => () => { previewGeneration.current++; audioPlayer.current?.pause?.(); }, []);
      function accept(result, reset = false) {
        const next = result.voice;
        if (!next?.config || typeof next.config.revision !== 'string') throw new Error('语音发送配置响应不完整');
        setVoice(next);
        if (reset || !latest.current.dirty) {
          setBase(next.config.saved || {}); setRevision(next.config.revision);
          if (reset) { setDraft({}); setKey(''); setClearKey(false); }
        }
      }
      async function load({ preserveFailure = false } = {}) {
        if (lock.current) return;
        lock.current = true; setBusy('read'); if (!preserveFailure) setFailure(null);
        try { const result = await api.call('voice/status'); if (api.alive.current) accept(result); }
        catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      useEffect(() => { if (active) load({ preserveFailure: true }); }, [active, refreshKey]);
      const conflict = Boolean(dirty && voice?.config.revision && revision !== voice.config.revision);
      const managed = (name) => voice?.config.overriddenFields?.includes(name) === true;
      const value = (name) => managed(name) ? voice.config.effective?.[name] : own(draft, name) ? draft[name] : base[name];
      function change(name, candidate) {
        if (managed(name)) return;
        if (name !== 'ttsAutoVoice') { audioPlayer.current?.pause?.(); setPreview(null); }
        setDraft((previous) => {
          const next = { ...previous };
          if (equal(candidate, base[name])) delete next[name]; else next[name] = candidate;
          latest.current.draft = next;
          latest.current.dirty = Object.keys(next).length > 0 || latest.current.key !== '' || latest.current.clearKey;
          return next;
        });
        setFailure(null); setNotice('');
      }
      async function save() {
        if (lock.current || !dirty || !revision || conflict) return;
        lock.current = true; setBusy('save'); setFailure(null); setNotice('');
        try {
          const current = latest.current;
          const result = await api.call('voice/config', 'POST', { revision: current.revision,
            patch: { ...current.draft, ...(current.key && !current.clearKey ? { ttsApiKey: current.key } : {}) },
            ...(current.clearKey ? { clearSecrets: ['ttsApiKey'] } : {}) });
          if (api.alive.current) { accept(result, true); setNotice(savedNotice); onSaved?.(); }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const voices = Array.isArray(voice?.voices) ? voice.voices.filter((item) => typeof item?.id === 'string' && typeof item?.name === 'string') : [];
      const selectedVoiceId = own(draft, 'ttsVoice') ? draft.ttsVoice : voice?.defaultVoiceId || value('ttsVoice') || '';
      const selectedVoice = voices.find((item) => item.id === selectedVoiceId);
      const connectionDirty = Object.keys(draft).some((name) => !['ttsVoice', 'ttsAutoVoice'].includes(name)) || key !== '' || clearKey;
      let localService = value('ttsProvider') === 'macos';
      try { localService ||= ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value('ttsBaseURL')).hostname); } catch {}
      async function check() {
        const current = latest.current;
        const changedConnection = Object.keys(current.draft).some((name) => !['ttsVoice', 'ttsAutoVoice'].includes(name)) || current.key !== '' || current.clearKey;
        const id = own(current.draft, 'ttsVoice') ? current.draft.ttsVoice : current.voice?.defaultVoiceId || current.voice?.config?.saved?.ttsVoice || '';
        const chosen = current.voice?.voices?.find((item) => item.id === id);
        if (lock.current || !api.alive.current || !isActive.current || changedConnection || current.voice?.pendingReload || current.voice?.runtime?.configured !== true || !chosen || chosen.available === false) return;
        lock.current = true; setBusy('check'); setFailure(null); setNotice('');
        audioPlayer.current?.pause?.(); setPreview(null);
        const previewed = { id: chosen.id, name: chosen.name };
        const currentPreview = previewGeneration.current;
        try {
          const result = await api.call('voice/test', 'POST', { voiceId: previewed.id }, 150000);
          if (api.alive.current && isActive.current && currentPreview === previewGeneration.current) {
            if (result.voice) accept(result);
            const test = result.test, audio = test?.audio;
            if (test?.ok !== true || test.generated !== true) throw new Error(test?.note || '试听未完成，请核对声音服务。');
            if (test.delivered !== false || test.voiceId !== previewed.id || audio?.mime !== 'audio/mpeg'
              || typeof audio.base64 !== 'string' || !audio.base64.length || audio.base64.length > 7 * 1024 * 1024
              || audio.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.base64)) throw new Error('试听没有返回有效的声音文件，请检查服务后重试。');
            setPreview({ src: 'data:audio/mpeg;base64,' + audio.base64, name: previewed.name });
            setNotice('声音已生成，点击下方播放按钮试听。');
          }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const input = (name, label, help, choices) => {
        const id = fieldId.current + '-' + name;
        const props = { id, disabled: Boolean(busy) || managed(name), value: value(name) ?? '', onChange: (event) => change(name, event.target.value) };
        return h('div', { className: 'dfy-field', key: name },
          h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: id }, label), h(HelpTip, { label }, help)),
          choices ? h('select', props, choices.map(([candidate, text]) => h('option', { key: candidate, value: candidate }, text)))
            : h('input', { ...props, type: 'text', autoComplete: 'off', spellCheck: false, maxLength: 2048 }));
      };
      const readiness = { 'not-verified': '待测试', 'synthesis-verified': '声音已准备，发送待确认', ready: '已确认可发送', failed: '需要处理', missing: '尚未准备好' };
      const displayedNotice = notice === savedNotice && voice?.pendingReload === false ? '声音设置已生效。' : notice;
      return h('section', { className: 'dfy-section' },
        h(SectionHeading, { title: '语音回复', help: '选择大肥鱼回复时使用的声音。只有已授权的聊天和实际工具调用才会生成语音；保存设置不会自动发消息。' },
          h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy), onClick: load }, busy === 'read' ? '检查中…' : '检查')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure.code === 'CONFLICT'
          ? '连接配置已被修改。语音草稿已保留，请读取最新状态后核对。' : errorText(failure, key)) : null,
        displayedNotice ? h('div', { className: 'dfy-notice', role: 'status' }, displayedNotice) : null,
        voice ? h(React.Fragment, null,
          h('div', { className: 'dfy-readonly' }, h('span', null, '当前状态'), h('strong', null,
            !voice.runtime?.enabled ? '未开启' : !voice.runtime?.configured ? '需要配置' : readiness[voice.runtime?.readiness] || '待检查')),
          voice.pendingReload ? h('p', { className: 'dfy-notice dfy-warning', role: 'status' }, '声音设置已保存，尚未生效。请点击下方“生效”。') : null,
          voice.runtime?.lastResult && voice.runtime?.readiness === 'failed' ? h('p', { className: 'dfy-field-error' }, '上次未成功：', typeof voice.runtime.lastResult === 'string' ? voice.runtime.lastResult
            : [voice.runtime.lastResult.ok === true ? '成功' : voice.runtime.lastResult.ok === false ? '失败' : '', voice.runtime.lastResult.note || voice.runtime.lastResult.message,
              voice.runtime.lastResult.at ? displayTime(voice.runtime.lastResult.at) : ''].filter(Boolean).join(' · ')) : null,
          h('label', { className: 'dfy-toggle', htmlFor: fieldId.current + '-enabled' },
            h('span', { className: 'dfy-toggle-copy' }, h('span', { className: 'dfy-toggle-title' }, '用语音回复')),
            h('input', { id: fieldId.current + '-enabled', type: 'checkbox', checked: value('voiceReplyEnabled') === true,
              disabled: Boolean(busy) || managed('voiceReplyEnabled'), onChange: (event) => change('voiceReplyEnabled', event.target.checked) })),
          h('div', { className: 'dfy-field', style: { marginTop: 16 } },
            h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: fieldId.current + '-default-voice' }, '默认音色'),
              h(HelpTip, { label: '默认音色' }, '手动选择大肥鱼平时使用的声音。试听不会保存选择，保存后才更新默认音色。')),
            h('select', { id: fieldId.current + '-default-voice', value: selectedVoiceId,
              disabled: Boolean(busy) || managed('ttsVoice') || !voices.length, onChange: (event) => change('ttsVoice', event.target.value) },
              !selectedVoice ? h('option', { value: selectedVoiceId }, voices.length ? '当前自定义声音' : '暂无可选音色') : null,
              voices.map((item) => h('option', { key: item.id, value: item.id }, item.name + (item.available === false ? '（暂不可用）' : '')))),
            selectedVoice?.description ? h('p', { className: 'dfy-hint' }, selectedVoice.description) : null,
            selectedVoice?.available === false ? h('p', { className: 'dfy-field-error' }, '这个声音暂不可用，请选择其他音色或检查声音服务。') : null,
            !voices.length ? h('p', { className: 'dfy-hint' }, '检查声音服务后，才能选择和试听音色。') : null),
          h('div', { className: 'dfy-toggle' },
            h('div', { className: 'dfy-toggle-copy dfy-titleline' }, h('label', { className: 'dfy-toggle-title', htmlFor: fieldId.current + '-auto-voice' }, '允许大肥鱼自己选音色'),
              h(HelpTip, { label: '自动选音色' }, '开启后，大肥鱼可以从可用音色中为当前这条语音选声音；不会改掉你设置的默认音色或其他对话的选择。')),
            h('input', { id: fieldId.current + '-auto-voice', type: 'checkbox', checked: value('ttsAutoVoice') === true,
              disabled: Boolean(busy) || managed('ttsAutoVoice'), onChange: (event) => change('ttsAutoVoice', event.target.checked) })),
          clearKey ? h('p', { className: 'dfy-field-error' }, '保存后会清除已保存的语音密钥。') : null,
          conflict ? h('div', { className: 'dfy-notice dfy-warning', style: { marginTop: 12 } },
            h('p', null, '最新连接配置已变化，语音草稿已保留。'),
            h('button', { type: 'button', className: 'dfy-link-button', disabled: Boolean(busy), onClick: () => {
              setBase(voice.config.saved || {}); setRevision(voice.config.revision); setFailure(null); setNotice('已采用最新版本，请核对语音草稿后保存。');
            } }, '采用最新版本，保留语音草稿')) : null,
          h('div', { className: 'dfy-toolbar' }, h('span', { className: 'dfy-meta' }, dirty ? '有未保存的声音设置' : ''),
            h('div', { className: 'dfy-inline-actions' },
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || connectionDirty || voice.pendingReload || voice.runtime?.configured !== true || !selectedVoice || selectedVoice.available === false,
              onClick: check }, busy === 'check' ? '生成试听中…' : '试听这个声音'),
            dirty ? h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: () => {
              setBase(voice.config.saved || {}); setRevision(voice.config.revision); setDraft({}); setKey(''); setClearKey(false); setFailure(null);
            } }, '放弃语音草稿') : null,
            h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: Boolean(busy) || !dirty || conflict, onClick: save }, busy === 'save' ? '保存中…' : '保存声音设置'))),
          h('p', { className: 'dfy-hint' }, localService ? '试听只在本页播放，不会发到 QQ。' : '试听会调用在线声音服务，可能产生费用；不会发到 QQ。'),
          connectionDirty ? h('p', { className: 'dfy-hint' }, '声音服务设置有修改，请先保存后试听。') : null,
          preview ? h('div', { className: 'dfy-resource', 'aria-label': '音色试听' }, h('p', { className: 'dfy-label' }, preview.name, ' · 试听'),
            h('audio', { ref: audioPlayer, controls: true, preload: 'none', src: preview.src, 'aria-label': preview.name + '试听音频', style: { width: '100%', marginTop: 8 } })) : null,
          h(Advanced, { title: '高级设置' },
            input('ttsProvider', '声音来源', '本机声音无需在线密钥；语音服务可以是本机运行的 MLX，也可以是兼容的在线服务。', [['openai-compatible', '语音服务'], ['macos', '电脑自带声音']]),
            value('ttsProvider') !== 'macos' ? h(React.Fragment, null,
              h('div', { className: 'dfy-grid', style: { marginTop: 16 } },
                input('ttsBaseURL', '语音 API URL', '填写兼容服务的 API 基础地址。本机 MLX 通常使用 http://127.0.0.1:端口/v1。'),
                input('ttsModel', '语音模型', '填写该服务实际支持的合成模型。')),
              h('div', { style: { marginTop: 16 } }, input('ttsLanguage', '合成语言', '填写当前模型支持的语言标识。中文 Qwen 语音使用 chinese，auto 表示自动识别；留空沿用服务默认。')),
              h('div', { className: 'dfy-field', style: { marginTop: 16 } },
                h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: fieldId.current + '-key' }, 'API Key'),
                  h(HelpTip, { label: '语音 API Key' }, '留空保留已有密钥。已保存的密钥不会显示出来，可以与聊天模型使用不同的服务。')),
                h('input', { id: fieldId.current + '-key', type: 'password', value: key, disabled: Boolean(busy) || clearKey || managed('ttsApiKey'), autoComplete: 'new-password', maxLength: 8192,
                  placeholder: managed('ttsApiKey') ? '由 DSH 管理' : voice.config.secretConfigured?.ttsApiKey ? '已配置 · 留空保留当前 API Key' : '尚未配置 API Key',
                  onChange: (event) => { if (managed('ttsApiKey')) return; audioPlayer.current?.pause?.(); setPreview(null); setKey(event.target.value); latest.current.key = event.target.value; setNotice(''); } }))) : null,
            h('div', { className: 'dfy-readonly' }, h('span', null, '运行开关'), h('span', null, voice.runtime?.enabled ? '已启用' : '未启用')),
            h('div', { className: 'dfy-readonly' }, h('span', null, '配置完整性'), h('span', null, voice.runtime?.configured ? '完整' : '待补充')),
            value('ttsProvider') !== 'macos' ? h(React.Fragment, null,
              h('div', { className: 'dfy-readonly' }, h('span', null, 'API 协议'), h('span', null, 'OpenAI Audio / audio/speech')),
              h('label', { className: 'dfy-check-label', style: { marginTop: 8 } }, h('input', { type: 'checkbox', checked: clearKey, disabled: Boolean(busy) || managed('ttsApiKey'),
                onChange: (event) => { if (managed('ttsApiKey')) return; audioPlayer.current?.pause?.(); setPreview(null);
                  latest.current.clearKey = event.target.checked; latest.current.key = ''; setClearKey(event.target.checked); setKey(''); } }), '清除已保存的语音 API Key'))
              : h('p', { className: 'dfy-hint' }, '电脑语音：', voice.runtime?.local?.sayInstalled ? '已安装' : '未安装',
                ' · FFmpeg：', voice.runtime?.local?.ffmpegInstalled ? '已安装' : '未安装',
                ' · FFprobe：', voice.runtime?.local?.ffprobeInstalled ? '已安装' : '未安装'),
            voice.runtime?.lastResult ? h('p', { className: 'dfy-hint' }, '上次结果：', typeof voice.runtime.lastResult === 'string' ? voice.runtime.lastResult
              : [voice.runtime.lastResult.ok === true ? '成功' : voice.runtime.lastResult.ok === false ? '失败' : '', voice.runtime.lastResult.note || voice.runtime.lastResult.message,
                voice.runtime.lastResult.at ? displayTime(voice.runtime.lastResult.at) : ''].filter(Boolean).join(' · ')) : null))
          : !failure ? h('div', { className: 'dfy-empty' }, '正在读取语音发送配置…') : null);
    }
    function PlatformAccountsPanel({ active }) {
      const api = usePanelApi(), [snapshot, setSnapshot] = useState(null), [busy, setBusy] = useState(''), [notice, setNotice] = useState('');
      const [pictures, setPictures] = useState({}), [reading, setReading] = useState(null), [form, setForm] = useState({ platform: 'bilibili', operation: 'comment' });
      const [reader, setReader] = useState({ platform: 'bilibili', operation: 'profile', target: '', query: '' }), [ack, setAck] = useState({});
      const [browsing, setBrowsing] = useState(null), [stoppingBrowse, setStoppingBrowse] = useState(false), browseLatest = useRef(null), browseGeneration = useRef(0), browseScope = useRef(null), browseStopping = useRef(false);
      const latest = useRef(null), lock = useRef(false); latest.current = snapshot;
      const labels = { disconnected: '尚未绑定', 'login-pending': '等待扫码或登录', 'login-unknown': '登录状态待核对', 'identity-binding-required': '账号识别待适配', candidate: '请核对账号',
        bound: '已绑定', expired: '二维码已过期', 'verification-required': '需要本人验证', 'account-mismatch': '账号不一致' };
      const verbs = { profile: '账号资料', search: '搜索', posts: '我的作品', comments: '作品评论', replies: '收到的回复', inbox: '收件箱', messages: '指定私信会话',
        notifications: '通知', 'comment-management': '我的作品评论管理', 'message-management': '我的私信管理', comment: '发表评论', reply: '回复评论', message: '发送私信', video: '发布视频', post: '发帖', like: '点赞', follow: '关注', bookmark: '收藏' };
      const states = { draft: '待核对', approved: '已批准，尚未执行', dispatching: '正在执行', unknown: '结果未知，没有重试', sent: '平台已返回编号' };
      function accept(value) {
        if (!value.accounts || !Array.isArray(value.accounts.platforms) || !Array.isArray(value.accounts.operations)) throw Error('平台账号状态不完整');
        if (api.alive.current) {
          const account = value.accounts.platforms.find(row => row.platform === 'douyin');
          const scope = JSON.stringify([account?.accountId || null, account?.generation || 0, account?.state || null]);
          if (browseScope.current !== null && browseScope.current !== scope) { browseGeneration.current++; browseLatest.current = null; setBrowsing(null); }
          browseScope.current = scope; latest.current = value.accounts; setSnapshot(value.accounts);
        } return value.accounts;
      }
      const refresh = async () => {
        const next = accept(await api.call('social/accounts'));
        for (const account of next.platforms.filter(row => row.loginImageAvailable)) {
          try { const value = await api.call('social/login/image', 'POST', { platform: account.platform, sessionId: account.loginSession });
            if (api.alive.current && latest.current?.platforms.find(row => row.platform === account.platform)?.loginSession === value.sessionId
              && value.image?.mime === 'image/png' && /^[A-Za-z0-9+/=]+$/.test(value.image.base64 || '') && value.image.base64.length < 1500000)
              setPictures(old => ({ ...old, [account.platform]: { sessionId: value.sessionId, src: 'data:image/png;base64,' + value.image.base64 } }));
          } catch { /* An expired image never restarts login. */ }
        }
        return next;
      };
      async function run(name, action) {
        if (lock.current) return; lock.current = true; setBusy(name); setNotice('');
        try { const result = await action(); if (api.alive.current) { if (name !== 'refresh') await refresh(); if (result?.silent !== true) setNotice(typeof result === 'string' && result ? result : '状态已更新。'); } }
        catch (error) { if (api.alive.current) { setNotice(resourceError(error)); try { await refresh(); } catch {} } }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      useEffect(() => { if (active) run('refresh', refresh); }, [active]);
      useEffect(() => {
        const browser = snapshot?.platforms.find(row => row.platform === 'douyin')?.browser;
        if (!active || !['ready', 'ready-to-start', 'unconfirmed'].includes(browser?.state)) return;
        const expiresAt = Date.parse(browser.expiresAt); if (!Number.isFinite(expiresAt)) return;
        const timer = setTimeout(() => {
          if (!api.alive.current || latest.current !== snapshot) return;
          const next = { ...snapshot, platforms: snapshot.platforms.map(row => row.platform === 'douyin'
            ? { ...row, driverAvailable: false, browser: { ...row.browser, ready: false, canStartNewActivity: false, activityReady: false, state: 'expired' } } : row) };
          latest.current = next; setSnapshot(next);
        }, Math.max(0, expiresAt - Date.now()));
        return () => clearTimeout(timer);
      }, [active, snapshot]);
      const post = (route, body) => api.call('social/' + route, 'POST', body, route === 'execute' ? 660000 : 90000);
      const btn = (text, name, onClick, disabled = false) => h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy) || disabled,
        onClick: () => run(name, onClick) }, busy === name ? '处理中…' : text);
      function acceptBrowse(value, generation) {
        if (api.alive.current && generation === browseGeneration.current) { browseLatest.current = value; setBrowsing(value); }
      }
      const canOpenBrowse = account => account?.browser?.lifecycle === undefined ? account?.driverAvailable === true
        : account.browser.canStartNewActivity === true || account.browser.activityReady === true;
      const canReadBrowse = account => account?.browser?.lifecycle === undefined ? account?.driverAvailable === true
        : account.browser.activityReady === true && account.browse?.state === 'active';
      const nextReady = () => {
        const account = latest.current?.platforms.find(row => row.platform === 'douyin');
        return !browseStopping.current && account?.state === 'bound' && canReadBrowse(account) && !account.safetyPause
          && !account.busy && !account.blocked && !account.cleanupRequired && account.nextAvailable === true
          && typeof browseLatest.current?.current?.platformVideoId === 'string' && /^[0-9]{10,25}(?![\s\S])/.test(browseLatest.current.current.platformVideoId);
      };
      async function browse(action) {
        const account = latest.current?.platforms.find(row => row.platform === 'douyin');
        if (['open', 'current'].includes(action) && (browseStopping.current || account?.state !== 'bound' || account.safetyPause
          || account.busy || account.blocked || account.cleanupRequired || !(action === 'open' ? canOpenBrowse(account) : canReadBrowse(account))))
          throw Error('当前浏览入口尚未就绪，请先核验浏览环境。');
        const request = { action }, currentId = browseLatest.current?.current?.id;
        if (action === 'next') { if (!currentId || !nextReady()) throw Error('切换视频仍待验证，当前仅开放读取。'); request.expectedVideoId = currentId; }
        const generation = ++browseGeneration.current;
        try { const value = await post('browse', { platform: 'douyin', request }); acceptBrowse(value.browse, generation); }
        catch (error) { if (generation !== browseGeneration.current) return { silent: true }; acceptBrowse({ ...browseLatest.current, state: 'unknown', current: null }, generation); if (error.code === 'DRIVER_UNAVAILABLE') error.message = '专用 Ego 浏览环境待核验。'; throw error; }
        if (generation !== browseGeneration.current) return { silent: true };
        return { open: '已打开抖音推荐页，保持静音。', current: '已读取当前视频页面文字与播放状态。', next: '已切换到下一个视频，保持静音。', history: '已读取最多20条本地浏览记录，没有访问平台。' }[action];
      }
      async function stopBrowse() {
        if (browseStopping.current) return;
        browseStopping.current = true;
        const generation = ++browseGeneration.current; setStoppingBrowse(true);
        try {
          const value = await post('browse', { platform: 'douyin', request: { action: 'stop' } });
          acceptBrowse(value.browse, generation);
          if (api.alive.current) { if (value.accounts) accept(value); setNotice('本次浏览已停止，登录资料保留。'); }
        } catch (error) { acceptBrowse({ ...browseLatest.current, state: 'unknown', current: null }, generation); if (api.alive.current) setNotice(resourceError(error)); }
        finally { browseStopping.current = false; if (api.alive.current) setStoppingBrowse(false); }
      }
      const browseVideo = (video, key) => {
        const media = video.media || {}, seconds = value => Number.isFinite(value) ? value.toFixed(1) + '秒' : '未读取';
        return h('div', { key, className: 'dfy-feature-card' },
          h('p', null, video.author || '作者暂未读取'),
          h('p', null, video.description || '页面未提供视频文案。'),
          h('p', { className: 'dfy-hint' }, '页面播放器静音：' + (media.muted === true ? '已确认' : '未确认') + ' · 播放：' + (media.paused === true ? '已暂停' : media.paused === false ? '播放中' : '未读取') + ' · 进度 ' + seconds(media.currentTime) + ' / ' + seconds(media.duration)));
      };
      const douyinAccount = snapshot?.platforms.find(account => account.platform === 'douyin');
      const browseUnavailable = !douyinAccount || Boolean(douyinAccount.safetyPause) || douyinAccount.busy || douyinAccount.blocked || douyinAccount.cleanupRequired || douyinAccount.state !== 'bound';
      const select = (value, entries, onChange) => h('select', { className: 'dfy-input', value, onChange: e => onChange(e.target.value) }, entries.map(([key, text]) => h('option', { value: key, key }, text)));
      const platforms = [['bilibili', 'B站'], ['douyin', '抖音'], ['x', 'X']];
      const field = (title, key, placeholder = '') => h('label', { className: 'dfy-field', key }, title, h(key === 'text' ? 'textarea' : 'input', { className: 'dfy-input', value: form[key] || '', placeholder,
        onChange: e => setForm(old => ({ ...old, [key]: e.target.value })) }));
      return h('section', { className: 'dfy-section', 'aria-label': '平台账号' },
        h(SectionHeading, { title: '大肥鱼自己的账号', help: '每个平台使用独立登录环境。页面不会自动探测、发送或启用自主活动；实际功能按验证状态显示。' }, btn('刷新账号状态', 'refresh', refresh)),
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        snapshot ? h('div', { className: 'dfy-feature-grid' }, snapshot.platforms.map(account => {
          const key = account.platform;
          return h('article', { className: 'dfy-feature-card', key, 'aria-label': account.name + '账号' },
            h('h3', null, account.name, ' · ', account.safetyPause ? '已暂停，待本人处理' : labels[account.state] || '待核对'),
            h('p', null, account.accountId ? account.accountName + ' · ' + account.accountId : key === 'x' ? '请由本人完成官方注册或登录' : '使用专用账号在手机扫码确认'),
            pictures[key]?.sessionId === account.loginSession && account.state === 'login-pending' && !account.safetyPause ? h('img', { alt: account.name + '本次登录二维码或页面', src: pictures[key].src,
              style: { display: 'block', width: '100%', maxWidth: 300, maxHeight: 360, objectFit: 'contain' } }) : null,
            btn(account.loginMethod === 'qr' ? '打开扫码登录' : '打开官方登录', 'login-' + key, async () => {
              const result = await post('login/start', { platform: key, requestId: crypto.randomUUID(), revision: latest.current.revision });
              const image = result.login?.image;
              if (image?.mime === 'image/png' && /^[A-Za-z0-9+/=]+$/.test(image.base64 || '') && image.base64.length < 1500000)
                setPictures(old => ({ ...old, [key]: { sessionId: result.sessionId, src: 'data:image/png;base64,' + image.base64 } }));
              return '请在本次专用窗口完成扫码或官方登录，然后点击检查登录。';
            }, Boolean(account.safetyPause) || account.loginAvailable === false || !account.driverAvailable || account.busy || account.blocked || account.cleanupRequired || account.state === 'login-pending'),
            account.loginAvailable === false ? h('p', { className: 'dfy-hint' }, account.state === 'bound' ? '当前复用已在 Ego 登录的账号，暂不从本页重新发起登录。' : '本页暂不提供 Ego 登录管理。') : null,
            account.loginSession ? btn('检查登录', 'check-' + key, async () => { const current = latest.current.platforms.find(row => row.platform === key);
              const result = await post('login/check', { platform: key, sessionId: current.loginSession });
              return result.login?.state === 'bound' ? '登录账号与原绑定一致。' : result.login?.state === 'candidate' ? '已读取当前账号，请核对账号归属。' : result.login?.state === 'identity-binding-required' ? '账号识别规则待适配，尚未绑定或发送。' : '登录尚未确认，请查看专用窗口中的验证提示。';
            }, Boolean(account.safetyPause) || account.loginAvailable === false || account.busy || account.cleanupRequired) : null,
            account.candidate ? h('div', null, h('p', null, '当前登录：' + account.candidate.name + ' · ' + account.candidate.accountId),
              btn('确认这是大肥鱼的账号', 'bind-' + key, async () => { const current = latest.current.platforms.find(row => row.platform === key);
                await post('account/confirm', { platform: key, accountId: current.candidate.accountId, revision: latest.current.revision }); return '已核验并绑定账号；功能仍须逐项实测。';
              }, Boolean(account.safetyPause) || account.cleanupRequired)) : null,
            account.loginSession ? btn('关闭本次登录流程', 'close-' + key, async () => { const current = latest.current.platforms.find(row => row.platform === key);
              await post('login/close', { platform: key, sessionId: current.loginSession, revision: latest.current.revision }); return '已关闭流程；平台保留的登录状态不会被清除。';
            }, account.busy || account.blocked || account.cleanupRequired) : null,
            account.busy ? h('button', { className: 'dfy-button', type: 'button', onClick: async () => { try { const result = await post('cancel', { platform: key }); setNotice(result.note); } catch (error) { setNotice(resourceError(error)); } } }, '请求停止后续步骤') : null,
            account.cleanupRequired && !account.busy ? btn('停止该平台独立执行器', 'stop-' + key, async () => {
              await post('stop-executor', { platform: key, revision: latest.current.revision }); return '独立执行器已停止；请继续核对原平台结果，未知操作没有重发。';
            }) : null,
            account.cleanupRequired && !account.blocked ? h('div', null,
              h('label', null, h('input', { type: 'checkbox', checked: ack['recover-' + key + ':' + snapshot.revision] === true,
                onChange: e => setAck(old => ({ ...old, ['recover-' + key + ':' + snapshot.revision]: e.target.checked })) }), ' 已确认旧执行器停止并核对平台结果'),
              btn('解除执行器保护', 'recover-' + key, async () => {
                if (!ack['recover-' + key + ':' + snapshot.revision] || latest.current.revision !== snapshot.revision) throw Error('状态已变化，请重新核对后确认。');
                await post('recover-executor', { platform: key, revision: snapshot.revision, executionStopped: true, resultReviewed: true }); return '已按明确确认解除保护，没有重跑。';
              }, !ack['recover-' + key + ':' + snapshot.revision])) : null,
            account.safetyPause ? h('div', { className: 'dfy-notice' },
              h('p', null, account.safetyPause.reason === 'owner-paused' ? '已按本人要求暂停。' : '平台要求安全验证，已停止后续平台请求。'),
              h('label', null, h('input', { type: 'checkbox', checked: ack['resume-' + key] === true,
                onChange: e => setAck(old => ({ ...old, ['resume-' + key]: e.target.checked })) }), ' 我已在官方页面处理完成，并确认继续使用这个账号'),
              btn('按本人确认继续', 'resume-' + key, async () => { if (!ack['resume-' + key]) return;
                await post('resume', { platform: key, revision: latest.current.revision, verificationCompleted: true }); return '已按本人确认恢复准入；没有自动重做任何操作。';
              }, !ack['resume-' + key] || account.busy || account.blocked || account.cleanupRequired)) :
              btn('暂停这个平台', 'hold-' + key, async () => { await post('hold', { platform: key, revision: latest.current.revision, reason: 'owner-paused' }); return '已暂停该平台，没有清除登录或重做操作。'; }),
            account.blocked ? h('p', { className: 'dfy-notice' }, '有结果未知的操作，请在下方核对原结果。') : null,
            h(Advanced, { title: '功能与验证状态' }, account.capabilities.map(item => h('p', { key: item.operation, className: 'dfy-hint' }, verbs[item.operation] || item.operation, '：',
              ({ 'needs-login': '先登录并确认', 'implemented-not-verified': '已接驱动，待现场验证', 'bindings-required': '当前页面待适配', 'empty-state-only': '当前仅支持空列表状态，非空内容待适配', 'not-verified': '待验证', 'not-implemented': '尚未接入' })[item.state] || item.state))));
        })) : h('p', null, '正在读取账号状态…'),
        h('section', { 'aria-label': '抖音静音浏览' },
          h('h3', null, '抖音静音浏览'),
          h('p', { className: 'dfy-hint' }, '按你当前交办的任务单步浏览，不自动刷新、连刷或开启自主活动。视频页面文字/播放状态，不代表已理解视频画面。'),
          douyinAccount?.browser ? h('p', { className: 'dfy-hint' }, douyinAccount.browser.lifecycle === 'closed'
            ? douyinAccount.browser.state === 'ready-to-start' ? '后台浏览入口已核验；打开时会再次核对账号。本次浏览已结束，登录资料保留。'
              : douyinAccount.browser.state === 'expired' ? '后台入口核验已过期，请重新核验；本次浏览已结束，登录资料保留。'
                : '当前没有正在浏览的任务，登录资料保留；开始前请核验后台入口。'
            : ({ ready: '最近已核验 Ego 浏览空间；登录和当前内容仍以实际读取为准。',
              'not-checked': '浏览环境已配置，当前 Ego 空间尚未核验。',
              expired: '上次空间核验已过期，请重新核验；这不代表账号已退出。',
              unconfirmed: '当前执行器未能确认专用 Ego 空间；这不代表账号已退出，请核验浏览环境。',
              unavailable: '专用 Ego 浏览环境暂不可用，请核对执行器和保护状态。',
            })[douyinAccount.browser.state] || '专用 Ego 浏览空间待核验。')
            : douyinAccount?.driverAvailable === false ? h('p', { className: 'dfy-hint' }, '专用 Ego 浏览环境待核验。') : null,
          douyinAccount?.browser ? btn('核验 Ego 浏览环境', 'check-browser', async () => {
            const account = latest.current?.platforms.find(row => row.platform === 'douyin');
            if (!account?.driverConfigured || account.safetyPause || account.busy || account.blocked || account.cleanupRequired || browseStopping.current) throw Error('当前浏览环境不允许核验，请刷新状态。');
            const value = await post('check-browser', { platform: 'douyin', revision: latest.current.revision });
            if (value.accounts) accept(value);
            return value.browser?.ready === true ? value.browser.state === 'ready-to-start' ? '后台浏览入口已核验；打开时会再次核对账号。没有访问平台页面。' : '已核验当前专用 Ego 空间，没有访问平台页面。' : '当前执行器尚未确认专用 Ego 空间，账号绑定和登录资料保留。';
          }, !douyinAccount.driverConfigured || Boolean(douyinAccount.safetyPause) || douyinAccount.busy || douyinAccount.blocked || douyinAccount.cleanupRequired || stoppingBrowse) : null,
          douyinAccount?.nextAvailable !== true ? h('p', { className: 'dfy-hint' }, '切换视频仍待验证，当前仅开放读取。') : null,
          h('div', { className: 'dfy-feature-actions' },
            btn('打开推荐', 'browse-open', () => browse('open'), browseUnavailable || !canOpenBrowse(douyinAccount) || stoppingBrowse),
            btn('读取当前', 'browse-current', () => browse('current'), browseUnavailable || !canReadBrowse(douyinAccount) || stoppingBrowse),
            btn('下一个', 'browse-next', () => browse('next'), browseUnavailable || !canReadBrowse(douyinAccount) || stoppingBrowse || !browsing?.current?.id || !nextReady()),
            h('button', { className: 'dfy-button', type: 'button', disabled: stoppingBrowse, onClick: stopBrowse }, stoppingBrowse ? '停止中…' : '停止'),
            btn('查看有限历史', 'browse-history', () => browse('history'), stoppingBrowse)),
          h('p', { className: 'dfy-hint' }, browsing?.state === 'active' ? '本次浏览已打开；只有你操作时才执行下一步。' : browsing?.state === 'unknown' ? '浏览状态待核对；不会自动继续。' : '当前未在浏览。'),
          browsing?.current ? browseVideo(browsing.current, 'current') : null,
          Array.isArray(browsing?.history) && browsing.history.length ? h(Advanced, { title: '本次有限历史（最多20条）' }, browsing.history.slice(-20).map((video, index) => browseVideo(video, video.id + '-' + index)))
            : browsing?.action === 'history' ? h('p', { className: 'dfy-hint' }, '暂无本地浏览记录。') : null),
        h(Advanced, { title: '读取账号内容' }, select(reader.platform, platforms, value => setReader(old => ({ ...old, platform: value, operation: 'profile' }))),
          select(reader.operation, ['profile', 'posts', 'comments', 'replies', 'inbox', 'messages', 'notifications', 'search', ...(reader.platform === 'douyin' ? ['comment-management', 'message-management'] : [])].map(key => [key, verbs[key]]), value => setReader(old => ({ ...old, operation: value }))),
          h('input', { className: 'dfy-input', placeholder: '作品链接或指定会话对象', value: reader.target, onChange: e => setReader(old => ({ ...old, target: e.target.value })) }),
          h('input', { className: 'dfy-input', placeholder: '搜索词', value: reader.query, onChange: e => setReader(old => ({ ...old, query: e.target.value })) }),
          btn('读取指定内容', 'read', async () => { const request = { operation: reader.operation, limit: 10 };
            if (reader.target.trim()) request.target = reader.target.trim(); if (reader.query.trim()) request.query = reader.query.trim();
            const value = await post('read', { platform: reader.platform, request }); setReading(value.read); return '已读取指定账号内容。'; }),
          reading ? h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, JSON.stringify(reading, null, 2)) : null),
        h(Advanced, { title: '准备本地草稿' }, h('p', { className: 'dfy-hint' }, '这一步不会上传或发送。'),
          select(form.platform, platforms, value => setForm(old => ({ ...old, platform: value }))),
          select(form.operation, ['comment', 'reply', 'message', 'video', 'post'].map(key => [key, verbs[key]]), value => setForm(old => ({ ...old, operation: value }))),
          ['target', 'parentId', 'rootId', 'text'].map((key, index) => field(['对象', '回复哪条评论', '主评论标识（B站回复需要）', '正文'][index], key)),
          form.operation === 'video' ? h('div', null, ['title', 'video', 'cover', 'tags', 'category'].map((key, i) => field(['标题', '本地视频完整路径', '本地封面完整路径', '标签（英文逗号分隔）', '分区编号'][i], key)),
            select(form.declaration || '', [['', '选择内容声明'], ['none', '非 AI 生成'], ['ai-generated', 'AI 生成']], value => setForm(old => ({ ...old, declaration: value })))) : null,
          btn('仅准备草稿', 'prepare', async () => { const request = { operation: form.operation };
            for (const key of ['target', ...(form.operation === 'reply' ? ['parentId', 'rootId'] : []), 'text', ...(form.operation === 'video' ? ['title', 'video', 'cover', 'category', 'declaration'] : [])])
              if (form[key]?.trim()) request[key] = key === 'text' ? form[key] : form[key].trim();
            if (form.operation === 'video' && form.tags?.trim()) request.tags = form.tags.split(',').map(text => text.trim()).filter(Boolean);
            await post('prepare', { platform: form.platform, request, requestId: crypto.randomUUID() }); return '本地草稿已准备；尚未上传或发送。'; })),
        h('h3', null, '待发内容与结果'), snapshot?.operations.length ? snapshot.operations.map(row => h('article', { className: 'dfy-feature-card', key: row.id },
          h('h4', null, (verbs[row.operation] || row.operation) + ' · ' + (states[row.state] || row.state)),
          h('p', null, row.platform + ' / ' + row.accountId), row.target ? h('p', null, '对象：' + row.target) : null,
          row.parentId ? h('p', null, '回复：' + row.parentId + (row.rootId ? ' · 主评论：' + row.rootId : '')) : null,
          row.title ? h('p', null, '标题：' + row.title) : null, row.text ? h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, row.text) : null,
          row.mediaName ? h('p', null, '视频：' + row.mediaName + ' · 封面：' + row.coverName + ' · 声明：' + row.declaration + ' · 标签：' + row.tags.join('、') + ' · 分区：' + (row.category || '')) : null,
          ['draft', 'approved'].includes(row.state) ? btn(row.state === 'draft' ? '确认内容并执行' : '执行已批准内容', 'execute-' + row.id, async () => {
            const current = latest.current.operations.find(item => item.id === row.id);
            if (!current || current.approvalDigest !== row.approvalDigest || !['draft', 'approved'].includes(current.state)) throw Error('草稿已变化，请重新核对。');
            if (current.state === 'draft') await post('approve', { operationId: row.id, approvalDigest: row.approvalDigest, revision: latest.current.revision });
            const result = await post('execute', { operationId: row.id, approvalDigest: row.approvalDigest });
            return result.operation.state === 'sent' ? '平台返回本次编号：' + result.operation.resultId : result.operation.note || '请核对原平台结果。';
          }) : null,
          row.state === 'unknown' && snapshot.platforms.find(account => account.platform === row.platform)?.blocked ? h('div', null,
            h('label', null, h('input', { type: 'checkbox', checked: ack[row.id] === true, onChange: e => setAck(old => ({ ...old, [row.id]: e.target.checked })) }), ' 已核对原平台结果，确认旧执行器停止；不会重做原操作'),
            btn('按上述确认解除保护', 'ack-' + row.id, async () => { if (!ack[row.id]) return; await post('acknowledge', { operationId: row.id, revision: latest.current.revision, executionStopped: true, resultReviewed: true }); return '保护已解除；原结果仍标未知，没有重发。'; }, !ack[row.id])) : null,
          row.note ? h('p', null, row.note) : null, row.resultId ? h('p', null, '平台编号：' + row.resultId) : null)) : h('p', { className: 'dfy-hint' }, '暂无待发内容。'));
    }
    function VideoPlatformsPanel({ active }) {
      const api = usePanelApi();
      const [social, setSocial] = useState(null);
      const [showAccounts, setShowAccounts] = useState(false);
      const [busy, setBusy] = useState('');
      const [failure, setFailure] = useState('');
      const [results, setResults] = useState({});
      const generation = useRef(0), lock = useRef(false), isActive = useRef(active), latest = useRef(null);
      isActive.current = active; latest.current = social;
      const operationError = (error) => ({ FORBIDDEN: '主人登录权限已失效，请重新打开设置。', BUSY: '当前有任务正在处理，请稍后检查。',
        CONFLICT: '平台连接已变化，请刷新状态后检查。', UNCONFIRMED: '本次检查未得到确认，请刷新状态核对；不会自动重试。' })[error?.code]
        || '视频平台暂未返回完整结果，请刷新状态后重试。';
      function accept(value) {
        if (!value?.social || typeof value.social !== 'object' || Array.isArray(value.social)
          || !value.social.bilibili?.browse || !value.social.douyin?.browse || typeof value.social.busy !== 'boolean') throw new Error('视频平台状态响应不完整');
        setSocial(value.social);
      }
      async function read() {
        if (lock.current || !isActive.current) return;
        const current = generation.current; lock.current = true; setBusy('read'); setFailure('');
        try { const response = await api.call('social/status');
          if (api.alive.current && isActive.current && current === generation.current) accept(response);
        } catch (error) { if (api.alive.current && current === generation.current) setFailure(operationError(error)); }
        finally { if (current === generation.current) { lock.current = false; if (api.alive.current) setBusy(''); } }
      }
      useEffect(() => {
        if (active) read();
        return () => { generation.current++; api.cancel(); lock.current = false; setBusy(''); };
      }, [active]);
      async function checkBrowse(platformId = 'bilibili') {
        const state = latest.current;
        if (!['bilibili', 'douyin'].includes(platformId) || lock.current || !api.alive.current || !isActive.current || state?.busy
          || state?.[platformId]?.browse?.configured !== true || state?.[platformId]?.browse?.enabled !== true) return;
        if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') { setFailure('当前界面暂不支持生成检查编号，请重新打开 DSH。'); return; }
        const current = generation.current; lock.current = true; setBusy('check-' + platformId); setFailure('');
        setResults((previous) => ({ ...previous, [platformId]: null }));
        try {
          const response = await api.call('social/check', 'POST', { platform: platformId, requestId: crypto.randomUUID() }, 180000);
          if (api.alive.current && isActive.current && current === generation.current) {
            accept(response);
            const test = response.test;
            if (typeof test?.ok !== 'boolean') throw new Error('浏览检查没有返回明确结果');
            const limited = platformId === 'douyin' && ['needs-login', 'verification-required', 'cleanup-unconfirmed'].includes(test.state);
            if (test.ok && !limited && (platformId === 'bilibili' ? !/^BV[a-zA-Z0-9]{10}$/.test(test.bvid || '')
              || typeof test.title !== 'string' || !test.title.trim() || !resultLink(test, platformId) : !validDouyinResult(test))) throw new Error('浏览检查没有返回明确结果');
            setResults((previous) => ({ ...previous, [platformId]: { ...test, ok: test.ok && !limited } }));
          }
        } catch (error) { if (api.alive.current && current === generation.current) setFailure(operationError(error)); }
        finally { if (current === generation.current) { lock.current = false; if (api.alive.current) setBusy(''); } }
      }
      function browseState(browse) {
        if (browse?.configured !== true) return '尚未接入';
        if (browse.enabled !== true) return '未开启';
        if (browse.readiness === 'needs-login') return '需要登录独立账号';
        if (browse.readiness === 'verification-required') return '需要账号验证';
        if (browse.readiness === 'cleanup-unconfirmed') return '结果待核对';
        if (browse.readiness === 'not-verified') {
          if (browse.lastResult?.state === 'needs-login') return '上次检查需登录';
          if (browse.lastResult?.state === 'verification-required') return '上次检查需验证';
        }
        if (browse.lastResult?.ok === false || browse.readiness === 'failed') return '需要处理';
        return ['ready', 'verified', 'read-verified'].includes(browse.readiness) ? '检查通过' : '待检查';
      }
      function publicationState(publication) {
        return ({ 'account-bound-not-verified': '账号已绑定，发布待验', 'prepared-not-connected': '待绑定独立账号', 'not-configured': '尚未准备', missing: '尚未准备',
          prepared: '稿件已准备', unknown: '结果待核对', submitted: '已提交，待回查', reviewing: '平台审核中', verified: '已回查' })[publication?.state] || '待核对';
      }
      function resultLink(test, platformId = 'bilibili') {
        try { const url = new URL(test?.url);
          if (url.protocol !== 'https:' || url.username || url.password) return '';
          return (platformId === 'bilibili' ? url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')
            : url.hostname === 'www.douyin.com' && !url.search && !url.hash && /^\/(?:video\/[0-9]{6,30}|search\/[^/]+)$/.test(url.pathname)) ? url.href : ''; }
        catch { return ''; }
      }
      function validDouyinResult(test) {
        const videoUrl = (url, id) => typeof id === 'string' && /^[0-9]{6,30}$/.test(id) && url === 'https://www.douyin.com/video/' + id;
        if (test.state === 'search-read') return Array.isArray(test.videos) && test.videos.length > 0 && test.videos.length <= 10
          && test.videos.every((item) => videoUrl(item?.url, item?.id) && typeof item.title === 'string' && item.title.trim());
        return test.state === 'video-observed' && Number.isInteger(test.frameCount) && test.frameCount > 0 && test.frameCount <= 3
          && videoUrl(test.url, test.video?.id) && Number.isFinite(test.video?.currentTime) && test.video.currentTime >= 0;
      }
      const row = (label, state, help) => h('div', { className: 'dfy-readonly' },
        h('span', { className: 'dfy-titleline' }, label, h(HelpTip, { label }, help)), h('strong', null, state));
      return h('section', { className: 'dfy-section' },
        h('div', { className: 'dfy-feature-actions' }, h('button', { className: 'dfy-button', type: 'button', onClick: () => setShowAccounts(value => !value) }, showAccounts ? '收起平台账号' : '管理B站、抖音与X账号')),
        showAccounts ? h(PlatformAccountsPanel, { active }) : null,
        h(SectionHeading, { title: '视频平台', help: '分别查看浏览、账号和发布准备。打开页面只读取状态；只有点击检查浏览才会读取公开视频。' },
          h('button', { className: 'dfy-button', type: 'button', disabled: Boolean(busy), onClick: read }, busy === 'read' ? '刷新中…' : '刷新状态')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        social ? h('div', { className: 'dfy-feature-grid' }, [['bilibili', 'B站'], ['douyin', '抖音']].map(([id, title]) => {
          const platform = social[id], browse = platform.browse, last = browse.lastResult, result = results[id];
          return h('article', { className: 'dfy-feature-card', key: id, 'aria-label': title + '连接状态' },
            h('h3', { className: 'dfy-feature-title' }, title),
            row('浏览状态', browseState(browse), '浏览公开内容与独立账号、发布权限分别检查。待检查表示尚无本次实际结果，不能据此认为已经可用。'),
            row('独立账号', platform.account?.configured === true ? '已绑定' : '待绑定独立账号', '后续使用你提供的专用账号。公开页能否免登录由平台决定，检查不会自动登录账号。'),
            row('发布准备', publicationState(platform.publication), '稿件准备、实际提交和平台审核是不同状态。当前页面不提供上传或发布操作。'),
            h('div', { className: 'dfy-feature-actions' }, h('button', { className: 'dfy-button', type: 'button',
              disabled: Boolean(busy) || social.busy || browse.configured !== true || browse.enabled !== true, onClick: () => checkBrowse(id) },
              busy === 'check-' + id ? id === 'douyin' ? '检查抖音浏览中…' : '检查浏览中…' : id === 'douyin' ? '检查抖音浏览' : '检查浏览')),
            result ? h('div', { className: 'dfy-notice' + (result.ok ? '' : ' dfy-warning'), role: result.ok ? 'status' : 'alert', style: { marginTop: 12 } },
              h('strong', null, result.ok ? '公开浏览检查通过' : result.state === 'needs-login' ? '需要登录独立账号'
                : result.state === 'verification-required' ? '需要人工完成账号验证' : result.state === 'cleanup-unconfirmed' ? '结果待核对' : '公开浏览尚未通过'),
              result.title ? h('p', null, result.title) : null,
              result.ok && result.state === 'search-read' && result.videos?.[0]?.title ? h('p', null, '找到：', result.videos[0].title) : null,
              result.note ? h('p', null, result.note) : null,
              result.ok && resultLink(result, id) ? h('a', { href: resultLink(result, id), target: '_blank', rel: 'noopener noreferrer' },
                result.state === 'search-read' ? '查看搜索结果' : '查看本次视频') : null) : null,
            h(Advanced, { title: '高级详情' },
              h('p', { className: 'dfy-hint' }, '浏览组件：', browse.configured === true ? '已接入' : '未接入', ' · 运行开关：', browse.enabled === true ? '开启' : '关闭'),
              h('p', { className: 'dfy-hint' }, '最近检查：', displayTime(browse.lastCheck?.at || browse.lastCheck)),
              last?.note ? h('p', { className: 'dfy-hint' }, '最近记录：', last.note) : null,
              h('p', { className: 'dfy-hint' }, '发布状态：', platform.publication?.state || '未确认')));
        })) : !failure ? h('div', { className: 'dfy-empty' }, '正在读取视频平台状态…') : null);
    }
    function DependencyPanel({ active, scope = 'all', onSnapshot, onNavigate, maintenanceBlocked = false }) {
      const api = usePanelApi();
      const [snapshot, setSnapshot] = useState(null);
      const [busy, setBusy] = useState('');
      const [failure, setFailure] = useState('');
      const [notice, setNotice] = useState('');
      const [download, setDownload] = useState('');
      const generation = useRef(0);
      const lock = useRef(false);
      const timer = useRef(null);
      const isActive = useRef(active);
      isActive.current = active;
      function accept(result) {
        const next = result.dependencies;
        if (!next || !Array.isArray(next.items)) throw new Error('依赖状态响应不完整');
        setSnapshot(next); onSnapshot?.(next);
        return next;
      }
      async function read(poll = false) {
        if (lock.current) return;
        const current = generation.current;
        lock.current = true;
        if (!poll) { setBusy('read'); setFailure(''); }
        try {
          const result = await api.call('dependencies');
          if (api.alive.current && generation.current === current) {
            const next = accept(result);
            if (next.job?.state === 'running' && isActive.current) timer.current = setTimeout(() => read(true), 2000);
          }
        } catch (error) { if (api.alive.current && generation.current === current) setFailure(resourceError(error)); }
        finally { lock.current = false; if (api.alive.current && generation.current === current && !poll) setBusy(''); }
      }
      useEffect(() => {
        if (active) read();
        return () => { generation.current++; clearTimeout(timer.current); api.cancel(); lock.current = false; setBusy(''); };
      }, [active]);
      async function check(updates) {
        if (lock.current) return;
        clearTimeout(timer.current); lock.current = true; setBusy(updates ? 'updates' : 'check'); setFailure(''); setNotice('');
        try {
          const result = await api.call('dependencies/check', 'POST', { updates });
          if (api.alive.current) { accept(result); setNotice(updates ? '已完成本次更新检查。版本来源不可达的项目会保留“未确认”。' : '本机依赖状态已重新检测。'); }
        } catch (error) { if (api.alive.current) setFailure(resourceError(error)); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      async function action(item, choice) {
        if (lock.current || snapshot?.busy || choice.enabled !== true || maintenanceBlocked && ['install', 'update', 'start', 'restart'].includes(choice.id) && !choice.url) return;
        clearTimeout(timer.current); lock.current = true; setBusy(item.id + ':' + choice.id); setFailure(''); setNotice(''); setDownload('');
        try {
          const result = await api.call('dependencies/action', 'POST', { id: item.id, action: choice.id });
          if (api.alive.current) {
            const next = result.dependencies ? accept(result) : null;
            if (result.result?.downloadUrl) {
              const url = new URL(result.result.downloadUrl);
              if (url.protocol !== 'https:') throw new Error('下载地址格式不符合预期');
              setDownload(url.href);
            }
            setNotice(result.result?.accepted ? '任务已开始，进度会在本页更新。' : '操作已返回，请核对组件状态。');
            if ((next?.job?.state === 'running' || result.result?.job?.state === 'running') && isActive.current) timer.current = setTimeout(() => read(true), 2000);
          }
        } catch (error) { if (api.alive.current) setFailure(resourceError(error)); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const healthStatuses = {
        ready: { label: '已就绪', tone: 'ready', icon: '✓' },
        'not-verified': { label: '待核验', tone: 'neutral', icon: '○' },
        missing: { label: '未安装', tone: 'warning', icon: '↓' },
        blocked: { label: '需处理', tone: 'danger', icon: '!' },
        offline: { label: '未连接', tone: 'warning', icon: '—' },
        unsupported: { label: '暂不支持', tone: 'neutral', icon: '—' },
        unknown: { label: '待检查', tone: 'neutral', icon: '?' },
      };
      function jobStatus(job) {
        const action = { update: '更新', install: '安装', start: '启动', restart: '重启', check: '检查' }[job.action] || '操作';
        if (job.state === 'running') return { label: '正在' + action, tone: 'info', icon: '…' };
        if (job.state === 'failed') return { label: action + '失败', tone: 'danger', icon: '!' };
        if (job.state === 'succeeded') return { label: action + '完成', tone: 'ready', icon: '✓' };
        if (job.state === 'cancelling') return { label: '正在停止', tone: 'warning', icon: '…' };
        if (['cancelled', 'interrupted'].includes(job.state)) return { label: '已停止', tone: 'neutral', icon: '—' };
        return { label: '结果待核实', tone: 'warning', icon: '?' };
      }
      function jobMessage(job) {
        return job.message || { running: '任务正在执行，进度会自动更新。', failed: '本次操作未完成，请先检查组件状态。',
          succeeded: '本次操作已完成，能否使用请以组件检测状态为准。', cancelling: '正在等待操作停止，请勿重复执行。',
          cancelled: '本次操作已停止。', interrupted: '本次操作已中断，请检查组件状态。' }[job.state]
          || '本次操作结果尚未确认，请勿重复执行。';
      }
      const statusPill = (status, kind) => h('span', { className: 'dfy-resource-status dfy-resource-status--' + status.tone,
        'aria-label': (kind === 'job' ? '最近操作：' : kind === 'update' ? '更新状态：' : '组件状态：') + status.label, key: kind },
        h('span', { className: 'dfy-resource-status-icon', 'aria-hidden': true }, status.icon), h('span', null, status.label));
      function resourceStatuses(item, componentIds = [item.id]) {
        const job = snapshot?.job;
        const relatedJob = job && componentIds.includes(job.componentId) && job.state !== 'succeeded';
        return h('div', { className: 'dfy-resource-statuses' },
          relatedJob ? statusPill(jobStatus(job), 'job') : null,
          statusPill(healthStatuses[item.health] || healthStatuses.unknown, 'health'),
          item.updateState === 'available' ? statusPill({ label: '可更新', tone: 'info', icon: '↑' }, 'update') : null);
      }
      const updates = { 'not-checked': '尚未检查更新', 'up-to-date': '已是最新', available: '有可用更新', unknown: '最新版本未确认' };
      const names = { orbstack: '运行环境', docker: '运行服务', ffmpeg: '音频处理', ffprobe: '音频检查', scrcpy: '手机声音采集',
        adb: '手机连接', 'macos-tts': '电脑自带声音', 'voice-receive': '接收语音', 'voice-send': '发送语音' };
      const updateSources = { homebrew: 'Homebrew', 'android-sdk': 'Android SDK', external: '原安装工具', unverified: '来源待核实', none: '尚未安装' };
      const visible = (snapshot?.items || []).filter((item) => scope !== 'voice' || ['voice-receive', 'voice-send', 'ffmpeg', 'ffprobe', 'macos-tts'].includes(item.id));
      const qqComponents = visible.filter((item) => ['napcat', 'linux-qq'].includes(item.id));
      const suite = qqComponents.find((item) => item.id === 'napcat') || qqComponents[0];
      const resourceDetails = (item) => h('div', { className: 'dfy-resource-details' },
        h('span', null, '存在：', h('strong', null, item.installed === true ? '已检测到' : item.installed === false ? '未检测到' : '尚未确认')),
        h('span', null, '当前版本：', h('strong', null, item.currentVersion || '未确认')),
        h('span', null, item.id === 'linux-qq' ? '镜像可用版本：' : '最新版本：', h('strong', null, item.latestVersion || '未确认')),
        item.managedBy ? h('span', null, '更新来源：', h('strong', null, updateSources[item.managedBy] || '尚未确认')) : null,
        h('span', null, '更新：', h('strong', null, updates[item.updateState] || '尚未检查')));
      function resourceActions(item, choices = item.actions || []) {
        return h('div', { className: 'dfy-inline-actions' }, choices.map((choice) => {
          let url = '';
          try { if (choice.url && new URL(choice.url).protocol === 'https:') url = new URL(choice.url).href; } catch {}
          const mutation = ['install', 'update', 'start', 'restart'].includes(choice.id) && !url;
          const label = choice.id === 'check' ? '检查' : choice.id === 'start' ? '启动' : choice.id === 'restart' ? '重启 QQ 服务'
            : choice.id === 'install' ? '安装' : choice.id === 'update' ? '更新' : '下载';
          return url && choice.enabled ? h('a', { key: choice.id, className: 'dfy-button', href: url, target: '_blank', rel: 'noopener noreferrer', style: { textDecoration: 'none' } }, label)
            : h('button', { key: choice.id, type: 'button', className: 'dfy-button', disabled: choice.enabled !== true || Boolean(busy) || snapshot.busy
              || mutation && (maintenanceBlocked || !snapshot.checkedAt),
              title: mutation && maintenanceBlocked ? '请先点击“保存”，并等待当前任务完成。'
                : mutation && !snapshot.checkedAt ? '请先检查安装状态。' : choice.reason || '',
              onClick: () => action(item, choice) }, busy === item.id + ':' + choice.id ? '处理中…' : label);
        }));
      }
      function resourceNotes(item, choices = item.actions || []) {
        const mutation = choices.some((choice) => ['install', 'update', 'start', 'restart'].includes(choice.id) && !choice.url);
        return h(React.Fragment, null,
          mutation && maintenanceBlocked ? h('p', { className: 'dfy-action-note' }, '请先点击“保存”，并等待当前任务完成。') : null,
          mutation && !snapshot.checkedAt ? h('p', { className: 'dfy-action-note' }, '请先检查安装状态。') : null,
          choices.filter((choice) => choice.reason && (choice.enabled !== true || ['restart', 'update'].includes(choice.id) && ['napcat', 'linux-qq'].includes(item.id))).map((choice) =>
          h('p', { className: 'dfy-action-note', key: choice.id }, choice.label, '：', choice.reason)));
      }
      function primaryAction(item) {
        const actions = item.actions || [];
        if (item.installed === false) return actions.find((choice) => choice.id === 'install' && choice.enabled)
          || actions.find((choice) => choice.id === 'download' && choice.enabled) || actions.find((choice) => choice.id === 'install') || actions[0];
        if (item.updateState === 'available') return actions.find((choice) => choice.id === 'update') || actions[0];
        if (['napcat', 'linux-qq'].includes(item.id) && item.containerRunning === false) return actions.find((choice) => choice.id === 'start') || actions[0];
        return actions.find((choice) => choice.id === 'check') || actions[0];
      }
      const standardResource = (item) => {
        const primary = primaryAction(item);
        const others = (item.actions || []).filter((choice) => choice !== primary);
        const sourceGuidance = item.installed === true && ['android-sdk', 'external', 'unverified'].includes(item.managedBy)
          && primary?.id !== 'update' && item.updateReason && (item.actions || []).some((choice) => choice.id === 'update' && choice.enabled !== true);
        return h('article', { className: 'dfy-resource', key: item.id },
          h('div', { className: 'dfy-resource-heading' },
            h('div', { className: 'dfy-titleline' }, h('h4', { className: 'dfy-resource-name', style: { margin: 0 } }, names[item.id] || item.name || '组件'),
              h(HelpTip, { label: names[item.id] || item.name || '组件' }, [item.name, item.note].filter(Boolean).join('。'))),
            resourceStatuses(item)),
          item.note && ['offline', 'missing', 'blocked', 'unsupported'].includes(item.health) ? h('p', { className: 'dfy-action-note' }, item.note) : null,
          primary ? resourceActions(item, [primary]) : null, primary ? resourceNotes(item, [primary]) : null,
          sourceGuidance ? h('p', { className: 'dfy-action-note dfy-update-guidance' }, item.updateReason) : null,
          h(Advanced, { title: '高级设置' }, resourceDetails(item), resourceActions(item, others), resourceNotes(item, others)));
      };
      const qqPrimary = suite ? primaryAction(suite) : null;
      const qqSuite = suite ? h('article', { className: 'dfy-resource', key: 'qq-suite', 'aria-label': 'QQ 接入套件' },
        h('div', { className: 'dfy-resource-heading' },
          h('div', { className: 'dfy-titleline' }, h('h4', { className: 'dfy-resource-name', style: { margin: 0 } }, 'QQ 服务'),
            h(HelpTip, { label: 'QQ 服务' }, '登录和收发消息需要的组件已包含在一起，安装一次即可。服务启动后，请到 QQ 登录页扫码。')),
          resourceStatuses(suite, qqComponents.map((item) => item.id))),
        suite.note && ['offline', 'missing', 'blocked', 'unsupported'].includes(suite.health) ? h('p', { className: 'dfy-action-note' }, suite.note) : null,
        qqPrimary ? resourceActions(suite, [qqPrimary]) : null,
        qqPrimary ? resourceNotes(suite, [qqPrimary]) : null,
        qqPrimary?.id === 'update' && !qqPrimary.url ? h('p', { className: 'dfy-action-note' }, '更新会短暂断开 QQ，保留配置和登录资料。') : null,
        qqPrimary?.id === 'restart' && !qqPrimary.url ? h('p', { className: 'dfy-action-note' }, '保留配置和登录资料；重启会短暂断开 QQ。') : null,
        onNavigate ? h('button', { type: 'button', className: 'dfy-button', style: { marginTop: 8 }, onClick: () => onNavigate('qq') }, '去登录') : null,
        h(Advanced, { title: '高级设置' },
          qqComponents.map((item) => h('div', { className: 'dfy-suite-component', key: item.id },
            h('div', { className: 'dfy-resource-heading' }, h('strong', null, item.name || item.id),
              resourceStatuses(item)),
            resourceDetails(item), item.note ? h('p', { className: 'dfy-hint' }, item.note) : null)),
          h('p', { className: 'dfy-action-note' }, '保留配置和登录资料；重启会短暂断开 QQ。更新服务也会暂时断开连接。'),
          resourceActions(suite, (suite.actions || []).filter((choice) => choice !== qqPrimary)),
          resourceNotes(suite, (suite.actions || []).filter((choice) => choice !== qqPrimary)),
          h('div', { className: 'dfy-inline-actions' },
            h('a', { className: 'dfy-link-button', href: 'https://napneko.github.io/guide/napcat', target: '_blank', rel: 'noopener noreferrer' }, '安装教程'),
            h('a', { className: 'dfy-link-button', href: 'https://im.qq.com/linuxqq/download.html', target: '_blank', rel: 'noopener noreferrer' }, 'QQ 官方说明')),
          h(HelpTip, { label: 'QQ 组件更新' }, 'Linux QQ 与 NapCat 使用同一镜像统一安装和更新。单独下载 Linux QQ 安装包不会更新这里的服务。'))) : null;
      return h('section', { className: 'dfy-section dfy-dependency-panel' },
        h(SectionHeading, { title: scope === 'voice' ? '声音组件' : '安装与更新', help: '查看所需组件是否准备好。检查不会安装或更新；选择安装、更新或重启后才会执行。' },
          h('div', { className: 'dfy-inline-actions' },
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || snapshot?.busy, onClick: () => check(false) }, busy === 'check' ? '检查中…' : '检查安装'),
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || snapshot?.busy, onClick: () => check(true) }, busy === 'updates' ? '检查中…' : '检查更新'))),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice,
          download ? h('p', { style: { marginTop: 6 } }, h('a', { href: download, target: '_blank', rel: 'noopener noreferrer' }, '打开官方下载')) : null) : null,
        snapshot?.job ? h('div', { className: 'dfy-notice dfy-dependency-job' + (snapshot.job.state === 'failed' ? ' dfy-error' : ''), role: 'status' },
          statusPill(jobStatus(snapshot.job), 'job'),
          h('div', { className: 'dfy-dependency-job-copy' },
            h('strong', null, names[snapshot.job.componentId] || snapshot.items.find((item) => item.id === snapshot.job.componentId)?.name || '组件操作'),
            h('p', null, jobMessage(snapshot.job)))) : null,
        snapshot ? h(React.Fragment, null,
          visible.map((item) => item.id === suite?.id ? qqSuite : ['napcat', 'linux-qq'].includes(item.id) ? null : standardResource(item)),
          h(Advanced, { title: '检查记录' }, h('p', { className: 'dfy-meta' }, '本机检测：', displayTime(snapshot.checkedAt), ' · 更新检查：', displayTime(snapshot.updatesCheckedAt))))
          : !failure ? h('div', { className: 'dfy-empty' }, '正在读取组件状态…') : null);
    }
    const capabilityCatalog = [
      ['computer', '文件与代码', '运行命令、处理项目文件和代码。', '查询电脑当前时间和系统版本。', 'dependencies'],
      ['desktop', '电脑操作', '查看电脑界面，并在授权范围内输入和点击。', '打开一个测试窗口，输入“你好”。', 'dependencies'],
      ['browser', '浏览网页', '打开网页、点击控件和填写表单。', '打开我指定的网站，查找页面上的按钮。', 'dependencies'],
      ['web', '搜索资料', '搜索资料并读取网页内容。', '搜索一个主题，并附上资料链接。', 'dependencies'],
      ['qq', 'QQ 消息', '接收已启用用户的私聊并回复。', '查询伴侣状态。', 'qq'],
      ['phone', '安卓手机', '按已授权范围查看和操作配对手机。', '截取当前手机画面。', 'phone'],
      ['voice-input', '语音接收', '把收到的语音转成文字后处理。', '向小号发送一段清晰的语音。', 'voice'],
      ['voice-output', '语音发送', '合成声音并按配置发送语音。', '用语音回复一句晚安。', 'voice'],
      ['memory', '记忆', '使用和管理共享记忆，写入需开启权限。', '记住这项偏好；也可以纠正或遗忘已有记忆。', 'memory'],
      ['memes', '表情包', '按含义选择表情包，并管理图库。', '找一个表示开心的表情包。', 'memes'],
      ['background', '后台任务', '把长任务放到后台，聊天时可查进度和取消。', '把只读项目分析交给后台，先告诉我任务编号。', 'background'],
    ];
    const capabilityStateLabels = { unknown: '待检查', disabled: '未开启', unavailable: '需要设置',
      ready: '已连接，待测试', verified: '可用', failed: '测试未通过', stale: '需要重新检查' };
    function CapabilitiesPanel({ active, probeBlocked, checkBlocked, runtimeBusy, onNavigate, onBusyChange, onUpdated }) {
      const api = usePanelApi();
      const [showTestArea, setShowTestArea] = useState(false);
      const testArea = useRef(null);
      const [controlInput, setControlInput] = useState('');
      const [controlReadback, setControlReadback] = useState('尚未验证');
      const [snapshot, setSnapshot] = useState(null);
      const [reading, setReading] = useState(false);
      const [operation, setOperation] = useState('');
      const [failure, setFailure] = useState('');
      const [notice, setNotice] = useState('');
      const readLock = useRef(false), mutationLock = useRef(false), attempted = useRef(false), latest = useRef({}), resultEpoch = useRef(0);
      latest.current = { snapshot, probeBlocked, checkBlocked, runtimeBusy };
      const busy = Boolean(operation) || snapshot?.busy === true;
      useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
      useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);
      function accept(result) {
        if (!result?.capabilities || !Array.isArray(result.capabilities.items)) throw new Error('invalid capability response');
        if (api.alive.current) setSnapshot(result.capabilities);
      }
      async function load() {
        if (readLock.current) return;
        attempted.current = true; readLock.current = true; setReading(true); setFailure('');
        const epoch = resultEpoch.current;
        try {
          const result = await api.call('capabilities');
          if (epoch !== resultEpoch.current) return;
          const refreshRuntime = result.capabilities?.busy === false
            && (latest.current.snapshot?.busy === true || latest.current.runtimeBusy === true);
          accept(result);
          if (refreshRuntime && api.alive.current) {
            try {
              const state = await api.call('state');
              if (epoch === resultEpoch.current && api.alive.current) onUpdated?.(state);
            } catch {
              if (epoch === resultEpoch.current && api.alive.current) setFailure('能力状态已刷新，但整体运行状态尚未确认；请刷新当前状态后核对。');
            }
          }
        }
        catch { if (api.alive.current) setFailure('能力状态读取失败，请点击“刷新能力”重试。已有结果仅供参考。'); }
        finally { readLock.current = false; if (api.alive.current) setReading(false); }
      }
      useEffect(() => { if (active && !attempted.current) load(); }, [active]);
      async function mutate(action, id) {
        const current = latest.current;
        const item = current.snapshot?.items?.find((candidate) => candidate.id === id);
        if (mutationLock.current || current.snapshot?.busy || action === 'probe' && (current.probeBlocked || item?.canProbe !== true)
          || action === 'check' && current.checkBlocked) return;
        mutationLock.current = true; resultEpoch.current++; setOperation(action === 'probe' ? id : 'check'); onBusyChange?.(true); setFailure(''); setNotice('');
        try {
          if (action === 'probe' && id === 'desktop') {
            setShowTestArea(true);
            if (typeof globalThis.requestAnimationFrame === 'function') await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
            testArea.current?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
          }
          if (action === 'probe' && typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('request id unavailable');
          const result = await api.call('capabilities/' + action, 'POST', action === 'probe'
            ? { id, requestId: globalThis.crypto.randomUUID() } : {}, 120000);
          resultEpoch.current++; accept(result);
          if (api.alive.current) {
            setNotice(action === 'check' ? '连接检查已结束。'
              : result.capabilities.busy ? '测试已开始，可以刷新查看结果。'
                : '测试已结束，请查看功能状态。');
            if (result.state) onUpdated?.(result.state);
          }
        } catch (error) {
          const response = error?.result;
          const knownFailure = response?.ok === false && ['FAILED', 'TIMEOUT', 'UNCONFIRMED', 'ACCESSIBILITY_REQUIRED',
            'DESKTOP_INIT_UNCONFIRMED', 'DESKTOP_TARGET_UNCONFIRMED', 'CANCELLED', 'CONFLICT',
            'STORAGE_UNAVAILABLE', 'UNAVAILABLE', 'DISABLED'].includes(response.code)
            && typeof response.capabilities?.busy === 'boolean' && Array.isArray(response.capabilities.items);
          if (api.alive.current && knownFailure) {
            resultEpoch.current++; accept(response);
            if (response.state) onUpdated?.(response.state);
            setFailure(action === 'check' ? '组件检测未通过，请查看当前记录和说明；不会自动重试。'
              : ['TIMEOUT', 'UNCONFIRMED', 'DESKTOP_INIT_UNCONFIRMED', 'DESKTOP_TARGET_UNCONFIRMED'].includes(response.code) ? '安全验证结果尚未确认，请查看当前记录和说明；不会自动重试。'
                : '安全验证未通过，请查看该项的结果和说明；不会自动重试。');
          } else if (api.alive.current) setFailure(action === 'probe'
            ? '安全验证未得到确认，请刷新能力核对结果；不会自动重试。'
            : '组件检测未得到确认，请刷新能力核对；不会自动重试。');
        } finally { mutationLock.current = false; if (api.alive.current) setOperation(''); }
      }
      const detected = Array.isArray(snapshot?.items) ? snapshot.items : [];
      return h('section', { className: 'dfy-section', 'aria-label': '大肥鱼能力' },
        h(SectionHeading, { title: '功能', help: '这里和大肥鱼使用同一份状态记录。打开页面和刷新只读取记录；检查连接查看安装和连接情况，试一下才会操作限定测试目标。' },
          h('button', { type: 'button', className: 'dfy-button', disabled: reading, onClick: load }, reading ? '刷新中…' : '刷新功能'),
          h('button', { type: 'button', className: 'dfy-button', disabled: busy || checkBlocked,
            onClick: () => mutate('check') }, operation === 'check' ? '检查中…' : '检查连接')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        busy ? h('p', { className: 'dfy-hint', role: 'status' }, '测试或清理正在进行，请稍候；完成后才能保存设置。') : null,
        probeBlocked ? h('p', { className: 'dfy-hint' }, '请先保存相关修改，等待当前任务结束后再测试。') : null,
        h('section', { ref: testArea, className: 'dfy-resource dfy-test-area', hidden: !showTestArea, 'aria-label': 'DSH 界面控制测试区' },
          h(SectionHeading, { title: '电脑测试区', help: '测试只在这里临时输入、点击并读回结果，不读取用户聊天、不发送 QQ、不操作手机。' },
            h('button', { type: 'button', className: 'dfy-link-button', disabled: busy, onClick: () => setShowTestArea(false) }, '收起测试区')),
          h('p', { className: 'dfy-hint' }, '正在验证输入和点击，请保持此区域可见。'),
          h('input', { className: 'dfy-input', type: 'text', value: controlInput, maxLength: 64,
            'aria-label': '大肥鱼电脑控制测试输入', autoComplete: 'off', spellCheck: false,
            onChange: (event) => setControlInput(event.target.value) }),
          h('button', { className: 'dfy-button', type: 'button', 'aria-label': '验证电脑输入',
            onClick: () => setControlReadback(/^DFY-CAP-[a-f0-9]{24}$/.test(controlInput) ? controlInput : '请输入本次验证标记') }, '验证电脑输入'),
          h('p', { role: 'status', 'aria-label': '电脑控制回读', className: 'dfy-hint' }, '电脑控制回读：' + controlReadback)),
        !snapshot ? h('p', { className: 'dfy-empty' }, reading ? '正在读取能力记录…' : '尚未读取能力记录。')
          : !detected.length ? h('p', { className: 'dfy-empty' }, '服务尚未返回能力记录。下方列出支持检查的范围，请刷新后重试。') : null,
        h('div', { className: 'dfy-feature-grid' }, capabilityCatalog.map(([id, title, description, example, section]) => {
          const item = detected.find((candidate) => candidate.id === id) || { id, title, description, examples: [example], present: null, available: null, state: 'unknown', section };
          const expired = item.expiresAt && Number.isFinite(new Date(item.expiresAt).getTime()) && new Date(item.expiresAt).getTime() <= Date.now();
          const state = item.state === 'verified' && expired ? 'stale' : item.state;
          const target = groupOfKey.has(item.section) && item.section !== 'capabilities' ? item.section : section;
          const tone = state === 'verified' ? 'good' : ['failed', 'stale', 'unavailable'].includes(state) ? 'warn' : 'neutral';
          const examples = Array.isArray(item.examples) && item.examples.length ? item.examples.filter((entry) => typeof entry === 'string').slice(0, 3) : [example];
          const attention = state === 'failed' ? item.verification?.code === 'ACCESSIBILITY_REQUIRED'
            ? '需要允许电脑控制权限，请到设置中处理。' : item.verification?.status === 'uncertain'
              ? '结果还未确认，请先核对目标页面，避免重复操作。' : '这项测试未完成，请查看详情或调整设置。'
            : state === 'unavailable' ? '尚未连接，完成设置后再试。' : '';
          return h('article', { className: 'dfy-feature-card', key: id, 'aria-label': '能力 ' + id },
            h('div', { className: 'dfy-feature-title' }, h('div', { className: 'dfy-titleline' }, h('strong', { className: 'dfy-resource-name' }, title),
              h(HelpTip, { label: title }, item.description || description, h('p', null, '例如：', examples[0] || example),
                ['computer','desktop','browser'].includes(id) ? h('p', null, '试一下只操作本页测试区或专用本地测试页，不读取用户聊天，不发送 QQ，不操作手机。') : null)),
              h('span', { className: 'dfy-badge dfy-' + tone }, state === 'failed' && item.verification?.status === 'uncertain' ? '结果待确认' : capabilityStateLabels[state] || capabilityStateLabels.unknown)),
            attention ? h('p', { className: 'dfy-hint', role: 'status' }, attention) : null,
            attention && item.nextStep ? h('p', { className: 'dfy-hint' }, item.nextStep) : null,
            h('div', { className: 'dfy-feature-actions' },
              item.canProbe === true ? h('button', { type: 'button', className: 'dfy-button', 'aria-label': '安全验证 ' + id,
                disabled: busy || probeBlocked, onClick: () => mutate('probe', id) }, operation === id ? '测试中…' : '试一下') : null,
              h('button', { type: 'button', className: item.canProbe === true ? 'dfy-link-button' : 'dfy-button', 'aria-label': '配置能力 ' + id,
                onClick: () => onNavigate?.(target) }, ['memes','memory','background'].includes(id) ? '打开' : '设置')),
            h(Advanced, { title: '高级详情' },
            h('div', { className: 'dfy-resource-details' },
              h('span', null, '组件：', h('strong', null, item.present === true ? '已检测到' : item.present === false ? '未检测到' : '尚未检测')),
              h('span', null, '就绪：', h('strong', null, item.available === true ? '当前就绪' : item.available === false ? '当前未就绪' : '尚未确认'))),
            ['computer', 'desktop', 'browser'].includes(id) && item.components && typeof item.components === 'object'
              ? h('div', { className: 'dfy-resource-details', 'aria-label': '能力组件 ' + id },
              [['skillVisible', 'DSH 技能', '可见', '不可见'], ['terminalVisible', 'DSH 终端', '可调用', '不可调用'],
                ['cliPresent', '控制组件', '已检测到', '未检测到'], ['accessibilityGranted', '辅助功能', '已授权', '未授权'],
                ['screenshotsGranted', '屏幕录制', '已授权', '未授权']]
                .filter(([key]) => own(item.components, key) && (id === 'desktop'
                  || id === 'browser' && ['skillVisible', 'terminalVisible', 'cliPresent'].includes(key)
                  || id === 'computer' && key === 'terminalVisible')
                  && (!item.components.backend || !['terminalVisible','screenshotsGranted'].includes(key))).map(([key, label, yes, no]) => h('span', { key }, label, '：',
                  h('strong', null, item.components[key] === true ? yes : item.components[key] === false ? no : '尚未确认'))),
              ['desktop', 'browser'].includes(id) && typeof item.components.version === 'string' && item.components.version ? h('span', null, '控制组件版本：',
                h('strong', null, item.components.version)) : null) : null,
            h('p', { className: 'dfy-hint' }, '本项检测：', item.checkedAt ? displayTime(item.checkedAt) : '尚未检测',
              ' · 最近实测：', item.verifiedAt ? displayTime(item.verifiedAt) : '尚未实际验证',
              item.expiresAt ? ' · 有效期至：' + displayTime(item.expiresAt) + (expired ? '（已过期）' : '') : ''),
            item.verification?.message ? h('p', { className: 'dfy-hint' }, '验证说明：', item.verification.message) : null,
            item.reason ? h('p', { className: 'dfy-hint' }, '当前说明：', item.reason) : null,
            item.nextStep ? h('p', { className: 'dfy-hint' }, '下一步：', item.nextStep) : null,
            h('details', { className: 'dfy-detail' }, h('summary', null, '怎么使用'),
              examples.map((entry, index) => h('p', { key: index, className: 'dfy-hint dfy-preserve-lines' }, '在 QQ 中可以说：', entry))),
            item.components?.backend ? h('p', { className: 'dfy-hint' }, '控制通道：', item.components.backend,
              id === 'browser' ? '（本地兼容修补版）' : '') : null,
            id === 'desktop' ? h('p', { className: 'dfy-hint' }, item.components?.backend
              ? '安全验证会在本页测试框内输入临时标记、点击验证按钮并读取结果。请保持 DSH 能力页可见。'
              : '安全验证在独立本机临时窗口中输入、点击并核对结果，仅覆盖该窗口。DSH 自身窗口可能被共享浮层遮蔽，读取不到目标时停止操作。') : null,
              item.stateText ? h('p', { className: 'dfy-hint' }, '原始状态：', state === 'stale' ? '实测已过期，需重验' : item.stateText) : null));
        })),
        h(Advanced, { title: '高级设置' },
          h('p', { className: 'dfy-hint' }, '最近组件检测：', snapshot?.checkedAt ? displayTime(snapshot.checkedAt) : '尚未检测'),
          snapshot?.controlBackend === 'dsh-plugins' ? h('p', { className: 'dfy-hint' }, '默认控制通道：DSH 专用电脑与浏览器插件。') : null,
          h('p', { className: 'dfy-hint' }, '检测到组件不代表实际操作已经通过。实测范围、时间和权限分别记录；记录过期后需要重新检查。')));
    }
    const conversationLabels = { idle: '等待新消息', queued: '排队中', running: '正在处理', failed: '最近处理失败', blocked: '已暂停，需核对后恢复' };
    const taskStatusLabels = { queued: '排队中', running: '正在执行', cancelling: '正在取消', succeeded: '执行完成', failed: '执行失败',
      cancelled: '已取消', unknown: '执行结果待核实' };
    const taskExecutorLabel = (name) => ({ native: 'DSH 原生子代理', spawn: 'DSH 原生子代理', codex: 'Codex', zcode: 'Z Code',
      minimax: 'MiniMax Code' })[name] || String(name || '尚未选择');
    function BackgroundTaskPanel({ snapshot, controlBlocked, testBlocked, refreshing, onRefresh, onUpdated }) {
      const api = usePanelApi();
      const [busy, setBusy] = useState('');
      const [failure, setFailure] = useState('');
      const [notice, setNotice] = useState('');
      const [verifiedStopped, setVerifiedStopped] = useState({});
      const lock = useRef(false);
      const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
      const latest = useRef({});
      latest.current = { tasks, controlBlocked, verifiedStopped };
      const verificationId = useRef('dfy-background-verification-' + Math.random().toString(36).slice(2));
      const detectedExecutors = Array.isArray(snapshot?.executors) ? snapshot.executors : [];
      const executors = ['native', 'codex', 'zcode', 'minimax'].map((name) => ({ name,
        ...detectedExecutors.find((item) => item.name === name || name === 'native' && item.name === 'spawn'), testName: name }));
      const count = (key) => Number.isFinite(snapshot?.[key]) ? String(snapshot[key]) : '尚未读取';
      const validTarget = (item) => typeof item?.id === 'string' && Boolean(item.id)
        && /^[1-9]\d{0,19}$/.test(item.scope?.peerId || '') && /^[A-Za-z0-9_-]{1,48}$/.test(item.scope?.identityId || '');
      const verificationKey = (item) => [item.id, item.scope?.selfId, item.scope?.peerId, item.scope?.identityId].join(':');
      const deliveryLabel = (item) => ({ sent: '已确认送达', sending: '正在确认送达', failed: '发送失败',
        unknown: '送达结果未知，不自动重发', pending: ['queued', 'running', 'cancelling'].includes(item.status)
          ? '任务结束后回传结果' : '等待发送' })[item.delivery] || '尚未确认';
      async function cancelTask(item) {
        if (lock.current || controlBlocked || item.canCancel !== true || !validTarget(item)) return;
        lock.current = true; setBusy(item.id); setFailure(''); setNotice('');
        try {
          const result = await api.call('tasks/cancel', 'POST', { taskId: item.id, qq: item.scope.peerId, identityId: item.scope.identityId });
          if (api.alive.current) {
            setNotice('取消请求已受理。任务是否停止以最新状态为准；此前已执行的操作不会自动撤销。');
            onUpdated?.(result.state);
          }
        } catch (error) {
          if (api.alive.current) setFailure(error?.name === 'AbortError'
            ? '取消请求未得到确认，请刷新核对任务状态；不会自动重试。' : '取消未得到确认，请刷新任务状态后核对。');
        } finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      async function testExecutor(name) {
        if (lock.current || controlBlocked || testBlocked || !['native', 'codex', 'zcode', 'minimax'].includes(name)) return;
        lock.current = true; setBusy('test:' + name); setFailure(''); setNotice('');
        try {
          if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('request id unavailable');
          const result = await api.call('tasks/test', 'POST', { executor: name, requestId: globalThis.crypto.randomUUID() });
          if (api.alive.current) {
            setNotice('连通测试已受理' + (result.task?.id ? '，任务编号 ' + result.task.id : '')
              + '。执行结果与 QQ 送达请分别查看任务记录；不会重复派发。');
            onUpdated?.(result.state);
          }
        } catch {
          if (api.alive.current) setFailure('连通测试未得到确认，请刷新核对任务状态；不会自动重试。');
        } finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      async function acknowledgeTask(item) {
        const key = verificationKey(item);
        const current = latest.current.tasks.find((candidate) => verificationKey(candidate) === key);
        if (lock.current || latest.current.controlBlocked || current?.requiresVerification !== true
          || !validTarget(current) || latest.current.verifiedStopped[key] !== true) return;
        lock.current = true; setBusy('ack:' + item.id); setFailure(''); setNotice('');
        setVerifiedStopped((previous) => ({ ...previous, [key]: false }));
        try {
          const result = await api.call('tasks/acknowledge', 'POST', {
            taskId: current.id, qq: current.scope.peerId, identityId: current.scope.identityId, confirmedStopped: true,
          });
          if (api.alive.current) {
            setNotice('工作区保护已解除；未重新执行此任务。');
            onUpdated?.(result.state);
          }
        } catch {
          if (api.alive.current) setFailure('解除保护未得到确认，请刷新核对；不会自动重试。');
        } finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const businessTasks = tasks.filter((item) => item.kind === 'task');
      const legacyTasks = tasks.filter((item) => !['task', 'connectivity-test'].includes(item.kind));
      const checks = tasks.filter((item) => item.kind === 'connectivity-test');
      const needsAttention = (item) => ['queued', 'running', 'cancelling', 'unknown'].includes(item.status)
        || item.requiresVerification === true || ['pending', 'sending', 'unknown', 'failed'].includes(item.delivery);
      const urgentChecks = checks.filter(needsAttention), archivedChecks = checks.filter((item) => !needsAttention(item));
      const renderTasks = (rows) => rows.map((item) => h('article', { className: 'dfy-suite-component', key: item.id, 'aria-label': '后台任务 ' + item.id },
          h('div', { className: 'dfy-resource-heading' }, h('strong', null, item.kind === 'connectivity-test' ? taskExecutorLabel(item.executor) + ' · 连接检查' : item.title || '未命名任务'),
            h('span', { className: 'dfy-badge' }, item.kind === 'connectivity-test' ? ({ succeeded: '检查完成', failed: '检查失败' })[item.status] || taskStatusLabels[item.status] || '状态未确认' : item.statusText || taskStatusLabels[item.status] || '状态未确认')),
          h('p', { className: 'dfy-meta' }, '协作助手：', taskExecutorLabel(item.executor), !['task', 'connectivity-test'].includes(item.kind) ? ' · 历史记录，来源未分类' : ''),
          item.progress ? h('p', { className: 'dfy-hint dfy-preserve-lines' }, '当前进度：', item.progress) : null,
          item.waitingForWorkspace === true ? h('p', { className: 'dfy-hint' }, '正在等待同一项目中的前一个任务结束。') : null,
          item.error ? h('p', { className: 'dfy-hint' }, '执行说明：', item.error) : null,
          h('p', { className: 'dfy-hint' }, 'QQ 结果送达：', deliveryLabel(item)),
          item.status === 'unknown' ? h('p', { className: 'dfy-hint' }, '部分操作可能已经执行，请先核实，再决定是否下达新任务。') : null,
          item.requiresVerification === true ? h('div', { className: 'dfy-notice dfy-warning', style: { marginTop: 8 } },
            h('p', null, '该工作区暂停后续写任务；先核实旧执行器已停止。确认只解除保护，不会重做此任务。'),
            h('label', { className: 'dfy-check-label', htmlFor: verificationId.current + '-' + item.id, style: { marginTop: 8 } },
              h('input', { id: verificationId.current + '-' + item.id, type: 'checkbox',
                'aria-label': '确认旧执行器已停止 ' + item.id,
                checked: verifiedStopped[verificationKey(item)] === true, disabled: Boolean(busy) || controlBlocked || !validTarget(item),
                onChange: (event) => {
                  if (lock.current || latest.current.controlBlocked || !validTarget(item)) return;
                  setVerifiedStopped((previous) => ({ ...previous, [verificationKey(item)]: event.target.checked === true }));
                } }), '我已核实旧执行器已停止'),
            h('button', { type: 'button', className: 'dfy-button', style: { marginTop: 8 },
              disabled: Boolean(busy) || controlBlocked || !validTarget(item) || verifiedStopped[verificationKey(item)] !== true,
              'aria-label': '解除工作区保护 ' + item.id, onClick: () => acknowledgeTask(item) },
            busy === 'ack:' + item.id ? '提交确认中…' : '解除工作区保护')) : null,
          h('div', { className: 'dfy-inline-actions', style: { marginTop: 10 } },
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked || item.canCancel !== true || !validTarget(item),
              'aria-label': '取消后台任务 ' + item.id, onClick: () => cancelTask(item) }, busy === item.id ? '取消请求中…' : '取消任务'),
            item.canCancel === true ? h(HelpTip, { label: '取消任务' }, '取消仅请求停止后续操作，已经完成的操作不会自动撤销。任务是否停止以刷新后的状态为准。') : null),
          item.canCancel === true ? h('p', { className: 'dfy-action-note' }, '取消不会撤销已完成的操作。') : null,
          item.text ? h(Advanced, { title: '查看结果' }, h('p', { className: 'dfy-preserve-lines' }, item.text)) : null,
          h(Advanced, { title: '高级详情' },
            item.kind === 'connectivity-test' ? h('p', { className: 'dfy-meta' }, '原始记录：', item.title || '未命名检查') : null,
            h('p', { className: 'dfy-meta' }, '编号 ', item.id, ' · 执行器 ', taskExecutorLabel(item.executor)),
            h('p', { className: 'dfy-meta' }, 'QQ ', item.scope?.peerId || '未确认', ' / 身份 ', item.scope?.identityId || '未确认',
              ' · 接收小号 ', item.scope?.selfId || '未确认'),
            h('p', { className: 'dfy-hint' }, '创建：', displayTime(item.createdAt), ' · 开始：', displayTime(item.startedAt), ' · 结束：', displayTime(item.finishedAt)))));
      return h('section', { className: 'dfy-section', 'aria-label': '后台任务状态与结果' },
        h(SectionHeading, { title: '任务', help: '把较长的事交给后台后，可以继续聊天。也可以在 QQ 中发送“任务列表”“查询任务 编号”或“取消任务 编号”。任务完成和 QQ 送达分别记录；打开本页不会启动任务。' },
          h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked || refreshing,
            onClick: () => onRefresh?.() }, refreshing ? '刷新中…' : '刷新任务')),
        snapshot?.ready !== true ? h('p', { className: 'dfy-hint', role: 'status' }, snapshot?.ready === false ? '后台任务尚未就绪，请到高级设置检查。' : '尚未读取后台任务，请点击刷新。') : null,
        snapshot ? h('p', { className: 'dfy-meta' }, '正在处理 ', count('running'), ' · 等待 ', count('queued'),
          Number(snapshot.pendingDelivery) > 0 ? ' · 等待回传 ' + count('pendingDelivery') : '',
          Number(snapshot.deliveryUnknown) > 0 ? ' · 送达待确认 ' + count('deliveryUnknown') : '') : null,
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        h('p', { className: 'dfy-meta' }, '协作助手：DSH 原生子代理 · Codex · Z Code · MiniMax Code'),
        h('section', { 'aria-label': '正式任务' },
          h('h4', null, '正式任务'),
          businessTasks.length ? renderTasks(businessTasks)
            : h('div', { className: 'dfy-empty' }, snapshot ? '还没有正式任务。在 QQ 中把一件较长的事交给大肥鱼即可。' : '尚未读取后台任务，请点击刷新。')),
        legacyTasks.length ? h('section', { 'aria-label': '来源未分类的历史记录' },
          h('h4', null, '历史记录（来源未分类）'), renderTasks(legacyTasks)) : null,
        urgentChecks.length ? h('section', { 'aria-label': '需要处理的连接检查' },
          h('h4', null, '需要处理的连接检查'),
          h('p', { className: 'dfy-hint' }, '这些检查仍在处理，或有执行、清理、送达结果需要核对。'), renderTasks(urgentChecks)) : null,
        checks.length ? h(Advanced, { title: '连接检查记录（' + checks.length + '）' },
          h('p', { className: 'dfy-hint' }, '这里保留各助手的历史连接检查。检查只核验能否接收任务，原始标题和回执在详情中保留。'),
          archivedChecks.length ? renderTasks(archivedChecks) : h('p', { className: 'dfy-meta' }, '需要处理的检查已在上方列出。')) : null,
        h(Advanced, { title: '高级设置' },
          h('p', { className: 'dfy-meta' }, '后台服务：', snapshot?.ready === true ? '已就绪' : snapshot?.ready === false ? '尚未就绪' : '尚未读取',
            ' · 活跃 ', count('active'), ' · 执行中 ', count('running'), ' · 排队 ', count('queued'),
            ' · 待回传 ', count('pendingDelivery'), ' · 送达未知 ', count('deliveryUnknown')),
          h('p', { className: 'dfy-hint' }, '任务执行结果和 QQ 送达分别记录。执行完成不代表 QQ 已收到；发送失败或送达未知不会自动重跑任务。'),
          h('h4', null, '执行器接入状态'),
          h('p', { className: 'dfy-hint' }, 'Z Code / MiniMax Code 默认只读。安装检测通过不等于已登录或已验证实际调用；权限范围以执行器配置为准。'),
          h('p', { className: 'dfy-hint' }, '点击“测试连通”会发起固定的只读测试任务，并把结果发给当前绑定主人 QQ。使用当前生效配置，可能产生少量模型用量。'),
          !detectedExecutors.length ? h('p', { className: 'dfy-hint' }, '服务尚未返回执行器检测结果。') : null,
          executors.map((executor) => h('div', { className: 'dfy-readonly', key: executor.testName, style: { flexWrap: 'wrap' } },
            h('span', null, taskExecutorLabel(executor.name)),
            h('span', { style: { flex: '1 1 210px', minWidth: 0 } }, executor.available == null ? '尚未检测' : executor.available !== true ? '当前不可用'
              : executor.verified === true ? '已验证可调用' : '已检测到，实际调用尚未验证',
              executor.reason ? h('span', { className: 'dfy-hint', style: { display: 'block' } }, executor.reason) : null),
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked || testBlocked,
              'aria-label': '测试连通 ' + taskExecutorLabel(executor.testName), onClick: () => testExecutor(executor.testName) },
            busy === 'test:' + executor.testName ? '提交测试中…' : '测试连通'))),
          testBlocked ? h('p', { className: 'dfy-hint' }, '当前有任务或配置应用正在进行，结束后可测试连通；运行中的任务仍可取消。') : null));
    }
    const conversationFailures = { queue_full: '等待队列已满', queue_expired: '等待时间过长，未执行', prepare_failed: '消息准备失败，尚未调用模型',
      unsupported_input: '当前 QQ 文件读取尚未接入，未读取附件、未调用模型；请直接发送需要处理的文字。',
      empty_input: '消息没有可处理的文字内容，尚未调用模型；请补充内容后发送一条新消息。',
      unsupported_message: '这条消息含尚不支持或过大的内容，整条消息尚未处理；其中的文字命令也未执行。',
      image_unavailable: '图片已到 QQ，但当前图片通道或选中模型暂不能读取，尚未调用模型；不必反复重发，可暂用文字说明。',
      image_input_failed: '图片已到 QQ，但本次读取未完成，尚未调用模型；请查看图片接入状态，不必反复重发。',
      model_failed: '模型处理失败', context_required: '上下文接近容量保护线，已暂停',
      context_compaction_failed: '上下文压缩未完成，已暂停', context_guard_unavailable: '上下文容量暂时无法确认，已暂停',
      timeout: '处理超时，执行结果未知', stopped: '已手动停止', send_failed: 'QQ 明确返回发送失败',
      delivery_unknown: 'QQ 送达结果未知', session_failed: '会话启动失败', identity_changed: '账号或身份已变化',
      voice_input_failed: '语音识别未完成', voice_disabled: '语音识别未开启', connection_changed: 'QQ 连接已变化',
      cancelled: '任务已取消', dedup_full: '消息去重暂时限流，稍后自动恢复' };
    function ConversationPanel({ conversations, accounts, recoveryBlocked, controlBlocked, onUpdated, onNavigate, onNotice }) {
      const api = usePanelApi();
      const [busy, setBusy] = useState('');
      const [failure, setFailure] = useState('');
      const [notice, setNotice] = useState('');
      const [acknowledged, setAcknowledged] = useState({});
      const lock = useRef(false);
      const latest = useRef(null);
      latest.current = { conversations, recoveryBlocked, controlBlocked, acknowledged };
      function keyFor(item) { return item.qq + ':' + item.identityId + ':' + (item.failedAt || '') + ':' + (item.failureType || '') + ':' + (item.controlVersion || ''); }
      async function control(item, action) {
        const recovering = action === 'recover' || action === 'fresh';
        const current = latest.current.conversations.find((value) => value.qq === item.qq && value.identityId === item.identityId);
        if (!api.alive.current || !current || keyFor(current) !== keyFor(item) || lock.current || latest.current.controlBlocked
          || action === 'stop' && !current.canStop || recovering && (!current.canRecover || latest.current.recoveryBlocked
            || current.requiresUncertainAcknowledgement && !latest.current.acknowledged[keyFor(current)])) return;
        if (action === 'fresh' && !['context_required', 'context_compaction_failed', 'context_guard_unavailable'].includes(item.failureType)) return;
        lock.current = true; setBusy(item.qq + ':' + item.identityId + ':' + action); setFailure(''); setNotice('');
        try {
          const result = await api.call('conversations/' + (action === 'fresh' ? 'recover' : action), 'POST', { qq: item.qq, identityId: item.identityId,
            ...(recovering ? { acknowledgeUncertain: latest.current.acknowledged[keyFor(current)] === true,
              ...(typeof current.controlVersion === 'string' ? { controlVersion: current.controlVersion } : {}) } : {}),
            ...(action === 'fresh' ? { freshSession: true } : {}) });
          if (api.alive.current) {
            const message = action === 'stop' ? '已处理此会话的停止请求；不会重放消息，请核对最新状态。'
              : result.result?.freshSession === true ? '已结束旧上下文；下一条新消息将使用新会话，原请求未重跑。'
                : '此会话已恢复接收后续新消息；未重新执行此前请求。';
            setNotice(message); onNotice?.(message);
            setAcknowledged((previous) => ({ ...previous, [keyFor(item)]: false })); onUpdated?.(result.state);
          }
        } catch (error) { if (api.alive.current) setFailure(resourceError(error)); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      return h('section', { className: 'dfy-section', 'aria-label': '逐账号会话状态' },
        h(SectionHeading, { title: '聊天状态', help: '每个聊天对象独立处理消息。停止会取消当前处理和排队消息；恢复只接收后续新消息，不会自动重发或重新执行旧请求。' },
          h('button', { type: 'button', className: 'dfy-button', onClick: () => onNavigate?.('accounts') }, '管理聊天对象')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        conversations.length ? conversations.map((item) => {
          const account = accounts.find((candidate) => candidate.qq === item.qq);
          const name = account?.name || item.qq, label = name + ' / ' + (item.identityName || item.identityId);
          const uncertain = item.requiresUncertainAcknowledgement === true;
          const needsInput = conversationNeedsInput(item);
          const contextPaused = ['context_required', 'context_compaction_failed', 'context_guard_unavailable'].includes(item.failureType);
          return h('article', { className: 'dfy-suite-component', key: item.qq + ':' + item.identityId, 'aria-label': '会话 ' + label },
            h('div', { className: 'dfy-resource-heading' }, h('strong', null, label),
              h('span', { className: 'dfy-badge' }, uncertain ? '执行或送达结果未知' : needsInput ? '消息未处理' : conversationLabels[item.state] || '状态未确认')),
            h('p', { className: 'dfy-hint' }, '排队 ', item.queued || 0, ' 项 · ', item.running ? '正在处理' : '当前没有执行中的任务'),
            item.failureType ? h('p', { className: 'dfy-hint' }, '最近结果：', conversationFailures[item.failureType] || '处理未完成',
              uncertain ? '，请核对后恢复。' : '') : null,
            uncertain ? h('label', { className: 'dfy-toggle' }, h('span', { className: 'dfy-toggle-copy' },
              h('span', { className: 'dfy-toggle-title' }, '我已核对之前的执行或送达结果，知道恢复不会自动重放消息')),
              h('input', { type: 'checkbox', checked: acknowledged[keyFor(item)] === true, disabled: Boolean(busy) || controlBlocked,
                'aria-label': '确认恢复未知结果会话 ' + label, onChange: (event) => setAcknowledged((previous) => ({ ...previous, [keyFor(item)]: event.target.checked })) })) : null,
            needsInput ? h(React.Fragment, null,
              h('p', { className: 'dfy-hint' }, '聊天未暂停，可直接发送一条新的文字消息；原消息不会自动重跑。'),
              item.canStop ? h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked,
                'aria-label': '停止会话 ' + label, onClick: () => control(item, 'stop') }, busy === item.qq + ':' + item.identityId + ':stop' ? '停止中…' : '停止处理') : null)
              : h('div', { className: 'dfy-inline-actions', style: { marginTop: 10 } },
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked || !item.canStop,
                'aria-label': '停止会话 ' + label, onClick: () => control(item, 'stop') }, busy === item.qq + ':' + item.identityId + ':stop' ? '停止中…' : '停止处理'),
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked || recoveryBlocked || !item.canRecover
                || uncertain && !acknowledged[keyFor(item)], 'aria-label': '恢复会话 ' + label,
                onClick: () => control(item, 'recover') }, busy === item.qq + ':' + item.identityId + ':recover' ? '恢复中…' : '恢复聊天'),
              item.canStop ? h(HelpTip, { label: '停止处理' }, '只停止当前聊天对象的处理和排队消息，已完成的操作不会自动撤销。') : null),
            contextPaused ? h('div', { className: 'dfy-inline-actions', style: { marginTop: 10 } },
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || controlBlocked || recoveryBlocked || !item.canRecover
                || uncertain && !acknowledged[keyFor(item)], 'aria-label': '新会话继续 ' + label,
                onClick: () => control(item, 'fresh') }, busy === item.qq + ':' + item.identityId + ':fresh' ? '处理旧会话中…' : '用新会话接收后续消息'),
              h('p', { className: 'dfy-hint' }, '压缩后可尝试恢复原聊天；也可结束旧上下文，从下一条新消息开始。私人记忆仍按当前账号和身份检索，原请求与排队消息都不会重跑。')) : null,
            recoveryBlocked && item.canRecover && !needsInput ? h('p', { className: 'dfy-hint' }, '请先保存修改，再恢复聊天。仍可停止当前处理。') : null,
            h(Advanced, { title: '高级详情' },
              h('p', { className: 'dfy-hint' }, 'QQ ', item.qq, ' · 身份 ', item.identityId),
              h('p', { className: 'dfy-hint' }, '最近收到：', displayTime(item.lastEventAt), ' · 最近回复完成：', displayTime(item.lastReplyAt)),
              item.failureType ? h('p', { className: 'dfy-hint' }, needsInput ? '最近未处理：' : '最近异常：', item.failureType, ' · ', displayTime(item.failedAt)) : null));
        }) : h('div', { className: 'dfy-empty' }, '尚无会话任务记录。配置并启用用户后，新消息的处理状态会显示在这里。'));
    }
    function AccountIdentityPanel({ accounts, ownerQq, engine, onChange, onOwnerChange, disabled, ownerDisabled, readOnlyReason, errors }) {
      const [selectedAccount, setSelectedAccount] = useState(0);
      const [selectedIdentity, setSelectedIdentity] = useState('');
      const formId = useRef('dfy-accounts-' + Math.random().toString(36).slice(2));
      const accountIndex = Math.min(Math.max(0, selectedAccount), Math.max(0, accounts.length - 1));
      const account = accounts[accountIndex];
      const identity = account?.identities?.find((item) => item.id === selectedIdentity)
        || account?.identities?.find((item) => item.id === account.activeIdentityId) || account?.identities?.[0];
      const relationSelection = presentedRelationType(identity);
      const primaryIndex = accounts.findIndex((item) => item.qq === ownerQq);
      const primary = Boolean(account && accountIndex === primaryIndex);
      const copy = () => accounts.map((item) => ({ ...item, identities: item.identities.map((candidate) => ({ ...candidate })) }));
      function editAccount(patch) {
        if (disabled || !account) return;
        const next = copy(); next[accountIndex] = { ...next[accountIndex], ...patch }; onChange(next);
      }
      function editIdentity(patch) {
        if (disabled || !account || !identity) return;
        const candidate = { ...identity, ...patch };
        editAccount({ identities: account.identities.map((item) => item.id === identity.id ? candidate : item) });
      }
      function addAccount() {
        if (disabled || accounts.length >= 20) return;
        const first = freshIdentity(); first.name = '默认身份';
        onChange([...copy(), { qq: '', name: '新账号', enabled: true, activeIdentityId: first.id, identities: [first] }]);
        setSelectedAccount(accounts.length); setSelectedIdentity(first.id);
      }
      function removeAccount() {
        if (disabled || primary || !account) return;
        onChange(copy().filter((_item, index) => index !== accountIndex));
        setSelectedAccount(Math.max(0, accountIndex - 1)); setSelectedIdentity('');
      }
      function addIdentity() {
        if (disabled || !account || account.identities.length >= 12) return;
        const next = freshIdentity(); editAccount({ identities: [...account.identities, next] }); setSelectedIdentity(next.id);
      }
      function removeIdentity() {
        if (disabled || !identity || account.identities.length < 2) return;
        const next = account.identities.filter((item) => item.id !== identity.id);
        editAccount({ identities: next, activeIdentityId: account.activeIdentityId === identity.id ? next[0].id : account.activeIdentityId });
        setSelectedIdentity(next.find((item) => item.id === account.activeIdentityId)?.id || next[0].id);
      }
      function input(key, label, help, options = {}) {
        const target = options.account ? account : identity;
        const id = formId.current + '-' + (options.account ? 'account-' : 'identity-') + key;
        const props = { id, value: target?.[key] || '', maxLength: options.maxLength || 80, disabled: disabled || options.disabled,
          'aria-describedby': help ? id + '-hint' : undefined,
          onChange: (event) => options.account ? editAccount({ [key]: event.target.value }) : editIdentity({ [key]: event.target.value }) };
        return h('div', { className: 'dfy-field', key: id },
          h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: id }, label),
            help ? h(HelpTip, { label }, h('span', { id: id + '-hint' }, help)) : null),
          options.multiline ? h('textarea', { ...props, className: 'dfy-meme-text', rows: 4 })
            : h('input', { ...props, type: 'text', autoComplete: 'off', ...(options.qq ? { inputMode: 'numeric', maxLength: 20 } : {}) }));
      }
      return h(React.Fragment, null,
        h('section', { className: 'dfy-section', 'aria-label': '主要账号' },
          h(SectionHeading, { title: '你的 QQ', help: '这个账号可以使用私人记忆和已授权的功能；其他聊天对象只参与各自的对话。请填写用来给接收小号发消息的常用 QQ。' }),
          h('div', { className: 'dfy-field', style: { maxWidth: 400 } },
            h('label', { className: 'dfy-label', htmlFor: formId.current + '-owner' }, 'QQ 号'),
            h('input', { id: formId.current + '-owner', type: 'text', inputMode: 'numeric', maxLength: 20,
              autoComplete: 'off', value: ownerQq || '', disabled: ownerDisabled || disabled,
              onChange: (event) => onOwnerChange(event.target.value) }),
            ownerDisabled ? h('p', { className: 'dfy-hint' }, '此号码由管理员设置，无法在这里修改。') : null)),
        h('section', { className: 'dfy-section', 'aria-label': '用户账号与身份' },
          h(SectionHeading, { title: '聊天对象', help: '所有聊天对象共用一个接收小号。每个人可以保留多套身份，选择其中一套聊天；关系会影响说话方式和称呼，不会改变私人记忆或设备权限。' },
            h('button', { type: 'button', className: 'dfy-button', disabled: disabled || accounts.length >= 20, onClick: addAccount }, '添加用户账号')),
          engine === 'legacy' ? h('div', { className: 'dfy-notice dfy-warning', role: 'alert' },
            '当前聊天服务不支持多用户和自定义关系，请先切换聊天服务。',
            h(Advanced, { title: '高级设置' }, h('p', { className: 'dfy-hint' }, '当前消息引擎为 legacy；需在宿主配置中将 onebotEngine 改为 native。'))) : null,
          readOnlyReason ? h('div', { className: 'dfy-notice' }, readOnlyReason) : null,
          errors.length ? h('div', { className: 'dfy-notice dfy-warning', role: 'alert' },
            h('strong', null, '请补齐后保存'), h('ul', null, errors.map((message, index) => h('li', { key: index }, message)))) : null,
          h('div', { className: 'dfy-account-layout' },
            h('div', { className: 'dfy-account-list', 'aria-label': '选择用户账号' }, accounts.map((item, index) => {
              const activeIdentity = item.identities.find((candidate) => candidate.id === item.activeIdentityId);
              return h('button', { key: index, type: 'button', className: 'dfy-button dfy-account-choice',
                'aria-pressed': accountIndex === index, onClick: () => { setSelectedAccount(index); setSelectedIdentity(''); } },
              h('strong', null, item.name || '未命名账号', index === primaryIndex ? ' · 主要' : ''),
              h('span', null, item.qq || '待填写 QQ'), h('span', null, item.enabled ? '接收开启' : '接收关闭', ' · ', activeIdentity?.name || '未选择身份'));
            })),
            account ? h('div', null,
              h('div', { className: 'dfy-grid' },
                input('name', '账号备注', '便于识别账号，不作为对话角色。', { account: true }),
                input('qq', '用户 QQ', primary ? '主要账号请在上方单独修改。' : '仅接收此账号发给小号的私聊。', { account: true, qq: true, disabled: primary })),
              h('div', { className: 'dfy-toggle' },
                h('div', { className: 'dfy-toggle-copy dfy-titleline' }, h('label', { className: 'dfy-toggle-title', htmlFor: formId.current + '-enabled' }, '接收此账号的私聊'),
                  h(HelpTip, { label: '接收消息' }, '关闭后忽略这个账号的新消息，身份设置仍会保留。')),
                h('input', { id: formId.current + '-enabled', type: 'checkbox', checked: account.enabled === true, disabled,
                  onChange: (event) => editAccount({ enabled: event.target.checked }) })),
              account.enabled !== true ? h('p', { className: 'dfy-hint' }, '保存后，将不再回复这个账号的新消息；身份设置仍会保留。') : null,
              h('div', { className: 'dfy-inline-actions', style: { marginTop: 10 } },
                !primary ? h('button', { type: 'button', className: 'dfy-button', disabled: disabled || ownerDisabled || !/^[1-9]\d{0,19}$/.test(account.qq || ''),
                  onClick: () => onOwnerChange(account.qq, true) }, '设为主要账号') : null,
                h('button', { type: 'button', className: 'dfy-button', disabled: disabled || primary, onClick: removeAccount }, '删除此账号'),
                primary ? h(HelpTip, { label: '删除账号' }, '主要账号不能直接删除。需要更换时，先将另一个账号设为主要账号。') : null),
              !primary ? h('p', { className: 'dfy-hint' }, '删除账号并保存生效后，将不再接收这个账号的新消息。') : null,
              h('div', { className: 'dfy-identity-editor' },
                h('div', { className: 'dfy-toolbar', style: { marginTop: 0 } },
                  h('h3', null, '聊天身份'),
                  h('button', { type: 'button', className: 'dfy-button', disabled: disabled || account.identities.length >= 12, onClick: addIdentity }, '添加身份')),
                h('div', { className: 'dfy-identity-list', 'aria-label': '选择要编辑的身份' }, account.identities.map((item) =>
                  h('button', { key: item.id, type: 'button', className: 'dfy-button dfy-identity-choice', 'aria-pressed': item.id === identity?.id,
                    onClick: () => setSelectedIdentity(item.id) }, item.name || '未命名身份', item.id === account.activeIdentityId ? ' · 已选定' : ''))),
                identity ? h(React.Fragment, null,
                  h('div', { className: 'dfy-grid' }, input('name', '身份名称', '例如日常自己、船长、爸爸；可自由命名。'),
                    h('div', { className: 'dfy-field' },
                      h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: formId.current + '-relation' }, '与大肥鱼的关系'),
                        h(HelpTip, { label: '关系' }, '选择关系后即可使用。选择自定义时，请在下方填写相处说明。')),
                      h('select', { id: formId.current + '-relation', value: relationSelection, disabled,
                        onChange: (event) => { const preset = relationPresets.find((item) => item.id === event.target.value);
                          if (preset) editIdentity({ relationType: preset.id, userRole: preset.userRole, companionRole: preset.companionRole,
                            userTitle: preset.userTitle, companionTitle: preset.companionTitle }); } },
                      relationPresets.map((preset) => h('option', { value: preset.id, key: preset.id }, preset.name))))),
                  input('description', '身份与相处说明', relationSelection === 'custom'
                    ? '在这里说明自定义关系、性格与相处习惯。'
                    : '可补充性格、背景和相处习惯。', { multiline: true, maxLength: 1000 }),
                  h('div', { className: 'dfy-toolbar' },
                    h('span', { className: 'dfy-meta' }, identity.id === account.activeIdentityId ? '当前聊天身份' : '尚未选为聊天身份'),
                    h('div', { className: 'dfy-inline-actions' },
                      h('button', { type: 'button', className: 'dfy-button', disabled: disabled || account.identities.length < 2, onClick: removeIdentity }, '删除此身份'),
                      h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: disabled || identity.id === account.activeIdentityId,
                        onClick: () => editAccount({ activeIdentityId: identity.id }) }, '使用此身份')),
                    account.identities.length > 1 && identity.id === account.activeIdentityId
                      ? h('p', { className: 'dfy-hint' }, '删除当前聊天身份并保存生效后，将改用其他身份。') : null)) : null))
              : h('div', { className: 'dfy-empty' }, '还没有聊天对象，请先添加账号。')),
          engine !== 'legacy' ? h('p', { className: 'dfy-hint' }, '保存时会重新连接 QQ。') : null));
    }
    // 首页 QQ 卡片的显式二维码入口：点一下就把码拿到首页，不用先进 QQ账号页。
    // 保持项目边界：打开页面只读，登录凭据只在明确点击后才获取。
    function HomeQrInline() {
      const api = usePanelApi();
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [qr, setQr] = useState(null);
      const [failure, setFailure] = useState('');
      useEffect(() => { if (!open) { setQr(null); setFailure(''); } }, [open]);
      async function show() {
        if (busy) return;
        setBusy(true); setFailure('');
        try {
          const result = await api.call('napcat/qrcode', 'POST', { refresh: false });
          setQr(result.qrcode || null);
        } catch (error) { setFailure('暂时取不到二维码，可到 QQ账号页查看登录状态。'); }
        finally { setBusy(false); }
      }
      return h('div', { style: { marginTop: 12 } },
        !open ? h('button', { type: 'button', className: 'dfy-button', onClick: () => { setOpen(true); show(); } }, '显示登录二维码') : h(React.Fragment, null,
          busy && !qr ? h('p', { className: 'dfy-hint' }, '正在获取登录二维码…') : null,
          failure ? h('p', { className: 'dfy-hint' }, failure) : null,
          qr?.available && qr.image?.mime === 'image/png' ? h(React.Fragment, null,
            h('img', { src: 'data:image/png;base64,' + qr.image.base64, alt: '接收小号的 QQ 登录二维码',
              style: { width: 180, height: 180, display: 'block', borderRadius: 8, border: '1px solid rgba(127,127,127,.35)', marginTop: 8 } }),
            h('p', { className: 'dfy-hint', style: { marginTop: 6 } }, qr.note || '用接收小号的手机 QQ 扫码登录；电脑上的同号 QQ 请先退出。')) : null));
    }
    function NapCatPanel({ active, expectedSelfId, refreshKey, onNavigate }) {
      const api = usePanelApi();
      const [status, setStatus] = useState(null);
      const [checking, setChecking] = useState(false);
      const [qrBusy, setQrBusy] = useState('');
      const [qr, setQr] = useState(null);
      const [failure, setFailure] = useState('');
      const [qrFailure, setQrFailure] = useState('');
      const statusGeneration = useRef(0);
      const qrGeneration = useRef(0);
      const qrLock = useRef(false);
      const statusLock = useRef(false);
      const shownQr = useRef(null);
      shownQr.current = qr;
      const offlineNotes = {
        LOGIN_SELF_OFFLINE: 'QQ 当前离线，具体原因尚未确认。请稍后检查状态。',
        LOGIN_KICKED_OFFLINE: 'QQ 报告登录已断开，具体原因尚未确认。请检查状态后再决定是否重新登录。',
      };
      function unconfirmedLoginNote(value) {
        if (!value) return '正在读取登录状态，请稍候。';
        if (value.webui?.reachable !== true || value.webui?.authenticated !== true)
          return '管理状态暂未确认，不能据此判断 QQ 是否已离线。请稍后检查状态。';
        if (value.login?.phase === 'reconnecting') return '正在恢复连接，请等待状态更新后再决定是否需要登录。';
        if (offlineNotes[value.login?.issue?.code]) return offlineNotes[value.login.issue.code];
        if (value.login?.isLogin !== true && !value.login?.qrLoginAccepted
          && !['qrcode_scanned', 'generating_qrcode', 'initializing'].includes(value.login?.phase)
          && (typeof value.login?.isLogin !== 'boolean' || value.login?.phase === 'unknown'))
          return 'QQ 登录状态尚未确认，请稍后检查状态。';
        return '';
      }
      async function check(background = false) {
        if (statusLock.current || qrLock.current) return;
        const generation = ++statusGeneration.current;
        statusLock.current = true;
        if (!background) setChecking(true);
        setFailure('');
        try {
          const result = await api.call('napcat/status');
          if (!result.napcat || typeof result.napcat !== 'object') throw new Error('容器状态响应不完整');
          if (api.alive.current && generation === statusGeneration.current) {
            setStatus(result.napcat);
            if (result.napcat.login?.isLogin === true) {
              qrGeneration.current++; qrLock.current = false; setQr(null); setQrBusy(''); setQrFailure('');
            } else if (shownQr.current?.available && shownQr.current.revision !== result.napcat.login?.qrcodeRevision) {
              qrGeneration.current++; qrLock.current = false; setQrBusy(''); setQrFailure('');
              setQr({ available: false, note: unconfirmedLoginNote(result.napcat) || result.napcat.login?.issue?.note
                || (result.napcat.login?.phase === 'qrcode_scanned' ? '手机已扫码，请在手机上确认登录。'
                  : result.napcat.login?.phase === 'initializing' ? '手机确认已接收，正在准备登录。'
                    : '二维码已经失效或更新，请获取当前二维码。') });
            }
          }
        } catch (error) {
          if (api.alive.current && generation === statusGeneration.current) {
            setFailure('管理状态暂未确认，请稍后再检查。');
            if (shownQr.current?.available) setQr({ available: false, note: '无法确认二维码是否仍有效，旧图已收起。请检查登录状态后重新获取。' });
          }
        }
        finally {
          statusLock.current = false;
          if (api.alive.current && generation === statusGeneration.current) setChecking(false);
        }
      }
      useEffect(() => {
        let stopped = false, timer;
        async function poll() {
          if (stopped || !active) return;
          if (typeof document === 'undefined' || !document.hidden) await check(true);
          if (!stopped) timer = setTimeout(poll, 5000);
        }
        if (active) { check(); timer = setTimeout(poll, 5000); }
        return () => {
          stopped = true; clearTimeout(timer);
          statusGeneration.current++; qrGeneration.current++; qrLock.current = false;
          statusLock.current = false;
          api.cancel(); setQr(null); setQrBusy(''); setChecking(false);
        };
      }, [active, refreshKey]);
      async function getQr(refresh) {
        if (qrLock.current || (refresh ? !canRefresh : !canQr)) return;
        const generation = ++qrGeneration.current;
        statusGeneration.current++; setChecking(false);
        qrLock.current = true; setQrBusy(refresh ? 'refresh' : 'read'); setQr(null); setQrFailure('');
        try {
          const result = await api.call('napcat/qrcode', 'POST', { refresh });
          const image = result.qrcode?.image;
          if (result.qrcode?.available && (!/^[a-f0-9]{64}$/.test(result.qrcode.revision || '') || !image || image.mime !== 'image/png'
            || typeof image.base64 !== 'string' || !image.base64 || image.base64.length > 3 * 1024 * 1024)) {
            throw new Error('二维码图片格式或大小不符合预期');
          }
          if (api.alive.current && generation === qrGeneration.current) setQr(result.qrcode || { available: false, note: '暂时没有可用二维码' });
        } catch (error) { if (api.alive.current && generation === qrGeneration.current) setQrFailure(resourceError(error)); }
        finally {
          if (generation === qrGeneration.current) {
            qrLock.current = false;
            if (api.alive.current) setQrBusy('');
          }
        }
      }
      const loggedIn = status?.login?.isLogin === true;
      const canRefresh = status?.container?.running === true && status?.webui?.authenticated === true
        && status?.login?.isLogin === false && !['qrcode_scanned', 'initializing'].includes(status?.login?.phase);
      const canQr = canRefresh && status?.login?.phase === 'waiting_qrcode'
        && /^[a-f0-9]{64}$/.test(status?.login?.qrcodeRevision || '') && !status?.login?.issue;
      const managementUnconfirmed = Boolean(status && (failure || status.webui?.reachable !== true || status.webui?.authenticated !== true));
      const loginNote = failure ? '管理状态暂未确认，不能据此判断 QQ 是否已离线。请稍后检查状态。' : unconfirmedLoginNote(status);
      const loginLabel = !status ? '尚未读取' : managementUnconfirmed ? '管理状态未确认' : loggedIn
        ? status.login.isOffline ? '已登录，当前离线' : status.login.coreReady ? '已登录' : '已登录，正在连接'
        : status.login?.phase === 'reconnecting' ? '正在恢复连接'
          : status.login?.issue?.code === 'LOGIN_SELF_OFFLINE' ? 'QQ 暂时离线'
          : status.login?.issue?.code === 'LOGIN_KICKED_OFFLINE' ? 'QQ 登录已断开'
        : status.login?.issue?.code === 'QR_EXPIRED' ? '二维码已过期'
          : status.login?.issue?.code === 'LOGIN_REJECTED' ? '登录被拒绝'
            : status.login?.issue?.code === 'LOGIN_NETWORK_UNAVAILABLE' ? '登录网络异常'
              : status.login?.phase === 'qrcode_scanned' ? '已扫码，等待手机确认'
                : status.login?.phase === 'generating_qrcode' ? '正在生成二维码'
                  : status.login?.qrLoginAccepted ? '扫码已确认，等待登录'
                    : typeof status.login?.isLogin !== 'boolean' || status.login?.phase === 'unknown' ? '登录状态未确认'
                      : status.login?.isLogin === false ? '尚未登录' : '登录状态未知';
      const cell = (label, value) => h('div', { className: 'dfy-state-cell', key: label }, h('span', null, label), h('strong', null, value));
      return h('section', { className: 'dfy-section' },
        h(SectionHeading, { title: 'QQ登录', help: '使用接收小号扫码登录。此处显示小号的登录状态；能否正常聊天还取决于聊天连接。检查状态不会自动登录、退出或刷新二维码。' },
          h('button', { className: 'dfy-button', type: 'button', disabled: checking || Boolean(qrBusy), onClick: () => check() }, checking ? '检查中…' : '检查')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        status ? h(React.Fragment, null,
          h('div', { className: 'dfy-readonly' }, h('span', null, '登录状态'), h('strong', null, loginLabel)),
          expectedSelfId || status.login?.accountId ? h('div', { className: 'dfy-readonly' }, h('span', null, '接收小号'),
            h('span', null, status.login?.accountId || expectedSelfId)) : null,
          status.login?.selfMatches === false ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, '登录账号与绑定小号不一致，不能接入伴侣。请核对账号。') : null,
          status.login?.issue?.note ? h('div', { className: 'dfy-notice dfy-warning', role: 'alert' }, loginNote || status.login.issue.note) : null,
          !status.configured ? h('p', { className: 'dfy-notice dfy-warning' }, 'QQ 服务尚未配置，请先到“安装与更新”完成安装。')
            : !status.container?.available ? h('p', { className: 'dfy-notice dfy-warning' }, 'QQ 运行环境暂时不可用，请先到“安装与更新”检查。')
              : !status.container.running ? h('p', { className: 'dfy-notice dfy-warning' }, 'QQ 服务未启动，请到“安装与更新”启动后扫码。')
                : !status.webui?.reachable ? h('p', { className: 'dfy-notice dfy-warning' }, 'QQ 登录服务尚未连接，请稍后再检查。持续失败时可到“安装与更新”检查服务。')
                  : !status.webui.authenticated ? h('p', { className: 'dfy-notice dfy-warning' }, 'QQ 管理状态暂未确认，请稍后再检查。') : null,
          status.error ? h('div', { className: 'dfy-notice dfy-warning', style: { marginTop: 12 } },
            loginNote || (typeof status.error === 'string' ? status.error : status.error.message || '状态读取不完整，请重新检查')) : null,
          onNavigate && (!status.configured || !status.container?.available || !status.container?.running || !status.webui?.reachable || !status.webui?.authenticated)
            ? h('button', { className: 'dfy-button', type: 'button', onClick: () => onNavigate('dependencies') }, '去安装与更新') : null) : null,
        loggedIn ? status.login.selfMatches === undefined || status.login.selfMatches === null
          ? h('div', { className: 'dfy-notice dfy-warning' }, '账号已登录，尚未完成小号核验，请检查登录状态。') : null
          : h(React.Fragment, null,
            h('div', { className: 'dfy-toolbar' },
              h('div', { className: 'dfy-meta' }, loginNote || h(React.Fragment, null, '请使用接收小号', expectedSelfId ? ' ' + expectedSelfId : '', ' 扫码，确认账号后登录。')),
              h('div', { className: 'dfy-inline-actions' },
                h('button', { className: 'dfy-button dfy-primary', type: 'button', disabled: !canQr || Boolean(qrBusy), onClick: () => getQr(false) }, qrBusy === 'read' ? '读取中…' : '显示二维码'),
                h('button', { className: 'dfy-button', type: 'button', disabled: !canRefresh || Boolean(qrBusy), onClick: () => getQr(true) }, qrBusy === 'refresh' ? '刷新中…' : '刷新二维码'))),
            qrFailure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, qrFailure) : null,
            qr?.available ? h('div', { className: 'dfy-qr' },
              h('img', { src: 'data:image/png;base64,' + qr.image.base64, alt: '接收小号的 QQ 登录二维码' }),
              h('div', { className: 'dfy-qr-copy' }, h('div', { className: 'dfy-titleline' }, h('p', null, '登录二维码请勿转发。'),
                h(HelpTip, { label: '二维码状态' }, '每 5 秒检查登录状态。二维码更新、已扫码或失效后会收起旧图；刷新需要手动点击。')),
                h('p', { style: { marginTop: 8 } }, qr.note || '二维码不会自动更新。')))
              : qr ? h('div', { className: 'dfy-notice' }, qr.note || '暂时没有可用二维码，请检查登录状态。') : null),
        status ? h(Advanced, { title: '高级设置' },
          h('div', { className: 'dfy-state-grid' },
            cell('Linux QQ 容器', !status.configured ? '尚未配置' : !status.container?.available ? '容器工具不可用'
              : status.container.running ? '运行中' : '未运行' + (status.container.state ? ' · ' + status.container.state : '')),
            cell('NapCat 管理服务', !status.webui?.reachable ? '未连接' : status.webui.authenticated ? '认证通过' : '认证未通过')),
          h('p', { className: 'dfy-meta' }, '账号核验：', status.login?.selfMatches === true ? '与绑定小号一致' : status.login?.selfMatches === false ? '账号不一致' : '尚未通过核验',
            ' · 检查时间：', displayTime(status.checkedAt)),
          h(HelpTip, { label: 'QQ 服务管理' }, '安装、更新与重启服务在“安装与更新”中。更新或重启会暂时断开 QQ。'),
          onNavigate ? h('button', { className: 'dfy-button', type: 'button', onClick: () => onNavigate('dependencies') }, '管理 QQ 服务') : null) : null);
    }
    function GalleryPanel({ active, onDirtyChange }) {
      const api = usePanelApi();
      const [search, setSearch] = useState('');
      const [gallery, setGallery] = useState(null);
      const [images, setImages] = useState({});
      const [loading, setLoading] = useState(false);
      const [failure, setFailure] = useState('');
      const [notice, setNotice] = useState('');
      const [previewId, setPreviewId] = useState('');
      const [details, setDetails] = useState({});
      const [detailLoading, setDetailLoading] = useState('');
      const [detailFailure, setDetailFailure] = useState(null);
      const [operation, setOperation] = useState('');
      const [showImport, setShowImport] = useState(false);
      const [importDraft, setImportDraft] = useState({ title: '', tags: '', description: '', aiDescription: '' });
      const [importFile, setImportFile] = useState(null);
      const [readingFile, setReadingFile] = useState(false);
      const [importFailure, setImportFailure] = useState('');
      const cursor = useRef({ query: '', offset: 0 });
      const generation = useRef(0);
      const detailGeneration = useRef(0);
      const busy = useRef(false);
      const mutation = useRef(false);
      const preview = useRef(null);
      const inputFile = useRef(null);
      const fileReader = useRef(null);
      const fileGeneration = useRef(0);
      const fileUrl = useRef('');
      const latest = useRef({});
      const editorId = useRef('dfy-gallery-' + Math.random().toString(36).slice(2));
      const fileLimit = 8 * 1024 * 1024;
      const splitTags = (text) => text.split(/[,，\n]+/).map((tag) => tag.trim()).filter(Boolean);
      const fieldsOf = (meme) => ({ title: meme.title || '', tags: Array.isArray(meme.tags) ? meme.tags.join(', ') : '',
        description: meme.description || '', aiDescription: meme.aiDescription || '' });
      const entryDirty = (entry) => Boolean(entry && !equal(entry.fields, entry.base));
      const dirtyEntries = Object.entries(details).filter(([, entry]) => entryDirty(entry));
      const importDirty = Boolean(importFile || readingFile || Object.values(importDraft).some((value) => value !== ''));
      const dirty = dirtyEntries.length > 0 || importDirty || Boolean(operation);
      latest.current = { details, importDraft, importFile };
      useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
      useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
      useEffect(() => () => {
        generation.current++; detailGeneration.current++; fileGeneration.current++;
        fileReader.current?.abort();
        if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
      }, []);
      function validateMeme(result) {
        const meme = result?.meme;
        if (!meme || typeof meme.id !== 'string' || typeof meme.revision !== 'string'
          || typeof meme.description !== 'string' || typeof meme.aiDescription !== 'string'
          || !Array.isArray(meme.tags)) throw new Error('表情详情响应不完整，请重新读取后核对。');
        return meme;
      }
      function acceptDetail(meme, reset) {
        setDetails((previous) => {
          const existing = previous[meme.id];
          return { ...previous, [meme.id]: existing && !reset && entryDirty(existing)
            ? { ...existing, latest: meme }
            : { meme, latest: meme, revision: meme.revision, base: fieldsOf(meme), fields: fieldsOf(meme) } };
        });
      }
      async function load(query, offset) {
        if (busy.current) return;
        const current = ++generation.current;
        busy.current = true; setLoading(true); setFailure('');
        cursor.current = { query, offset };
        try {
          const result = await api.call('memes?query=' + encodeURIComponent(query) + '&offset=' + offset + '&limit=24');
          if (!result.gallery || !Array.isArray(result.gallery.items) || !Number.isFinite(result.gallery.total)
            || result.gallery.items.some((item) => typeof item.id !== 'string')) throw new Error('图库响应不完整');
          if (api.alive.current && generation.current === current) setGallery(result.gallery);
        } catch (error) { if (api.alive.current && generation.current === current) setFailure(resourceError(error)); }
        finally { if (generation.current === current) { busy.current = false; if (api.alive.current) setLoading(false); } }
      }
      async function loadDetail(id) {
        const current = ++detailGeneration.current;
        setPreviewId(id); setDetailLoading(id); setDetailFailure(null); setNotice('');
        try {
          const result = await api.call('meme-detail?id=' + encodeURIComponent(id));
          const meme = validateMeme(result);
          if (meme.id !== id) throw new Error('表情详情与所选图片不一致');
          if (api.alive.current) acceptDetail(meme, false);
        } catch (error) { if (api.alive.current && current === detailGeneration.current) setDetailFailure({ id, error }); }
        finally { if (api.alive.current && current === detailGeneration.current) setDetailLoading(''); }
      }
      useEffect(() => { if (active) load(cursor.current.query, cursor.current.offset); }, [active]);
      useEffect(() => {
        setImages({});
        if (!active || !gallery) return;
        const controller = new AbortController();
        const urls = new Set();
        let cancelled = false, next = 0;
        async function worker() {
          while (!cancelled && next < gallery.items.length) {
            const item = gallery.items[next++];
            const timer = setTimeout(() => controller.abort(), 20000);
            try {
              const response = await fetch('/dafeiyu-panel/api/meme-image?id=' + encodeURIComponent(item.id), {
                credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' },
              });
              if (!response.ok) throw new Error('预览读取失败');
              const blob = await response.blob();
              if (!blob.size || blob.size > fileLimit || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type)) throw new Error('图片格式或大小不受支持');
              if (cancelled) return;
              const url = URL.createObjectURL(blob);
              urls.add(url);
              if (!cancelled) setImages((previous) => ({ ...previous, [item.id]: { url } }));
            } catch (error) {
              if (!cancelled) setImages((previous) => ({ ...previous, [item.id]: { error: resourceError(error) } }));
            } finally { clearTimeout(timer); }
          }
        }
        for (let index = 0; index < Math.min(4, gallery.items.length); index++) worker();
        return () => { cancelled = true; controller.abort(); for (const url of urls) URL.revokeObjectURL(url); };
      }, [gallery, active]);
      useEffect(() => { if (previewId) preview.current?.focus(); }, [previewId]);
      function editDetail(key, value) {
        setDetails((previous) => ({ ...previous, [previewId]: { ...previous[previewId], fields: { ...previous[previewId].fields, [key]: value } } }));
        setNotice('');
      }
      function validation(fields) {
        if (!fields.description.trim()) return '请填写具体含义：画面表达什么、适合何时使用，以及容易误会的地方。';
        if (fields.description.length > 1200 || fields.aiDescription.length > 1200) return '含义或 AI 补充说明不能超过 1,200 字符。';
        if (fields.title.length > 160) return '标题不能超过 160 字符。';
        const tags = splitTags(fields.tags);
        if (tags.length > 30 || tags.some((tag) => tag.length > 80)) return '标签最多 30 个，每个最多 80 字符。';
        return '';
      }
      const payloadFields = (fields) => ({ title: fields.title.trim(), tags: splitTags(fields.tags),
        description: fields.description.trim(), aiDescription: fields.aiDescription.trim() });
      async function saveDetail(id) {
        const entry = latest.current.details[id];
        if (mutation.current || !entry || !entryDirty(entry) || validation(entry.fields) || entry.latest.revision !== entry.revision) return;
        mutation.current = true; setOperation('metadata'); setDetailFailure(null); setNotice('');
        try {
          const next = payloadFields(entry.fields), previous = payloadFields(entry.base);
          const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => !equal(value, previous[key])));
          const result = await api.call('meme-metadata', 'POST', { id, revision: entry.revision, patch });
          const meme = validateMeme(result);
          if (meme.id !== id) throw new Error('保存回执与所选图片不一致，请重新读取核对。');
          if (api.alive.current) {
            acceptDetail(meme, true); setNotice('表情含义已保存，人和 AI 会读取同一份说明；AI 补充为空时共用这份含义。');
            await load(cursor.current.query, cursor.current.offset);
          }
        } catch (error) { if (api.alive.current) setDetailFailure({ id, error }); }
        finally { mutation.current = false; if (api.alive.current) setOperation(''); }
      }
      function releaseFile() {
        fileGeneration.current++; fileReader.current?.abort(); fileReader.current = null;
        if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
        fileUrl.current = ''; setImportFile(null); setReadingFile(false);
        if (inputFile.current) inputFile.current.value = '';
      }
      function chooseFile(event) {
        const file = event.target.files?.[0];
        if (!file || mutation.current) return;
        releaseFile(); setImportFailure(''); setNotice('');
        if (!file.size || file.size > fileLimit) { setImportFailure('图片必须大于 0 字节且不超过 8 MiB。'); return; }
        if (typeof file.name !== 'string' || file.name.length > 200 || /[/\\\u0000-\u001f]/.test(file.name)
          || !/\.(png|jpe?g|gif|webp)$/i.test(file.name)
          || file.type && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
          setImportFailure('请选择 PNG、JPEG、GIF 或 WebP 图片，文件名需保留相应后缀。'); return;
        }
        const current = ++fileGeneration.current;
        const reader = new FileReader(); fileReader.current = reader; setReadingFile(true);
        reader.onload = () => {
          if (!api.alive.current || current !== fileGeneration.current) return;
          const result = typeof reader.result === 'string' ? reader.result : '';
          const match = /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(result);
          if (!match || !match[1] || match[1].length > 4 * Math.ceil(fileLimit / 3)) {
            setImportFailure('本地图片读取失败，请重新选择文件。'); setReadingFile(false); fileReader.current = null; return;
          }
          try {
            const url = URL.createObjectURL(file); fileUrl.current = url;
            setImportFile({ filename: file.name, imageBase64: match[1], previewUrl: url, size: file.size });
          } catch { setImportFailure('本地预览创建失败，请重新选择图片。'); }
          setReadingFile(false); fileReader.current = null;
        };
        reader.onerror = () => { if (api.alive.current && current === fileGeneration.current) { setImportFailure('本地图片读取失败，请重新选择。'); setReadingFile(false); fileReader.current = null; } };
        reader.onabort = () => { if (api.alive.current && current === fileGeneration.current) { setReadingFile(false); fileReader.current = null; } };
        try { reader.readAsDataURL(file); }
        catch { if (current === fileGeneration.current) { setImportFailure('本地图片读取失败，请重新选择。'); setReadingFile(false); fileReader.current = null; } }
      }
      async function importMeme() {
        const current = latest.current;
        if (mutation.current || readingFile || !current.importFile || validation(current.importDraft)) return;
        mutation.current = true; setOperation('import'); setImportFailure(''); setNotice('');
        try {
          const result = await api.call('memes/import', 'POST', {
            filename: current.importFile.filename, ...payloadFields(current.importDraft), imageBase64: current.importFile.imageBase64,
          }, 30000);
          const meme = validateMeme(result);
          if (api.alive.current) {
            releaseFile(); setImportDraft({ title: '', tags: '', description: '', aiDescription: '' }); setShowImport(false);
            const keptEditorDraft = entryDirty(latest.current.details[meme.id]);
            acceptDetail(meme, false); setPreviewId(meme.id);
            const receipt = meme.duplicate === true ? '图片已存在，已保留原有描写。下方可查看详情；如需修改，请在详情中编辑。'
              : meme.imported === false ? '图片已存在，已补齐描写。请查看保存后的具体含义。' : '图片与含义已一起加入图库。';
            setNotice(receipt + (keptEditorDraft ? ' 这张图先前未保存的编辑草稿已保留，请在详情中核对。' : ''));
            await load(cursor.current.query, cursor.current.offset);
          }
        } catch (error) { if (api.alive.current) setImportFailure(resourceError(error) + ' 图片和描写草稿已保留，请先刷新图库核对，避免重复导入。'); }
        finally { mutation.current = false; if (api.alive.current) setOperation(''); }
      }
      function editor(fields, update, prefix, disabled) {
        const id = editorId.current + '-' + prefix;
        return h(React.Fragment, null,
          h('div', { className: 'dfy-grid' },
            h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', htmlFor: id + '-title' }, '标题'),
              h('input', { id: id + '-title', value: fields.title, maxLength: 160, disabled, onChange: (event) => update('title', event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') event.preventDefault(); } })),
            h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', htmlFor: id + '-tags' }, '标签（逗号分隔）'),
              h('input', { id: id + '-tags', value: fields.tags, maxLength: 2500, disabled, onChange: (event) => update('tags', event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') event.preventDefault(); } }))),
          h('div', { className: 'dfy-field', style: { marginTop: 12 } },
            h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: id + '-description' }, '含义说明（必填）'),
              h(HelpTip, { label: '表情含义' }, h('span', { id: id + '-description-help' }, '写清画面、情绪和适合使用的场景。你和大肥鱼都会阅读这段说明；容易误解时，也可以写明不适合的场景。'))),
            h('textarea', { id: id + '-description', className: 'dfy-meme-text', value: fields.description, maxLength: 1200, disabled,
              'aria-required': true, 'aria-describedby': id + '-description-help',
              placeholder: '例：小鲸鱼缩在被窝里，只露出眼睛，表达疲惫又想被关心。适合晚安、撒娇或说今天累了；不要用于严肃争执或讽刺对方。',
              onChange: (event) => update('description', event.target.value) }),
            h('p', { className: 'dfy-hint' }, fields.description.length + ' / 1,200')),
          h(Advanced, { title: '高级设置' },
            h('div', { className: 'dfy-field', style: { marginTop: 8 } },
              h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: id + '-ai' }, '给大肥鱼的补充说明（选填）'),
                h(HelpTip, { label: '补充说明' }, '只在需要额外说明语气或使用场景时填写。留空会沿用上面的含义说明，不需要重复写。这里的内容不会授予任何操作权限。')),
              h('textarea', { id: id + '-ai', className: 'dfy-meme-text', value: fields.aiDescription, maxLength: 1200, disabled,
                placeholder: '选填：补充语气、关系或容易选错的场景。留空时 AI 使用上面的具体含义。',
                onChange: (event) => update('aiDescription', event.target.value) }),
              h('p', { className: 'dfy-hint' }, fields.aiDescription.length + ' / 1,200'))));
      }
      const selected = details[previewId];
      const selectedSummary = gallery?.items.find((item) => item.id === previewId);
      const conflict = selected && selected.latest.revision !== selected.revision;
      const detailValidation = selected ? validation(selected.fields) : '';
      const importValidation = validation(importDraft);
      const warnings = Array.isArray(gallery?.warnings) ? gallery.warnings : [];
      const displayOnlyWarning = warnings.length > 0 && warnings.every((warning) => warning?.code === 'DISPLAY_TRUNCATED');
      const offset = Number(gallery?.offset) || 0;
      const limit = Number(gallery?.limit) || 24;
      const imageFailures = Object.values(images).filter((image) => image.error).length;
      return h('section', { className: 'dfy-section' },
        h(SectionHeading, { title: '表情包', help: '为每张表情写清含义，大肥鱼才能在合适的时候使用。缺少说明的旧图片可以继续查看，补好说明后再使用。' },
          h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: Boolean(operation), onClick: () => setShowImport(true) }, '添加表情包')),
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        dirtyEntries.length ? h('div', { className: 'dfy-notice dfy-warning', role: 'status' },
          '有 ' + dirtyEntries.length + ' 张表情的描写未保存，切换页面和刷新会保留草稿。',
          h('div', { className: 'dfy-inline-actions', style: { marginTop: 7 } }, dirtyEntries.map(([id, entry]) =>
            h('button', { key: id, type: 'button', className: 'dfy-link-button', disabled: Boolean(operation), onClick: () => loadDetail(id) }, '继续编辑：' + (entry.fields.title || '未命名表情'))))) : null,
        showImport ? h('section', { className: 'dfy-meme-editor', 'aria-label': '添加表情包' },
          h('div', { className: 'dfy-toolbar', style: { marginTop: 0 } }, h('h3', null, '添加表情'),
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(operation), onClick: () => setShowImport(false) }, '收起（保留草稿）')),
          h('div', { className: 'dfy-field' },
            h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: editorId.current + '-file' }, '选择图片'),
              h(HelpTip, { label: '图片格式' }, '支持 PNG、JPEG、GIF、WebP，每张最多 8 MB。选择图片后只在本地预览，点击添加按钮才会上传。')),
            h('input', { ref: inputFile, id: editorId.current + '-file', type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp', disabled: Boolean(operation), onChange: chooseFile })),
          readingFile ? h('p', { className: 'dfy-meta', role: 'status' }, '正在读取本地图片，尚未上传…') : null,
          importFile ? h('figure', { className: 'dfy-preview' }, h('img', { src: importFile.previewUrl, alt: '待添加图片的本地预览' }),
            h('figcaption', null, importFile.filename + ' · ' + Math.ceil(importFile.size / 1024) + ' KB · 尚未上传')) : null,
          editor(importDraft, (key, value) => { setImportDraft((previous) => ({ ...previous, [key]: value })); setImportFailure(''); }, 'import', Boolean(operation)),
          importFailure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, importFailure) : null,
          importValidation ? h('p', { className: 'dfy-field-error' }, importValidation) : null,
          h('div', { className: 'dfy-inline-actions' },
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(operation) || !importDirty, onClick: () => {
              releaseFile(); setImportDraft({ title: '', tags: '', description: '', aiDescription: '' }); setImportFailure(''); setShowImport(false);
            } }, '放弃新增草稿'),
            h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: Boolean(operation) || readingFile || !importFile || Boolean(importValidation), onClick: importMeme },
              operation === 'import' ? '正在导入…' : '导入图片与描写'))) : null,
        !showImport && importDirty ? h('div', { className: 'dfy-notice dfy-warning' }, '有未提交的新增图片或描写草稿。', ' ',
          h('button', { type: 'button', className: 'dfy-link-button', onClick: () => setShowImport(true) }, '继续添加')) : null,
        h('div', { className: 'dfy-toolbar' },
          h('div', { className: 'dfy-search' },
            h('div', { className: 'dfy-field' },
              h('label', { className: 'dfy-label', htmlFor: editorId.current + '-search' }, '搜索图库'),
              h('input', { id: editorId.current + '-search', value: search, maxLength: 128, type: 'search', placeholder: '搜索含义、标题或标签',
                onChange: (event) => setSearch(event.target.value), onKeyDown: (event) => {
                  if (event.key === 'Enter') { event.preventDefault(); load(search.trim(), 0); }
                } })),
            h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: loading || Boolean(operation), onClick: () => load(search.trim(), 0) }, '搜索')),
          h('button', { type: 'button', className: 'dfy-button', disabled: loading || Boolean(operation),
            onClick: () => load(cursor.current.query, cursor.current.offset) }, loading ? '读取中…' : '刷新图库')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' }, failure) : null,
        (warnings.length || gallery?.partial) && !displayOnlyWarning ? h('div', { className: 'dfy-notice dfy-warning', role: 'status' },
          '部分表情暂时无法读取，可以继续浏览其他图片。') : null,
        warnings.length || gallery?.partial ? h(Advanced, { title: '高级详情' },
          displayOnlyWarning ? h('p', { className: 'dfy-hint' }, '列表中的部分标签或说明已缩短，查看详情可读全文。') : null,
          warnings.length ? h('ul', null, warnings.slice(0, 5).map((warning, index) =>
            h('li', { key: index }, typeof warning === 'string' ? warning : warning.message || '条目读取异常'))) : null,
          warnings.length > 5 ? h('p', null, '另有 ' + (warnings.length - 5) + ' 条提示。') : null) : null,
        previewId ? h('section', { className: 'dfy-meme-editor', ref: preview, tabIndex: -1, 'aria-label': '表情含义详情' },
          h('div', { className: 'dfy-toolbar', style: { marginTop: 0 } },
            h('h3', null, '表情详情'), h('div', { className: 'dfy-inline-actions' },
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(operation) || Boolean(detailLoading), onClick: () => loadDetail(previewId) }, '读取最新描写'),
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(operation), onClick: () => { setPreviewId(''); detailGeneration.current++; setDetailLoading(''); } }, '收起详情（保留草稿）'))),
          images[previewId]?.url ? h('figure', { className: 'dfy-preview' }, h('img', { src: images[previewId].url, alt: selected?.fields.title || selectedSummary?.title || '表情包' })) : null,
          detailLoading === previewId ? h('p', { className: 'dfy-meta', role: 'status' }, '正在读取完整描写…') : null,
          detailFailure?.id === previewId ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' },
            detailFailure.error.code === 'CONFLICT' ? '这张表情已被其他操作修改，草稿已保留。请读取最新描写并核对，再采用最新版本。' : resourceError(detailFailure.error)) : null,
          selected ? h(React.Fragment, null,
            !selected.meme.description.trim() ? h('div', { className: 'dfy-notice dfy-warning' }, '待补描述：这张旧图还没有具体含义，请补充后保存。') : null,
            conflict ? h('div', { className: 'dfy-notice dfy-warning' },
              h('p', null, '最新描写已变化；当前草稿不会自动覆盖。请核对下面最新内容。'),
              h('details', { className: 'dfy-detail' }, h('summary', null, '查看最新完整描写'),
                h('p', { className: 'dfy-preserve-lines' }, selected.latest.description || '尚无具体含义'),
                h('p', { className: 'dfy-preserve-lines' }, 'AI 补充：' + (selected.latest.aiDescription || '共用具体含义')),
                h('p', null, '标题：' + selected.latest.title), h('p', null, '标签：' + selected.latest.tags.join(', '))),
              h('button', { type: 'button', className: 'dfy-link-button', disabled: Boolean(operation), onClick: () => {
                setDetails((previous) => {
                  const entry = previous[previewId], next = fieldsOf(entry.latest);
                  const changed = Object.fromEntries(Object.entries(entry.fields).filter(([key, value]) => !equal(value, entry.base[key])));
                  return { ...previous, [previewId]: { meme: entry.latest, latest: entry.latest, revision: entry.latest.revision, base: next, fields: { ...next, ...changed } } };
                }); setDetailFailure(null); setNotice('已采用最新版本并保留你修改的字段。请核对后再保存。');
              } }, '采用最新版本，保留我修改的字段')) : null,
            editor(selected.fields, editDetail, 'edit', Boolean(operation)),
            h(Advanced, { title: '文件信息' }, h('p', { className: 'dfy-meta' }, '文件名：', selected.meme.file || selectedSummary?.file || '未提供')),
            detailValidation ? h('p', { className: 'dfy-field-error' }, detailValidation) : null,
            h('div', { className: 'dfy-toolbar' }, h('span', { className: 'dfy-meta' }, entryDirty(selected) ? '有未保存的表情描写' : '已保存'),
              h('div', { className: 'dfy-inline-actions' },
                h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(operation) || !entryDirty(selected), onClick: () => {
                  acceptDetail(selected.latest, true); setDetailFailure(null); setNotice('已放弃这张表情的描写草稿。');
                } }, '放弃本图草稿'),
                h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: Boolean(operation) || Boolean(detailLoading) || !entryDirty(selected) || Boolean(detailValidation) || conflict,
                  onClick: () => saveDetail(previewId) }, operation === 'metadata' ? '正在保存…' : '保存表情描写')))) : null) : null,
        loading ? h('div', { className: 'dfy-empty', role: 'status' }, '正在读取图库…') : null,
        gallery ? h(React.Fragment, null,
          h('div', { className: 'dfy-meta', 'aria-live': 'polite' }, '共 ' + gallery.total + ' 张',
            gallery.items.length ? ' · 当前 ' + (offset + 1) + '–' + (offset + gallery.items.length) : ''),
          !gallery.items.length ? h('div', { className: 'dfy-empty' }, cursor.current.query ? '没有匹配的表情包。' : '当前图库没有可显示的图片。')
            : h('div', { className: 'dfy-gallery' }, gallery.items.map((item) =>
              h('article', { className: 'dfy-meme', key: item.id },
                h('button', { className: 'dfy-thumbnail', type: 'button', disabled: Boolean(operation),
                  'aria-label': '查看含义与编辑 ' + (item.title || '未命名表情'), onClick: () => loadDetail(item.id) },
                  images[item.id]?.url ? h('img', { src: images[item.id].url, alt: item.title || '未命名表情',
                    onError: () => setImages((previous) => ({ ...previous, [item.id]: { error: '图片无法解码' } })) })
                    : images[item.id]?.error ? '预览加载失败，仍可查看含义' : '读取图片…'),
                h('div', { className: 'dfy-meme-copy' },
                  h('div', { className: 'dfy-meme-title', title: item.title || '未命名表情' }, item.title || '未命名表情'),
                  item.descriptionStatus !== 'ready' || !item.description?.trim()
                    ? h('p', { className: 'dfy-meme-meaning dfy-warn' }, '待补描述')
                    : h('p', { className: 'dfy-meme-meaning', title: item.description }, item.description),
                  h('div', { className: 'dfy-tags' }, (Array.isArray(item.tags) ? item.tags : []).filter((tag) => typeof tag === 'string').slice(0, 4)
                    .map((tag, index) => h('span', { className: 'dfy-badge', key: index }, tag))),
                  h('button', { type: 'button', className: 'dfy-link-button', disabled: Boolean(operation), onClick: () => loadDetail(item.id) },
                    item.descriptionStatus === 'ready' && item.description?.trim() ? '查看 / 编辑含义' : '补充具体含义'))))),
          imageFailures ? h('p', { className: 'dfy-meta', role: 'status' }, imageFailures + ' 张预览未加载成功，可刷新图库重试。') : null,
          h('div', { className: 'dfy-toolbar' }, h('span', { className: 'dfy-meta' }, '每页最多 24 张'),
            h('div', { className: 'dfy-inline-actions' },
              h('button', { type: 'button', className: 'dfy-button', disabled: loading || Boolean(operation) || offset <= 0,
                onClick: () => load(cursor.current.query, Math.max(0, offset - limit)) }, '上一页'),
              h('button', { type: 'button', className: 'dfy-button', disabled: loading || Boolean(operation) || offset + gallery.items.length >= gallery.total,
                onClick: () => load(cursor.current.query, offset + limit) }, '下一页')))) : null);
    }
    function PersonaPanel({ onDirtyChange }) {
      const api = usePanelApi();
      const [persona, setPersona] = useState(null);
      const [text, setText] = useState('');
      const [base, setBase] = useState('');
      const [revision, setRevision] = useState('');
      const [loading, setLoading] = useState(false);
      const [saving, setSaving] = useState(false);
      const [failure, setFailure] = useState(null);
      const [notice, setNotice] = useState('');
      const generation = useRef(0);
      const busy = useRef(false);
      const latest = useRef({});
      const editorId = useRef('dfy-persona-' + Math.random().toString(36).slice(2));
      const dirty = text !== base;
      const conflict = Boolean(dirty && persona && revision !== persona.revision);
      const bytes = new TextEncoder().encode(text).length;
      latest.current = { text, base, revision, dirty };
      useEffect(() => { onDirtyChange(dirty); }, [dirty]);
      function accept(result, reset) {
        const next = result.persona;
        if (!next || typeof next.text !== 'string'
          || typeof next.revision !== 'string' && !(next.editable === false && next.revision === null)) throw new Error('人设响应不完整');
        setPersona(next);
        if (reset || !latest.current.dirty) { setText(next.text); setBase(next.text); setRevision(next.revision || ''); }
      }
      async function load() {
        if (busy.current) return;
        const current = ++generation.current;
        busy.current = true; setLoading(true); setFailure(null); setNotice('');
        try {
          const result = await api.call('persona');
          if (api.alive.current && generation.current === current) {
            accept(result, false);
            if (latest.current.dirty) setNotice('已读取最新人设，你的草稿已保留。');
          }
        } catch (error) { if (api.alive.current && generation.current === current) setFailure(error); }
        finally { if (generation.current === current) { busy.current = false; if (api.alive.current) setLoading(false); } }
      }
      useEffect(() => {
        load();
        return () => { generation.current++; busy.current = false; api.cancel(); };
      }, []);
      async function save() {
        if (busy.current || !dirty || !persona?.editable || bytes > 131072) return;
        busy.current = true; setSaving(true); setFailure(null); setNotice('');
        try {
          const result = await api.call('persona', 'POST', { text: latest.current.text, revision: latest.current.revision });
          if (api.alive.current) {
            accept(result, true);
            setNotice(result.appliesNextTurn === true || result.persona?.appliesNextTurn === true
              ? '人设已保存，将从下一轮对话生效。' : '人设已保存。');
          }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { busy.current = false; if (api.alive.current) setSaving(false); }
      }
      const injectionMaxChars = Number(persona?.injectionMaxChars);
      return h('section', { className: 'dfy-section' },
        h(SectionHeading, { title: '性格', help: '在这里写下大肥鱼的性格、说话习惯和相处方式。聊天中的指令也会影响她；保存后从下一轮对话生效。' },
          h('button', { type: 'button', className: 'dfy-button', disabled: loading || saving, onClick: load }, loading ? '读取中…' : '刷新性格')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' },
          failure.code === 'CONFLICT' ? '人设已被其他操作修改。草稿已保留，请先读取最新人设并核对。' : resourceError(failure)) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        persona ? h(React.Fragment, null,
          !persona.editable && persona.revision !== null ? h('p', { className: 'dfy-meta', style: { marginBottom: 12 } }, '当前性格仅可查看，暂时无法在这里修改。') : null,
          persona.revision === null ? h('div', { className: 'dfy-notice', role: 'status' }, '伴侣尚未启动，无法读取当前角色卡。') : null,
          conflict ? h('div', { className: 'dfy-notice dfy-warning' },
            h('p', null, '最新文件已变化。保存会用完整草稿替换文件，请先核对最新内容。'),
            h('button', { type: 'button', className: 'dfy-link-button', disabled: loading || saving, onClick: () => {
              setBase(persona.text); setRevision(persona.revision); setFailure(null);
              setNotice('已采用最新版本并保留完整草稿。核对后可再次保存。');
            } }, '采用最新版本，保留草稿'),
            h('details', { className: 'dfy-detail' }, h('summary', null, '查看最新文件内容'),
              h('pre', { className: 'dfy-persona-latest' }, persona.text))) : null,
          h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: editorId.current }, '性格与相处方式'),
            h(HelpTip, { label: '性格编辑' }, h('span', { id: editorId.current + '-help' }, '可以直接编辑文字。保存性格与连接配置相互独立，不会自动保存其他页面的草稿。'))),
          h('textarea', { id: editorId.current, className: 'dfy-persona', value: text,
            readOnly: persona.editable !== true, disabled: saving, spellCheck: false,
            'aria-describedby': editorId.current + '-help',
            onChange: (event) => { setText(event.target.value); setNotice(''); } }),
          Number.isSafeInteger(injectionMaxChars) && injectionMaxChars > 0 && text.length > Math.max(0, Math.floor(injectionMaxChars * 0.55) - 8)
            ? h('p', { className: 'dfy-field-error' }, '内容较长，部分说明可能无法用于对话。建议保留最重要的性格和相处方式。') : null,
          bytes > 131072 ? h('div', { className: 'dfy-field-error', role: 'alert' }, '内容过长，请缩短后保存。') : null,
          h(Advanced, { title: '高级设置' },
            h('p', { className: 'dfy-meta' }, '来源：', persona.sourceLabel || '宿主角色文件',
              ' · ', persona.editable ? '可编辑' : '只读', !persona.configured && persona.revision !== null ? ' · 尚未配置人设' : ''),
            h('p', { className: 'dfy-meta' }, bytes.toLocaleString() + ' / 131,072 UTF-8 字节'),
            Number.isSafeInteger(injectionMaxChars) && injectionMaxChars > 0
              ? h('p', { className: 'dfy-hint' }, '角色提示总预算 ' + injectionMaxChars.toLocaleString() + ' 字符，角色正文最多约占 55%。完整文件会保存，实际对话按剩余预算截断。') : null),
          h('div', { className: 'dfy-toolbar' },
            h('div', { className: 'dfy-meta', role: 'status' }, dirty ? '有未保存的修改' : ''),
            h('div', { className: 'dfy-inline-actions' },
              dirty ? h('button', { type: 'button', className: 'dfy-button', disabled: loading || saving, onClick: () => {
                setText(persona.text); setBase(persona.text); setRevision(persona.revision || ''); setFailure(null); setNotice('已放弃草稿，恢复为最近读取的文件内容。');
              } }, '放弃人设草稿') : null,
              h('button', { type: 'button', className: 'dfy-button dfy-primary',
                disabled: loading || saving || !dirty || !persona.editable || bytes > 131072 || conflict,
                onClick: save }, saving ? '保存中…' : '保存性格'))))
          : !failure ? h('div', { className: 'dfy-empty' }, '正在读取性格…') : null);
    }
    function TokenPanel({ active, onDirtyChange, writeBlocked = false }) {
      const api = usePanelApi();
      const [snapshot, setSnapshot] = useState(null), [base, setBase] = useState(null), [draft, setDraft] = useState(null), [revision, setRevision] = useState('');
      const [busy, setBusy] = useState(''), [failure, setFailure] = useState(''), [notice, setNotice] = useState('');
      const [bonus, setBonus] = useState(''), [bonusUnconfirmed, setBonusUnconfirmed] = useState(false), [confirmed, setConfirmed] = useState({});
      const lock = useRef(false), latest = useRef({}), bonusId = useRef(null), fieldId = useRef('dfy-tokens-' + Math.random().toString(36).slice(2));
      const policyKeys = ['enabled', 'dailyTokens', 'monthlyTokens', 'requestReserveTokens'];
      const policyValues = (tokens) => Object.fromEntries(policyKeys.map((key) => [key, tokens.policy[key]]));
      const policyDirty = Boolean(base && draft && !equal(base, draft));
      const dirty = policyDirty || bonus !== '' || Object.values(confirmed).some(Boolean) || busy && busy !== 'read';
      const conflict = policyDirty && revision !== snapshot?.revision;
      latest.current = { snapshot, base, draft, revision, policyDirty, bonus, bonusUnconfirmed, confirmed, active, writeBlocked };
      useEffect(() => { onDirtyChange?.(Boolean(dirty)); }, [Boolean(dirty), onDirtyChange]);
      useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
      const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
      const whole = (value, positive = false) => /^(0|[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= (positive ? 1 : 0);
      const policyMax = 1000000000000;
      const policyValid = (key, value) => whole(value, key === 'requestReserveTokens') && Number(value) <= policyMax;
      function accept(tokens, savedPolicy = false) {
        if (!tokens || typeof tokens.revision !== 'string' || !tokens.policy) throw new Error('Token 状态不完整，请刷新重试。');
        if (!api.alive.current) return;
        setSnapshot(tokens);
        setConfirmed((old) => {
          const actionable = new Set((tokens.requests || []).filter((row) => ['unknown', 'unmetered'].includes(row.status) && !row.acknowledgedUnmetered)
            .map((row) => row.requestId));
          const next = Object.fromEntries(Object.entries(old).filter(([requestId]) => actionable.has(requestId)));
          return equal(old, next) ? old : next;
        });
        if (savedPolicy || !latest.current.policyDirty) {
          const values = policyValues(tokens); setBase(values); setDraft(values); setRevision(tokens.revision);
        } else if (equal(policyValues(tokens), latest.current.base)) {
          // Usage and grants share the ledger revision with policy. A new CAS
          // version is safe only while the saved policy still equals our base.
          setRevision(tokens.revision);
        }
        if (bonusId.current && tokens.transactions?.some((row) => row.kind === 'bonus' && row.requestId === bonusId.current && row.tokens === Number(latest.current.bonus))) {
          bonusId.current = null; setBonus(''); setBonusUnconfirmed(false);
        }
      }
      async function load() {
        if (lock.current || !latest.current.active) return;
        lock.current = true; setBusy('read'); setFailure('');
        try { const result = await api.call('tokens/status'); accept(result.tokens);
          if (api.alive.current) setNotice(latest.current.policyDirty || latest.current.bonus !== '' ? '状态已刷新，未保存的 Token 草稿已保留。' : '');
        } catch (error) { if (api.alive.current) setFailure(resourceError(error)); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      useEffect(() => { if (active && !snapshot) void load(); }, [active]);
      function change(key, value) { setDraft((old) => ({ ...old, [key]: value })); setFailure(''); }
      async function mutate(kind, requestId) {
        const state = latest.current;
        if (lock.current || !state.active || state.writeBlocked || !state.snapshot) return;
        let payload;
        if (kind === 'config') {
          if (!state.policyDirty || state.revision !== state.snapshot.revision
            || !['dailyTokens', 'monthlyTokens', 'requestReserveTokens'].every((key) => policyValid(key, state.draft[key]))) return;
          const patch = Object.fromEntries(policyKeys.filter((key) => !equal(state.draft[key], state.base[key]))
            .map((key) => [key, key === 'enabled' ? state.draft[key] : Number(state.draft[key])]));
          payload = { revision: state.revision, patch };
        } else if (kind === 'bonus') {
          if (!whole(state.bonus, true) || state.bonusUnconfirmed) return;
          bonusId.current ||= crypto.randomUUID();
          payload = { revision: state.snapshot.revision, requestId: bonusId.current, tokens: Number(state.bonus) };
        } else if (kind === 'acknowledge') {
          const row = state.snapshot.requests?.find((item) => item.requestId === requestId);
          if (!row || !['unknown', 'unmetered'].includes(row.status) || row.acknowledgedUnmetered || state.confirmed[requestId] !== true) return;
          payload = { revision: state.snapshot.revision, requestId, confirmedStopped: true, acknowledgedUnmetered: true };
        } else return;
        lock.current = true; setBusy(kind); setFailure(''); setNotice('');
        try {
          const result = await api.call('tokens/' + kind, 'POST', payload); accept(result.tokens, kind === 'config');
          if (api.alive.current) {
            if (kind === 'bonus') { bonusId.current = null; setBonus(''); setBonusUnconfirmed(false); }
            if (kind === 'acknowledge') setConfirmed((old) => { const next = { ...old }; delete next[requestId]; return next; });
            setNotice(kind === 'config' ? 'Token 额度已保存。' : kind === 'bonus' ? '零花 Token 已发放。' : '已确认停止并释放预留；这笔仍保留为未计量。');
          }
        } catch (error) {
          if (api.alive.current) {
            if (kind === 'bonus' && !['CONFLICT', 'INVALID_PATCH', 'INVALID_VALUE', 'FORBIDDEN', 'BUSY'].includes(error.code)) setBonusUnconfirmed(true);
            setFailure(resourceError(error) + '；结果未确认时请先刷新核对，不会自动重复操作。');
          }
        } finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      async function confirmBonus() {
        const state = latest.current, requestId = bonusId.current, amount = Number(state.bonus);
        if (lock.current || !state.active || state.writeBlocked || !state.bonusUnconfirmed || !requestId || !whole(state.bonus, true)) return;
        lock.current = true; setBusy('bonus-confirm'); setFailure(''); setNotice('');
        try {
          const current = await api.call('tokens/status'), tokens = current.tokens;
          accept(tokens);
          const receipt = tokens.transactions?.find((row) => row.kind === 'bonus' && row.requestId === requestId);
          if (receipt) {
            if (receipt.tokens !== amount) throw new Error('这笔申请的账本金额不同，请先核对；没有再次发放。');
            if (api.alive.current) setNotice('已核对，原申请的零花 Token 已到账。');
            return;
          }
          if (!api.alive.current || !latest.current.active || latest.current.writeBlocked || bonusId.current !== requestId) return;
          const result = await api.call('tokens/bonus', 'POST', { revision: tokens.revision, requestId, tokens: amount });
          accept(result.tokens);
          if (api.alive.current) { bonusId.current = null; setBonus(''); setBonusUnconfirmed(false); setNotice('已完成原申请，没有新建一笔发放。'); }
        } catch (error) { if (api.alive.current) setFailure(resourceError(error) + '；原申请和金额已保留，不会自动重复发放。'); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const fieldsValid = draft && ['dailyTokens', 'monthlyTokens', 'requestReserveTokens'].every((key) => policyValid(key, draft[key]));
      const pending = (snapshot?.requests || []).filter((row) => ['unknown', 'unmetered'].includes(row.status) && !row.acknowledgedUnmetered);
      const pendingCount = Number.isSafeInteger(snapshot?.pendingUnknownCount) ? snapshot.pendingUnknownCount : pending.length;
      const pendingMonthly = Number.isSafeInteger(snapshot?.pendingMonthlyTokens) && snapshot.pendingMonthlyTokens > 0 ? snapshot.pendingMonthlyTokens : 0;
      const balanceDebt = Number.isSafeInteger(snapshot?.balanceTokens) && snapshot.balanceTokens < 0 ? -snapshot.balanceTokens : 0;
      const overdrawn = Math.max(balanceDebt, Number.isSafeInteger(snapshot?.overdrawnTokens) && snapshot.overdrawnTokens > 0 ? snapshot.overdrawnTokens : 0);
      const stat = (label, value, signed = false) => h('div', { className: 'dfy-state-cell' }, h('span', null, label),
        h('strong', null, signed && Number.isSafeInteger(value) ? value.toLocaleString() : count(value)));
      const number = (key, label, min = 0) => {
        const invalid = !policyValid(key, draft[key]), id = fieldId.current + '-' + key;
        return h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', htmlFor: id }, label),
          h('input', { id, type: 'number', min, max: policyMax, step: 1, value: draft[key], disabled: Boolean(busy) || writeBlocked,
            'aria-invalid': invalid, 'aria-describedby': invalid ? id + '-error' : undefined,
            onChange: (event) => change(key, event.target.value) }),
          invalid ? h('p', { id: id + '-error', className: 'dfy-field-error', role: 'alert' }, label + '：请填写 ' + min + ' 到 1,000,000,000,000 之间的整数。') : null);
      };
      const requestStatus = (row) => row.acknowledgedUnmetered ? '未计量（已确认停止）' : ({ started: '处理中', usage: '处理中', reserved: '处理中', running: '处理中', completed: '已计量', settled: '已计量',
        failed: '执行失败', cancelled: '已取消', unknown: '未确认', unmetered: '未计量，待核实' }[row.status] || '待核实');
      return h('section', { className: 'dfy-section', 'aria-label': 'Token 与零花钱' },
        h(SectionHeading, { title: 'Token 与零花钱', help: '用户交办的任务单独记用量，不扣她的额度。她自主活动时先用每日免扣额度，再用可累积的零花 Token；失败但实际发生的消耗仍计入。点击和等待不会按次数编造 Token。Token 不是人民币，当前没有金额账单。娱乐时间在另一个钱包管理。' },
          h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: load }, busy === 'read' ? '刷新中…' : '刷新 Token 状态')),
        failure ? h('div', { className: 'dfy-notice dfy-warning', role: 'alert' }, failure) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status' }, notice) : null,
        snapshot && draft ? h(React.Fragment, null,
          h('div', { className: 'dfy-state-grid' }, stat('今日用户安排', snapshot.today?.userTaskTokens), stat('今日自主使用', snapshot.today?.autonomyTokens),
            stat('今日免扣剩余', snapshot.dailyRemainingTokens), stat('零花 Token 余额', snapshot.balanceTokens, true)),
          pendingMonthly > 0 ? h('div', { className: 'dfy-titleline' }, h('p', { className: 'dfy-meta' }, '本月待入账 ', count(pendingMonthly), ' Token'),
            h(HelpTip, { label: '本月待入账' }, '下次实际调用或保存时同步入账。查看和刷新只读取状态，不会发放额度、写入余额或新增交易。待入账额度尚未计入当前余额。')) : null,
          !snapshot.policy.enabled ? h('p', { className: 'dfy-meta' }, '自主 Token 额度未开启。') : null,
          pendingCount > 0 ? h('p', { className: 'dfy-notice dfy-warning', role: 'status' }, '有 ', pendingCount, ' 笔用量待核实，请在高级设置中处理。') : null,
          overdrawn > 0 ? h('p', { className: 'dfy-notice dfy-warning', role: 'status' }, '超支 ', count(overdrawn), ' Token，需要处理。') : null,
          h(Advanced, { title: '高级设置' },
            h('label', { className: 'dfy-toggle', htmlFor: fieldId.current + '-enabled' }, h('span', { className: 'dfy-toggle-copy' }, '启用自主 Token 额度'),
              h('input', { id: fieldId.current + '-enabled', type: 'checkbox', checked: draft.enabled === true, disabled: Boolean(busy) || writeBlocked,
                onChange: (event) => change('enabled', event.target.checked) })),
            h('div', { className: 'dfy-grid' }, number('dailyTokens', '每日免扣 Token'), number('monthlyTokens', '每月零花 Token'), number('requestReserveTokens', '每次请求预留 Token', 1)),
            h('p', { className: 'dfy-hint' }, '每日免扣不结转；每月零花可累积。预留用于约束未知消耗，不等于已经花掉。额度为 Token 数量。'),
            conflict ? h('div', { className: 'dfy-notice dfy-warning', role: 'status' }, '状态已更新，原 Token 草稿已保留，请核对后再保存。',
              h('button', { type: 'button', className: 'dfy-link-button', disabled: Boolean(busy), onClick: () => {
                const current = latest.current, nextBase = policyValues(current.snapshot);
                const changed = Object.fromEntries(policyKeys.filter((key) => !equal(current.draft[key], current.base[key])).map((key) => [key, current.draft[key]]));
                setBase(nextBase); setDraft({ ...nextBase, ...changed }); setRevision(current.snapshot.revision); setFailure('');
              } }, '采用最新版本，保留 Token 草稿')) : null,
            h('div', { className: 'dfy-inline-actions' }, policyDirty ? h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: () => {
              const values = policyValues(latest.current.snapshot); setBase(values); setDraft(values); setRevision(latest.current.snapshot.revision); setFailure('');
            } }, '放弃 Token 设置草稿') : null,
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || writeBlocked || !policyDirty || !fieldsValid || conflict,
                onClick: () => mutate('config') }, busy === 'config' ? '保存中…' : '保存 Token 额度')),
            h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', htmlFor: fieldId.current + '-bonus' }, '额外发放 Token'),
              h('input', { id: fieldId.current + '-bonus', type: 'number', min: 1, step: 1, value: bonus, disabled: Boolean(busy) || writeBlocked || bonusUnconfirmed,
                onChange: (event) => { setBonus(event.target.value); bonusId.current = null; } })),
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || writeBlocked || !whole(bonus, true) || bonusUnconfirmed,
              onClick: () => mutate('bonus') }, busy === 'bonus' ? '发放中…' : '发放零花 Token'),
            bonusUnconfirmed ? h(React.Fragment, null,
              h('p', { className: 'dfy-hint' }, '这笔发放结果未确认，原申请和金额已保留。确认会先查账本，必要时完成同一笔申请，不新建发放。'),
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || writeBlocked, onClick: confirmBonus },
                busy === 'bonus-confirm' ? '核对中…' : '确认同一笔发放')) : null,
            h('p', { className: 'dfy-meta' }, '当前预留：', count(snapshot.reservedTokens), ' Token；当前可用：', count(snapshot.availableTokens),
              ' Token；未计量记录：', count(snapshot.unmeteredCount), ' 笔。'),
            h(Advanced, { title: '用量与变动明细' },
              (snapshot.requests || []).slice().reverse().map((row) => h('article', { key: row.requestId, className: 'dfy-resource' },
                h('strong', null, row.origin === 'user-task' ? '用户安排' : row.origin === 'autonomy' ? '自主活动' : '归属待核实'),
                h('p', { className: 'dfy-meta' }, requestStatus(row), ' · ', displayTime(row.at || row.startedAt)),
                h('p', null, '实际用量：', row.usage && Number.isSafeInteger(row.usage.totalTokens) ? count(row.usage.totalTokens) + ' Token' : '未计量'),
                row.usage ? h('p', { className: 'dfy-meta' }, '免扣 ', count(row.freeTokens), '；零花 ', count(row.pocketTokens)) : null,
                h('p', { className: 'dfy-meta' }, '记录编号：', row.requestId),
                ['unknown', 'unmetered'].includes(row.status) && !row.acknowledgedUnmetered ? h(React.Fragment, null,
                  h('label', { className: 'dfy-field' }, h('input', { type: 'checkbox', checked: confirmed[row.requestId] === true, disabled: Boolean(busy) || writeBlocked,
                    'aria-label': '确认请求已停止并接受未计量 ' + row.requestId,
                    onChange: (event) => setConfirmed((old) => ({ ...old, [row.requestId]: event.target.checked })) }), ' 我已核实该请求停止，并接受它仍未计量；仅释放预留。'),
                  h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || writeBlocked || confirmed[row.requestId] !== true,
                    onClick: () => mutate('acknowledge', row.requestId) }, '确认停止并释放预留')) : null)),
              !(snapshot.requests || []).length ? h('p', { className: 'dfy-meta' }, '暂无用量记录。') : null,
              (snapshot.transactions || []).slice().reverse().map((row, index) => h('p', { key: row.id || row.requestId || index, className: 'dfy-meta' },
                ({ monthly: '每月到账', bonus: '额外发放', spend: '自主使用', 'user-task': '用户安排用量（不扣零花）', 'unmetered-release': '未计量请求释放预留' }[row.kind] || '额度变动'), ' · ',
                count(row.tokens), ' Token', row.at ? ' · ' + displayTime(row.at) : '')))))
          : !failure ? h('p', { className: 'dfy-meta' }, '正在读取 Token 状态…') : null);
    }

    function LifePanel({ active, accounts, ownerQq = '', onManageAccounts, onDirtyChange, writeBlocked = false, revokeBlocked = writeBlocked, cancelBlocked = false }) {
      const api = usePanelApi(), [data, setData] = useState(null), [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [failure, setFailure] = useState('');
      const [query, setQuery] = useState(''), [appliedQuery, setAppliedQuery] = useState('');
      const [selected, setSelected] = useState(null), [editText, setEditText] = useState('');
      const [deleteChecked, setDeleteChecked] = useState(false), [bonusMinutes, setBonusMinutes] = useState('');
      const [bonusReceipt, setBonusReceipt] = useState(null), [tokensDirty, setTokensDirty] = useState(false);
      const [sectionErrors, setSectionErrors] = useState({}), [checkingNow, setCheckingNow] = useState(false), [cancellingActivity, setCancellingActivity] = useState(false);
      const immediateController = useRef(null), cancelLock = useRef(false), cancelGeneration = useRef(0);
      const lock = useRef(false), baseline = useRef(null), bonusIntent = useRef(null), latest = useRef({});
      const fields = {
        memory: { detailedDays: ['普通经历保留细节的天数', 1, 3650, 1], summaryDays: ['普通概要参与主动回忆的天数', 1, 3650, 1] },
        wallet: { dailySeconds: ['每日基础分钟', 0, 31536000, 60], monthlySeconds: ['每月零花分钟', 0, 31536000, 60] },
        autonomy: { quietStart: ['免打扰开始时间', 0, 23, 1], quietEnd: ['免打扰结束时间', 0, 23, 1],
          maxContacts: ['每个聊天身份每日主动联系上限', 1, 20, 1], minGapMinutes: ['主动聊天最小间隔分钟', 1, 1440, 1],
          maxActivities: ['每日自主活动总次数上限', 1, 20, 1], sessionSeconds: ['单次娱乐最多分钟', 1, 3600, 60] },
      };
      const values = (value) => {
        const memory = value.memory.policy, wallet = value.autonomy.wallet.policy, autonomy = value.autonomy.policy;
        const groups = { memory: { learningEnabled: memory.learningEnabled === true, growthEnabled: memory.growthEnabled === true },
          wallet: { enabled: wallet.enabled === true }, autonomy: { enabled: autonomy.enabled === true, proactive: autonomy.proactive === true,
            browse: autonomy.browse === true, quietEnabled: typeof autonomy.quietEnabled === 'boolean' ? autonomy.quietEnabled : autonomy.quietStart !== autonomy.quietEnd,
            greetingEnabled: autonomy.greetingEnabled === true, platforms: [...autonomy.platforms], targets: autonomy.targets.map((scope) => ({ ...scope })),
            douyinInteractions: { like: autonomy.douyinInteractions?.like === true, follow: autonomy.douyinInteractions?.follow === true,
              comment: autonomy.douyinInteractions?.comment === true } } };
        for (const [group, policy] of Object.entries({ memory, wallet, autonomy }))
          for (const [key, meta] of Object.entries(fields[group])) groups[group][key] = String(policy[key] / meta[3]);
        return groups;
      };
      function parseNumber(raw, meta) {
        const [label, min, max, scale] = meta;
        if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw.trim())) throw new Error('请填写有效的“' + label + '”。');
        const scaled = Number(raw) * scale, number = Math.round(scaled);
        if (!Number.isSafeInteger(number) || Math.abs(scaled - number) > 0.000001 || number < min || number > max)
          throw new Error('“' + label + '”应在 ' + min / scale + '–' + max / scale + ' 之间，' + (scale === 1 ? '并填写整数。' : '且应能换算为整秒。'));
        return number;
      }
      function policyPatch(group, value) {
        const patch = { ...value };
        for (const [key, meta] of Object.entries(fields[group])) patch[key] = parseNumber(value[key], meta);
        if (group === 'memory' && patch.summaryDays < patch.detailedDays) throw new Error('概要保留天数不能少于细节保留天数。');
        if (group === 'autonomy' && patch.quietEnabled && patch.quietStart === patch.quietEnd) throw new Error('启用免打扰时，开始与结束时间不能相同。');
        return patch;
      }
      const settingsDirty = Boolean(draft && baseline.current && !equal(draft, baseline.current));
      const experienceDirty = Boolean(selected && editText !== selected.detail);
      const experienceVersion = (row) => row && [row.id, row.scope, row.detail, row.summary, row.pinned, row.pending, row.status, row.history, row.source];
      const currentExperience = selected && data?.memory?.items.find((row) => row.id === selected.id);
      const experienceConflict = Boolean(selected && (!currentExperience || !equal(experienceVersion(currentExperience), experienceVersion(selected))));
      const bonusUnresolved = Boolean(bonusReceipt && ['pending', 'unknown'].includes(bonusReceipt.phase));
      const bonusDraft = Boolean(!bonusReceipt && bonusMinutes.trim());
      const dirty = settingsDirty || experienceDirty || bonusDraft || bonusUnresolved;
      const formBlocked = writeBlocked || Boolean(data?.memory?.error);
      const autonomyDraftDirty = Boolean(draft && baseline.current && !equal(draft.autonomy, baseline.current.autonomy));
      const live = () => api.alive?.current !== false;
      latest.current = { data, draft, writeBlocked: formBlocked, revokeBlocked: revokeBlocked || Boolean(data?.memory?.error), cancelBlocked, selected, editText, deleteChecked, bonusMinutes, dirty, query, appliedQuery,
        navigationDirty: dirty || tokensDirty, autonomyDraftDirty, checkingNow, cancellingActivity, accounts, onManageAccounts };
      useEffect(() => { onDirtyChange?.(dirty || tokensDirty); }, [dirty, tokensDirty]);
      useEffect(() => () => onDirtyChange?.(false), []);
      function adopt(next, savedGroup) {
        const fresh = values(next), old = latest.current.draft;
        const nextDraft = {}, nextBase = {};
        for (const group of Object.keys(fresh)) {
          const preserve = group !== savedGroup && old && baseline.current && !equal(old[group], baseline.current[group]);
          nextDraft[group] = preserve ? old[group] : fresh[group];
          nextBase[group] = preserve ? baseline.current[group] : fresh[group];
        }
        baseline.current = nextBase; setDraft(nextDraft); setData(next);
      }
      function reconcileBonus(next, proof) {
        const intent = bonusIntent.current;
        if (!intent) return false;
        const transaction = next.autonomy.wallet.transactions.find((row) => row.id === 'bonus:' + intent.requestId);
        if ((!transaction || transaction.seconds !== intent.seconds)
          && !(proof?.requestId === intent.requestId && proof?.added === intent.seconds)) return false;
        intent.phase = 'done'; setBonusReceipt({ ...intent });
        setSectionErrors((old) => ({ ...old, bonus: '' }));
        return true;
      }
      async function readView(offset, search) {
        const params = (page) => new URLSearchParams({ query: search, offset: String(page), limit: '50' });
        let result = await api.call('life?' + params(offset));
        if (live() && offset > 0 && offset >= result.life.memory.total) {
          const lastPage = Math.floor(Math.max(0, result.life.memory.total - 1) / 50) * 50;
          result = await api.call('life?' + params(lastPage));
        }
        return result.life;
      }
      async function load(offset = latest.current.data?.memory.offset || 0, nextQuery) {
        if (lock.current || !live()) return; lock.current = true; setBusy(true); setFailure('');
        const current = latest.current, hadDraft = current.dirty;
        const editingExperience = current.selected && current.editText !== current.selected.detail;
        const search = nextQuery === undefined ? current.appliedQuery : String(nextQuery).trim();
        try {
          if (editingExperience && (offset !== current.data.memory.offset || search !== current.appliedQuery))
            throw new Error('当前记录有未保存的修改，请先保存或撤销，再切换查找范围。');
          const next = await readView(offset, search);
          if (!live()) return;
          adopt(next); setAppliedQuery(search);
          if (nextQuery !== undefined) setQuery(search);
          const confirmed = reconcileBonus(next);
          if (!editingExperience) { setSelected(null); setDeleteChecked(false); }
          setNotice(confirmed ? '已核对本次发放：' + bonusIntent.current.seconds / 60 + ' 分钟已到账，没有再次发放。'
            : hadDraft ? '记录已刷新，未保存的修改仍保留。' : '生活记录已刷新。');
        } catch (error) { setFailure(error.message || '生活记录读取失败'); }
        finally { lock.current = false; setBusy(false); }
      }
      useEffect(() => { if (active && !data) void load(); }, [active]);
      function resetDraft() {
        if (lock.current || !live() || !latest.current.data) return;
        const fresh = values(latest.current.data); baseline.current = fresh; setDraft(fresh);
        setSelected(null); setEditText(''); setDeleteChecked(false);
        if (!bonusIntent.current) setBonusMinutes('');
        setFailure(''); setSectionErrors({}); setNotice('未保存的修改已撤销，已保存的设置和余额保持不变。');
      }
      function canCheckNow() {
        const current = latest.current, autonomy = current.data?.autonomy;
        return live() && !lock.current && !cancelLock.current && !current.writeBlocked && !current.autonomyDraftDirty
          && autonomy?.policy?.enabled === true && autonomy.running !== true
          && !(autonomy.activities || []).some(row => ['scheduled', 'running', 'unknown'].includes(row.status)
            || row.delivery === 'unknown' && row.status !== 'interrupted')
          && !(autonomy.wallet?.sessions || []).some(row => row.status === 'unknown');
      }
      async function cancelActivity() {
        const current = latest.current;
        if (!live() || cancelLock.current || current.cancelBlocked || !current.data
          || current.data.autonomy.running !== true && !current.checkingNow) return;
        cancelLock.current = true; cancelGeneration.current++; setCancellingActivity(true); setFailure('');
        immediateController.current?.abort();
        try {
          const result = await api.call('life/action', 'POST', { action: 'cancel', input: {} }, 180000);
          if (live()) { adopt(result.life); setNotice('已请求停止当前自主活动，请查看最新记录；未重做任何活动。'); }
        } catch (error) {
          if (live()) {
            setFailure((error.message || '停止结果未确认') + '；仅刷新记录核对，不会重发停止或活动。');
            try { const next = await readView(current.data.memory.offset, current.appliedQuery); if (live()) adopt(next); } catch {}
          }
        } finally { cancelLock.current = false; if (live()) setCancellingActivity(false); }
      }
      async function act(action, input = {}, policyKey) {
        if (action === 'cancel') return cancelActivity();
        if (action === 'autonomy-check-now' && !canCheckNow()) return;
        if (lock.current || cancelLock.current || !live() || !latest.current.data
          || (action === 'cancel' ? latest.current.cancelBlocked || latest.current.data.autonomy.running !== true : latest.current.writeBlocked)) return;
        const current = latest.current;
        try {
          if (['correct', 'delete', 'pin', 'pending', 'forget', 'restore'].includes(action)) {
            if (!current.selected || input.id !== current.selected.id) throw new Error('当前选择的经历已变化，请重新核对。');
            const source = current.data.memory.items.find((row) => row.id === current.selected.id);
            if (!source || !equal(experienceVersion(source), experienceVersion(current.selected))) throw new Error('当前记录已变化或暂时无法核对。输入已保留，请重新打开最新记录后核对。');
            if (action === 'delete' && current.deleteChecked !== true) throw new Error('请先确认删除当前这条经历。');
            if (action === 'correct') input = { ...input, detail: current.editText };
          }
          if (policyKey) {
            if (!equal(values(current.data)[policyKey], baseline.current[policyKey])) throw new Error('这部分设置已在别处更新，已保留你的输入。请刷新核对后，撤销未保存修改以采用最新设置。');
            input = { ...input, patch: policyPatch(policyKey, current.draft[policyKey]) };
          }
          if (action === 'bonus') {
            if (bonusIntent.current?.phase === 'done') return;
            if (!bonusIntent.current) bonusIntent.current = { requestId: crypto.randomUUID(),
              seconds: parseNumber(current.bonusMinutes, ['额外发放分钟', 1, 31536000, 60]), phase: 'pending' };
            bonusIntent.current.phase = 'pending'; setBonusReceipt({ ...bonusIntent.current });
            input = { requestId: bonusIntent.current.requestId, seconds: bonusIntent.current.seconds };
          }
        } catch (error) {
          if (policyKey || action === 'bonus') setSectionErrors((old) => ({ ...old, [policyKey || 'bonus']: error.message }));
          else setFailure(error.message);
          return;
        }
        lock.current = true; setBusy(true); setFailure(''); setNotice('');
        const cancelVersion = cancelGeneration.current;
        if (action === 'autonomy-check-now') { immediateController.current = new AbortController(); setCheckingNow(true); }
        if (policyKey || action === 'bonus') setSectionErrors((old) => ({ ...old, [policyKey || 'bonus']: '' }));
        try {
          const sessionSeconds = current.data.autonomy.policy.sessionSeconds;
          const timeoutMs = action === 'autonomy-check-now' && Number.isSafeInteger(sessionSeconds) && sessionSeconds >= 1 && sessionSeconds <= 3600
            ? (sessionSeconds + 210) * 1000 : 20000;
          const result = await api.call('life/action', 'POST', { action, input: { revision: current.data.memory.revision, ...input } }, timeoutMs,
            action === 'autonomy-check-now' ? immediateController.current?.signal : undefined);
          if (!live() || action === 'autonomy-check-now' && cancelGeneration.current !== cancelVersion) return;
          let next = result.life, viewNote = '';
          if (current.appliedQuery || current.data.memory.offset > 0) {
            try { next = await readView(current.data.memory.offset, current.appliedQuery); }
            catch {
              setAppliedQuery(''); setQuery('');
              viewNote = '原操作已保存；原查找范围暂未读回，列表已显示最近记录。';
            }
          }
          if (!live()) return;
          adopt(next, policyKey);
          if (['correct', 'delete', 'forget', 'restore'].includes(action)) setSelected(null);
          else if (selected) { const updated = next.memory.items.find((row) => row.id === selected.id) || result.life.result?.result; if (updated?.id === selected.id) setSelected(updated); }
          setDeleteChecked(false);
          if (action === 'bonus') {
            if (!reconcileBonus(result.life, result.life.result?.result)) throw new Error('本次发放回执尚未确认');
            setNotice('已发放 ' + bonusIntent.current.seconds / 60 + ' 分钟零花时间，余额已更新。' + viewNote);
          } else setNotice(action === 'autonomy-check-now' ? '本次新的自主活动已返回，请查看活动记录；没有重做旧计划。' : action === 'delete' ? '受管生活记忆与相关成长已删除；DSH聊天历史和外部备份未清除。'
            : policyKey ? ({ memory: '记忆与成长设置', wallet: '时间额度', autonomy: '自主活动范围' })[policyKey] + '已保存并生效。'
              + (Object.keys(current.draft).some((group) => group !== policyKey && !equal(current.draft[group], baseline.current[group])) ? '其他未保存的修改仍保留。' : '')
              : '已保存，请查看最新状态。');
          if (viewNote && action !== 'bonus') setNotice(viewNote);
        } catch (error) {
          if (action === 'autonomy-check-now') {
            if (cancelGeneration.current !== cancelVersion || !live()) return;
            setFailure((error.message || '本次活动结果未确认') + '；只刷新记录核对，不会自动重试或重发活动。');
            try { const next = await readView(current.data.memory.offset, current.appliedQuery); if (live()) adopt(next); } catch {}
            return;
          }
          if (action === 'bonus' && bonusIntent.current) { bonusIntent.current.phase = 'unknown'; setBonusReceipt({ ...bonusIntent.current }); }
          setFailure((error.message || '操作未确认') + '；输入仍保留，请刷新核对后再操作。');
          if (policyKey || action === 'bonus') setSectionErrors((old) => ({ ...old, [policyKey || 'bonus']: (error.message || '操作未确认') + '；输入仍保留。' }));
        } finally {
          if (action === 'autonomy-check-now') { immediateController.current = null; if (live()) setCheckingNow(false); }
          lock.current = false; if (live()) setBusy(false);
        }
      }
      function newBonus() {
        if (lock.current || !live() || latest.current.writeBlocked || bonusIntent.current?.phase !== 'done') return;
        bonusIntent.current = null; setBonusReceipt(null); setNotice('可以填写下一笔零花时间；点击发放才会增加余额。');
      }
      const set = (group, key, value) => {
        if (lock.current || !live() || latest.current.writeBlocked) return;
        setSectionErrors((old) => ({ ...old, [group]: '' }));
        setNotice(''); setFailure('');
        setDraft((old) => ({ ...old, [group]: { ...old[group], [key]: value } }));
      };
      const interactionRevocations = () => {
        const current = latest.current;
        if (!live() || lock.current || cancelLock.current || current.revokeBlocked || !current.data || !current.draft
          || !equal(values(current.data).autonomy, baseline.current?.autonomy)) return null;
        const saved = current.data.autonomy.policy.douyinInteractions || {}, selected = current.draft.autonomy.douyinInteractions;
        if (['like', 'follow', 'comment'].some(operation => selected[operation] === true && saved[operation] !== true)) return null;
        const patch = Object.fromEntries(['like', 'follow', 'comment'].filter(operation => saved[operation] === true && selected[operation] === false).map(operation => [operation, false]));
        return Object.keys(patch).length ? patch : null;
      };
      const setInteraction = (operation, checked) => {
        const current = latest.current;
        if (!live() || lock.current || cancelLock.current || current.revokeBlocked || !current.draft) return;
        if (current.writeBlocked && (checked !== false || current.data?.autonomy.policy.douyinInteractions?.[operation] !== true
          || current.draft.autonomy.douyinInteractions[operation] !== true)) return;
        setDraft(old => ({ ...old, autonomy: { ...old.autonomy, douyinInteractions: { ...old.autonomy.douyinInteractions, [operation]: checked } } }));
        setSectionErrors(old => ({ ...old, autonomy: '' })); setFailure(''); setNotice('');
      };
      async function revokeInteractions() {
        const patch = interactionRevocations(); if (!patch) return;
        const current = latest.current, oldBase = baseline.current.autonomy;
        lock.current = true; setBusy(true); setFailure(''); setNotice('');
        try {
          const result = await api.call('life/action', 'POST', { action: 'autonomy-policy', input: {
            revision: current.data.memory.revision, patch: { douyinInteractions: patch } } }, 20000);
          if (!live()) return;
          adopt(result.life);
          baseline.current = { ...baseline.current, autonomy: { ...oldBase, douyinInteractions: { ...oldBase.douyinInteractions, ...patch } } };
          setNotice('已保存关闭的抖音互动许可；当前抖音自主活动已请求停止。其他未保存修改仍保留；已发送内容不会撤回。');
        } catch (error) {
          if (live()) setFailure((error.message || '关闭许可结果未确认') + '；输入仍保留，请刷新核对，不会自动重发。');
        } finally { lock.current = false; if (live()) setBusy(false); }
      }
      const fieldEnabled = (group, key) => group !== 'autonomy' || (key === 'greetingEnabled' ? latest.current.draft?.autonomy.proactive
        : ['quietStart', 'quietEnd'].includes(key) ? latest.current.draft?.autonomy.quietEnabled
          : ['platforms', 'sessionSeconds'].includes(key) ? latest.current.draft?.autonomy.browse : true);
      const check = (group, key, label) => h('label', { className: 'dfy-field' }, h('input', { type: 'checkbox', checked: Boolean(draft[group][key]), disabled: busy || formBlocked || !fieldEnabled(group, key),
        onChange: (event) => { if (fieldEnabled(group, key)) set(group, key, event.target.checked); } }), ' ', label);
      const number = (group, key, label, divisor = 1) => h('label', { className: 'dfy-field' }, label,
        h('input', { type: 'number', min: fields[group][key][1] / divisor, max: fields[group][key][2] / divisor,
          step: divisor === 1 ? 1 : 'any', value: draft[group][key], disabled: busy || formBlocked || !fieldEnabled(group, key),
          onChange: (event) => { if (fieldEnabled(group, key)) set(group, key, String(event.target.value)); } }));
      const hour = (key) => h('label', { className: 'dfy-field' }, fields.autonomy[key][0], h('select', {
        value: draft.autonomy[key], disabled: busy || formBlocked || !fieldEnabled('autonomy', key),
        onChange: (event) => { if (fieldEnabled('autonomy', key)) set('autonomy', key, String(event.target.value)); } },
        Array.from({ length: 24 }, (_, value) => h('option', { key: value, value: String(value) }, String(value).padStart(2, '0') + ':00'))));
      const formatTime = (value) => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : '';
      const manageAccounts = () => {
        if (!lock.current && live() && !latest.current.writeBlocked && !latest.current.navigationDirty) latest.current.onManageAccounts?.();
      };
      const button = (label, handler, disabled = false, mutating = true) => h('button', { type: 'button', className: 'dfy-button',
        disabled: busy || cancellingActivity || disabled || mutating && formBlocked,
        onClick: () => { if (!lock.current && !cancelLock.current && live() && (!mutating || !latest.current.writeBlocked)) return handler(); } }, label);
      const recordAct = (action, input = {}) => act(action, { id: selected.id, ...input });
      return h('section', { className: 'dfy-section', 'aria-label': '生活与成长管理' },
        h('h3', null, '生活与成长'), h('p', { className: 'dfy-description' }, '近期经历、逐渐形成的习惯、自主活动和可结余的零花时间。开关默认关闭，启用后按所选范围运行。'),
        h(TokenPanel, { active, onDirtyChange: setTokensDirty, writeBlocked }),
        h('div', { className: 'dfy-toolbar' }, button('刷新生活记录', () => load(), false, false),
          dirty ? button('撤销未保存修改', resetDraft, !settingsDirty && !experienceDirty && !bonusDraft, false) : null,
          data ? h('button', { type: 'button', className: 'dfy-button', disabled: cancelBlocked || cancellingActivity || !data.autonomy.running && !checkingNow,
            onClick: cancelActivity }, cancellingActivity ? '正在停止自主活动…' : '停止当前自主活动') : null),
        dirty ? h('p', { className: 'dfy-hint', role: 'status' }, bonusUnresolved
          ? '本次发放结果需要核对。刷新只读取记录，不会重新发放。'
          : '有未保存的修改，请点击所在分区的保存按钮。刷新记录会保留输入；撤销只影响未保存的修改。') : null,
        failure ? h('div', { role: 'alert', className: 'dfy-notice dfy-warning' }, failure) : null,
        notice ? h('div', { role: 'status', className: 'dfy-notice' }, notice) : null,
        data?.memory?.error ? h('div', { role: 'alert', className: 'dfy-notice dfy-warning' }, data.memory.error.message) : null,
        data && draft ? h(React.Fragment, null,
          h('section', { className: 'dfy-section' }, h('h3', null, '记忆与成长设置'),
            check('memory', 'learningEnabled', '自动整理日常聊天'), check('memory', 'growthEnabled', '随长期交流积累相处习惯'),
            h('div', { className: 'dfy-grid' }, number('memory', 'detailedDays', '普通经历保留细节的天数'), number('memory', 'summaryDays', '普通概要参与主动回忆的天数')),
            h('p', { className: 'dfy-hint' }, '固定记忆和未完成约定不随时间淡化。读取不会强化记忆，回忆不清时不得编造。'),
            sectionErrors.memory ? h('p', { className: 'dfy-notice dfy-warning', role: 'alert' }, sectionErrors.memory) : null,
            button('保存记忆与成长设置', () => act('memory-policy', { patch: draft.memory }, 'memory'))),
          h('section', { className: 'dfy-section' }, h('h3', null, '娱乐时间钱包'),
            h('div', { className: 'dfy-state-grid' }, h('div', { className: 'dfy-state-cell' }, '今日基础剩余：', Math.floor(data.autonomy.wallet.dailyRemainingSeconds / 60), ' 分钟'),
              h('div', { className: 'dfy-state-cell' }, '零花余额：', (data.autonomy.wallet.balance / 60).toFixed(1), ' 分钟')),
            check('wallet', 'enabled', '启用娱乐时间额度'), h('div', { className: 'dfy-grid' }, number('wallet', 'dailySeconds', '每日基础分钟', 60), number('wallet', 'monthlySeconds', '每月零花分钟', 60)),
            h('p', { className: 'dfy-hint' }, '每日基础时间不结转；每月零花时间可一直累积。加载、暂停和离线不计娱乐时间。用户交办任务不从此钱包扣除。时区：Asia/Shanghai。'),
            sectionErrors.wallet ? h('p', { className: 'dfy-notice dfy-warning', role: 'alert' }, sectionErrors.wallet) : null,
            button('保存时间额度', () => act('wallet-policy', { patch: { enabled: draft.wallet.enabled, dailySeconds: draft.wallet.dailySeconds, monthlySeconds: draft.wallet.monthlySeconds } }, 'wallet')),
            h('div', { style: { marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(127,127,127,.18)' } },
            h('h4', null, '额外零花时间'),
            h('label', { className: 'dfy-field', style: { display: 'block' } }, '额外发放分钟', h('input', { type: 'number', min: 1 / 60, max: 525600, step: 'any',
              value: bonusMinutes, disabled: busy || formBlocked || Boolean(bonusReceipt),
              onChange: (event) => { if (!lock.current && live() && !latest.current.writeBlocked && !bonusIntent.current) {
                setBonusMinutes(String(event.target.value)); setNotice(''); setSectionErrors((old) => ({ ...old, bonus: '' }));
              } } })),
            h('p', { className: 'dfy-hint' }, '额外发放是一笔单独增加的零花时间，不改变上方每月额度。'),
            sectionErrors.bonus ? h('p', { className: 'dfy-notice dfy-warning', role: 'alert' }, sectionErrors.bonus) : null,
            button(bonusReceipt?.phase === 'done' ? '已发放' : bonusReceipt?.phase === 'unknown' ? '继续本次发放' : '发放零花时间',
              () => act('bonus'), bonusReceipt?.phase === 'done' || !bonusMinutes.trim()),
            bonusReceipt?.phase === 'done' ? h('p', { className: 'dfy-notice', role: 'status' }, '本次已发放 ', bonusReceipt.seconds / 60, ' 分钟，输入数值保留供核对。') : null,
            bonusReceipt?.phase === 'done' ? button('再发一笔', newBonus) : null,
            bonusReceipt?.phase === 'unknown' ? h('p', { className: 'dfy-hint' }, '请先刷新核对到账记录。“继续本次发放”只确认原来这一笔，不会额外增加另一笔。') : null),
            h('details', null, h('summary', null, '时间账本'), data.autonomy.wallet.transactions.slice().reverse().map((row) => h('p', { key: row.id, className: 'dfy-meta' },
              ({ monthly: '每月到账', bonus: '额外发放', spend: '娱乐使用' }[row.kind] || row.kind) + ' · ' + (row.seconds / 60).toFixed(1) + ' 分钟' + (row.month ? ' · ' + row.month : ''))))),
          h('section', { className: 'dfy-section' }, h('h3', null, '自主活动范围'),
            check('autonomy', 'enabled', '启用自主活动'),
            h('section', { className: 'dfy-section', 'aria-label': '联系谁' }, h('h4', null, '联系谁'),
              h('p', { className: 'dfy-hint' }, '只会联系下方已勾选的已启用聊天对象，按各账号当前身份分别交流。'),
              accounts.filter((account) => account.enabled).length ? accounts.filter((account) => account.enabled).map((account) => {
                const scope = { accountId: account.qq, identityId: account.activeIdentityId }, included = draft.autonomy.targets.some((item) => equal(item, scope));
                const identity = account.identities?.find((item) => item.id === account.activeIdentityId);
                return h('label', { key: account.qq, className: 'dfy-field' }, h('input', { type: 'checkbox', disabled: busy || formBlocked, checked: included,
                  onChange: (event) => {
                    if (!latest.current.accounts.some((item) => item.enabled && item.qq === scope.accountId && item.activeIdentityId === scope.identityId)) return;
                    const targets = latest.current.draft.autonomy.targets;
                    set('autonomy', 'targets', event.target.checked ? targets.some((item) => equal(item, scope)) ? targets : [...targets, scope] : targets.filter((item) => !equal(item, scope)));
                  } }), ' ' + (account.name || account.qq) + ' · ' + account.qq + ' · ' + (identity?.name || account.activeIdentityId),
                  account.qq === ownerQq ? h('span', { className: 'dfy-badge' }, '主要使用者（配置）') : null);
              }) : h('p', { className: 'dfy-empty' }, '还没有已启用的聊天对象，请先在“管理聊天对象”中添加并启用。'),
              h('p', { className: 'dfy-hint' }, '主要使用者的权限和私人记忆归属在“管理聊天对象”中管理。这里的勾选只选择主动联系人，不会切换主要账号。'),
              button('管理聊天对象', manageAccounts, !onManageAccounts || dirty || tokensDirty),
              dirty || tokensDirty ? h('p', { className: 'dfy-hint' }, '请先保存或撤销生活页未保存的修改，再管理聊天对象。')
                : formBlocked ? h('p', { className: 'dfy-hint' }, '请先处理其他页面的未保存修改或等待当前操作结束，再管理聊天对象。') : null),
            h('section', { className: 'dfy-section', 'aria-label': '允许做什么' }, h('h4', null, '允许做什么'),
              h('h5', null, '主动聊天'), check('autonomy', 'proactive', '允许主动找选定账号聊天'),
              check('autonomy', 'greetingEnabled', '没有话题时，允许首次主动问候'),
              h('p', { className: 'dfy-hint' }, '首次问候默认关闭；开启后，仅对已选中的主要使用者当前身份生效，仍受免打扰、间隔和次数限制，不会向其他账号首次问候。保存设置不会立即发送消息。'),
              h('h5', null, '自主浏览'), check('autonomy', 'browse', '允许自主浏览视频平台'),
              h('p', { className: 'dfy-hint' }, '浏览通过独立浏览器空间，全程静音。抖音点赞、关注和评论需在高级设置中单独允许；登录、私信和发布仍需本人安排。关闭浏览时保留平台与时限设置。'),
              ['bilibili', 'douyin'].map((platform) => h('label', { key: platform, className: 'dfy-field' }, h('input', { type: 'checkbox', disabled: busy || formBlocked || !draft.autonomy.browse,
                checked: draft.autonomy.platforms.includes(platform), onChange: (event) => {
                  if (!fieldEnabled('autonomy', 'platforms')) return;
                  const platforms = latest.current.draft.autonomy.platforms;
                  set('autonomy', 'platforms', event.target.checked ? platforms.includes(platform) ? platforms : [...platforms, platform] : platforms.filter((item) => item !== platform));
                } }), platform === 'bilibili' ? ' B站 ' : ' 抖音 ')),
              number('autonomy', 'sessionSeconds', '单次娱乐最多分钟', 60),
              h('details', { className: 'dfy-advanced' }, h('summary', null, '高级设置'),
                h('h5', null, '抖音自主互动'),
                h('p', { className: 'dfy-hint' }, '以下三项默认关闭。保存开启后，大肥鱼可在自主浏览时决定是否点赞、关注当前作者或评论当前作品；仍受账号核验、频率、Token 和时间额度限制。保存设置不会立即互动。'),
                h('p', { className: 'dfy-hint' }, '许可保存后，账号与具体动作仍须核验就绪；未核验不会发送。开关不代表真实互动已验收。'),
                ['like', 'follow', 'comment'].map((operation) => h('label', { key: operation, className: 'dfy-field' },
                  h('input', { type: 'checkbox', checked: draft.autonomy.douyinInteractions[operation] === true,
                    disabled: busy || latest.current.revokeBlocked || formBlocked && (data.autonomy.policy.douyinInteractions?.[operation] !== true || draft.autonomy.douyinInteractions[operation] !== true),
                    onChange: (event) => setInteraction(operation, event.target.checked) }),
                  ' ', ({ like: '允许自主点赞', follow: '允许自主关注', comment: '允许自主评论' })[operation])),
                !draft.autonomy.enabled || !draft.autonomy.browse || !draft.autonomy.platforms.includes('douyin')
                  ? h('p', { className: 'dfy-hint' }, '需同时开启自主活动、自主浏览并勾选抖音，以上许可才会生效。') : null,
                h('p', { className: 'dfy-hint' }, '关闭任一互动许可并保存，会停止当前抖音自主活动并取消后续互动；已发送的内容不会自动撤回。执行或发送结果未确认时会暂停，不会自动重试。'),
                formBlocked ? h('button', { type: 'button', className: 'dfy-button', disabled: busy || !interactionRevocations(), onClick: revokeInteractions }, '仅保存关闭的抖音互动') : null)),
            h('section', { className: 'dfy-section', 'aria-label': '免打扰' }, h('h4', null, '免打扰'),
              check('autonomy', 'quietEnabled', '启用免打扰时段'),
              h('div', { className: 'dfy-grid' }, hour('quietStart'), hour('quietEnd')),
              h('p', { className: 'dfy-hint' }, '按北京时间选择整点，支持跨过午夜。关闭后保留所选时段；开启时开始与结束不能相同。')),
            h('section', { className: 'dfy-section', 'aria-label': '频率与额度' }, h('h4', null, '频率与额度'),
              h('div', { className: 'dfy-grid' }, number('autonomy', 'maxContacts', '每个聊天身份每日主动联系上限'),
                number('autonomy', 'minGapMinutes', '主动聊天最小间隔分钟'), number('autonomy', 'maxActivities', '每日自主活动总次数上限')),
              h('p', { className: 'dfy-hint' }, '聊天次数按账号和身份分别统计当日已送达消息；活动总次数按当日已创建的活动统计，待计划活动不计入。娱乐时间和 Token 额度分别在上方管理，不互相换算。')),
            sectionErrors.autonomy ? h('p', { className: 'dfy-notice dfy-warning', role: 'alert' }, sectionErrors.autonomy) : null,
            button('保存自主活动范围', () => act('autonomy-policy', { patch: draft.autonomy }, 'autonomy')),
            h('p', { className: 'dfy-hint' }, '检查并开始一次会创建新的自主活动，按已保存的范围、Token 和娱乐时间额度记账；不会提前或重做旧计划。不会替你开启首次问候；问候仅在你已单独允许时发送。'),
            button(checkingNow ? '正在检查并进行一次活动…' : '检查并开始一次活动', () => act('autonomy-check-now'), !canCheckNow()),
            autonomyDraftDirty ? h('p', { className: 'dfy-hint' }, '请先保存或撤销自主活动范围草稿，再开始一次新活动。') : null,
            h('section', { className: 'dfy-section', 'aria-label': '当前等待原因' }, h('h4', null, '当前等待原因'),
              h('p', { className: 'dfy-meta' }, '以下状态按已保存设置判断：', data.preview.reason),
              !equal(draft.autonomy, baseline.current.autonomy) ? h('p', { className: 'dfy-hint', role: 'status' }, '自主活动设置有未保存修改；上方等待原因尚未采用这些修改。') : null,
              formatTime(data.preview.nextCheckAt) ? h('p', { className: 'dfy-meta' }, '下次检查：', formatTime(data.preview.nextCheckAt)) : null,
              formatTime(data.preview.scheduledAt) ? h('p', { className: 'dfy-meta' }, '已计划活动时间：', formatTime(data.preview.scheduledAt)) : null),
            data.autonomy.activities.slice().reverse().slice(0, 10).map((row) => h('p', { key: row.id, className: 'dfy-meta' }, row.kind === 'chat' ? '主动聊天' : '自主浏览', ' · ', ({ scheduled: '等待合适时机', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '结果待核实', skipped: '已跳过', interrupted: '已核实停止' }[row.status] || row.status), ' · ', row.reason,
              row.status === 'scheduled' ? ' · 计划时间 ' + new Date(row.dueAt).toLocaleString() : '',
              row.status === 'unknown' ? button('确认旧活动已停止，解除挂起', () => act('acknowledge', { id: row.id, confirmedStopped: true })) : null))),
          h('section', { className: 'dfy-section', 'aria-label': '最近聊过的事' }, h('h3', null, '最近聊过的事'),
            h('p', { className: 'dfy-hint' }, '这里显示她最近记下的聊天片段。普通旧事逐渐淡化，固定事项和未完成约定保留。长期资料可在“记忆”页管理。'),
            data.memory.total > 0 || appliedQuery ? h('details', null, h('summary', null, '查找记录'),
              h('label', { className: 'dfy-field' }, '搜索经历', h('input', { value: query, maxLength: 200, disabled: busy || experienceDirty,
                placeholder: '输入想找的关键词', onChange: (event) => { if (!lock.current) setQuery(event.target.value); } })),
              button('查找', () => load(0, latest.current.query), experienceDirty, false)) : null,
            appliedQuery ? h('p', { className: 'dfy-meta' }, '正在查找：', appliedQuery, ' · ', data.memory.total, ' 条',
              button('查看全部记录', () => load(0, ''), experienceDirty, false)) : null,
            !data.memory.total ? h('div', { className: 'dfy-empty' }, appliedQuery ? '没有找到相关记录。可以换个关键词，或查看全部记录。'
              : data.memory.policy.learningEnabled ? '还没有记录。自动整理已开启，接下来的 QQ 聊天会逐步记在这里，不会自动补录旧聊天。'
                : '还没有记录。开启上方的“自动整理日常聊天”后，新的 QQ 聊天会逐步记在这里。')
              : h('p', { className: 'dfy-meta' }, appliedQuery ? '找到的记录' : '最近的记录', ' · 共 ', data.memory.total, ' 条'),
            data.memory.items.map((row) => h('div', { key: row.id, className: 'dfy-section' }, h('strong', null, row.summary),
              h('p', { className: 'dfy-meta' }, row.scope.accountId, ' / ', row.scope.identityId, ' · ', row.at, ' · ', ({ clear: '清晰', summary: '概要', faded: '已淡化' }[row.clarity]), row.pinned ? ' · 固定保留' : '', row.pending ? ' · 未完成约定' : '', row.status === 'inactive' ? ' · 已停用' : ''),
              button('查看与管理这条经历', () => { setSelected(row); setEditText(row.detail); setDeleteChecked(false); }, experienceDirty, false))),
            data.memory.total > data.memory.limit || data.memory.offset > 0 ? h('div', { className: 'dfy-inline-actions' },
              button('上一页生活记忆', () => load(Math.max(0, data.memory.offset - 50)), experienceDirty || data.memory.offset === 0, false),
              button('下一页生活记忆', () => load(data.memory.offset + 50), experienceDirty || data.memory.offset + data.memory.limit >= data.memory.total, false)) : null,
            selected ? h('div', { className: 'dfy-section' }, h('h3', null, '管理当前经历'),
              experienceConflict ? h('p', { className: 'dfy-notice dfy-warning', role: 'alert' }, '当前记录已变化或暂时无法核对。你的输入已保留；请先撤销未保存修改，再重新打开最新记录核对。') : null,
              h('label', null, '纠正经历内容', h('textarea', { className: 'dfy-persona', value: editText, maxLength: 12000, disabled: busy || formBlocked,
                onChange: (event) => { if (!lock.current && !latest.current.writeBlocked) setEditText(event.target.value); } })),
              button('保存经历纠正', () => recordAct('correct', { detail: editText }), experienceConflict || !editText.trim()),
              button(selected.pinned ? '取消固定保留' : '固定保留', () => recordAct('pin', { value: !selected.pinned }), experienceConflict),
              button(selected.pending ? '标记约定已完成' : '标为未完成约定', () => recordAct('pending', { value: !selected.pending }), experienceConflict),
              button('停止召回这条经历', () => recordAct('forget'), experienceConflict), button('撤销最近经历修改', () => recordAct('restore'), experienceConflict || !selected.history.length),
              h('label', null, h('input', { type: 'checkbox', checked: deleteChecked, disabled: busy || formBlocked || experienceConflict,
                onChange: (event) => { if (!lock.current && live() && !latest.current.writeBlocked) setDeleteChecked(event.target.checked); } }), ' 确认删除此条受管记忆、摘要与相关成长；DSH聊天历史及外部备份仍保留'),
              button('删除这条生活记忆', () => recordAct('delete'), experienceConflict || !deleteChecked)) : null),
          h('section', { className: 'dfy-section' }, h('h3', null, '相处习惯的成长记录'),
            data.memory.growth.length ? data.memory.growth.map((row) => h('div', { key: row.id, className: 'dfy-section' },
              h('strong', null, row.slot + '：' + ({ concise: '简短', detailed: '详细', direct: '直接坦诚', gentle: '温和', playful: '适度玩笑', serious: '认真表达' }[row.value] || row.value)), h('p', { className: 'dfy-meta' }, row.scope.accountId + ' / ' + row.scope.identityId + ' · ' + ({ candidate: '正在积累', applied: '已生效', reverted: '已撤销' }[row.status] || row.status) + ' · 依据 ' + row.evidence.length + ' 条交流'),
              h('details', null, h('summary', null, '查看依据'), (row.evidenceDetails || []).map((item) => h('p', { key: item.id, className: 'dfy-meta' }, item.at + ' · ' + item.quote))),
              row.status === 'candidate' ? button('确认这项相处习惯', () => act('growth-approve', { id: row.id })) : null,
              row.status !== 'reverted' ? button('撤销这项变化', () => act('growth-undo', { id: row.id })) : null)) : h('p', { className: 'dfy-meta' }, '尚无成长记录。核心人设不会被自动改写。')))
          : !failure ? h('p', null, '正在读取生活记录…') : null);
    }

    function MemoryPanel({ active, onDirtyChange, writeBlocked, accounts = [] }) {
      const [deleteChecked, setDeleteChecked] = useState(false);
      const api = usePanelApi();
      const [snapshot, setSnapshot] = useState(null), [filters, setFilters] = useState({ query: '', kind: 'all', status: 'all', scope: 'all' });
      const [selected, setSelected] = useState(null), [draft, setDraft] = useState(null), [base, setBase] = useState(null), [revision, setRevision] = useState('');
      const [busy, setBusy] = useState(''), [failure, setFailure] = useState(null), [notice, setNotice] = useState('');
      const lock = useRef(false), latest = useRef({}), editorId = useRef('dfy-memory-' + Math.random().toString(36).slice(2));
      const dirty = Boolean(draft && base && !equal(draft, base));
      latest.current = { selected, draft, base, dirty, revision };
      useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
      useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
      const values = (item) => ({ summary: item.summary || '', detail: item.detail || '',
        sourceType: item.provenance?.type === 'inference' ? 'inference' : 'user_explicit', confirmed: item.provenance?.confirmed === true });
      async function load(offset = snapshot?.offset || 0) {
        if (lock.current) return;
        lock.current = true; setBusy('read'); setFailure(null);
        try {
          const params = new URLSearchParams({ ...filters, offset: String(offset), limit: '50' });
          const result = await api.call('memory?' + params);
          const next = result.memory;
          if (!next || typeof next.revision !== 'string' || !Array.isArray(next.items)) throw new Error('记忆响应不完整');
          if (api.alive.current) {
            setSnapshot(next);
            const current = latest.current, record = next.items.find((item) => item.id === current.selected?.id);
            if (!current.dirty) {
              setSelected(record || null); setDraft(record ? values(record) : null); setBase(record ? values(record) : null); setRevision(next.revision);
            }
            setNotice(current.dirty ? '已读取最新记忆；未保存的纠正草稿已保留。' : '');
          }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      useEffect(() => { if (active && !snapshot) load(0); }, [active]);
      function open(item) {
        if (dirty) { setNotice('当前纠正草稿已保留，请先保存或明确放弃草稿。'); return; }
        setSelected(item); setDraft(values(item)); setBase(values(item)); setRevision(snapshot.revision); setFailure(null); setNotice('');
      }
      const latestRecord = snapshot?.items.find((item) => item.id === selected?.id);
      const conflict = Boolean(selected && revision && snapshot?.revision && revision !== snapshot.revision);
      const valid = draft && draft.summary.trim() && draft.summary.length <= 160 && draft.detail.trim() && draft.detail.length <= 2000;
      async function mutate(action) {
        if (lock.current || writeBlocked || !selected || !revision || conflict || action === 'delete' && !deleteChecked
          || action === 'correct' && (!dirty || !valid) || action !== 'correct' && dirty
          || action === 'restore' && !selected.canRestore || action === 'forget' && selected.status === 'forgotten') return;
        lock.current = true; setBusy(action); setFailure(null); setNotice('');
        try {
          const result = await api.call('memory/' + action, 'POST', { id: selected.id, revision,
            ...(action === 'correct' ? { ...draft, confirmed: draft.sourceType === 'inference' ? false : draft.confirmed } : {}) });
          if (action === 'delete' && result.memory?.deleted && typeof result.memory.revision === 'string') {
            if (api.alive.current) { setSnapshot((old) => ({ ...old, revision: result.memory.revision, total: Math.max(0, old.total - 1), items: old.items.filter((row) => row.id !== selected.id) }));
              setSelected(null); setDraft(null); setBase(null); setRevision(result.memory.revision); setNotice(result.memory.note); setDeleteChecked(false); }
            return;
          }
          if (!result.memory?.record || typeof result.memory.revision !== 'string') throw new Error('记忆保存回执不完整，请读取最新记忆核对。');
          if (api.alive.current) {
            const record = result.memory.record;
            setSelected(record); setDraft(values(record)); setBase(values(record)); setRevision(result.memory.revision);
            setSnapshot((previous) => ({ ...previous, revision: result.memory.revision,
              items: previous.items.map((item) => item.id === record.id ? record : item) }));
            setNotice(action === 'forget' ? '已不再记住这条内容。历史聊天和备份仍会保留。'
              : action === 'restore' ? '已撤销该条记忆最近一次修改或停用，请核对当前内容与状态。' : '纠正已保存，后续记忆检索使用新内容；已有聊天上下文不会自动擦除。');
          }
        } catch (error) { if (api.alive.current) setFailure(error); }
        finally { lock.current = false; if (api.alive.current) setBusy(''); }
      }
      const field = (key, label, multiline, maxLength) => h('div', { className: 'dfy-field', key },
        h('label', { className: 'dfy-label', htmlFor: editorId.current + '-' + key }, label),
        h(multiline ? 'textarea' : 'input', { id: editorId.current + '-' + key, ...(multiline ? { className: 'dfy-meme-text' } : { type: 'text' }),
          value: draft?.[key] || '', maxLength, disabled: Boolean(busy), onChange: (event) => { setDraft((previous) => ({ ...previous, [key]: event.target.value })); setNotice(''); } }));
      useEffect(() => { setDeleteChecked(false); }, [selected?.id]);
      const stateLabel = (item) => item.status === 'forgotten' ? '不再记住' : item.status === 'unconfirmed' ? '待确认' : '已记住';
      const scopeLabel = (item) => item.scope?.type === 'identity' ? '账号 ' + item.scope.accountId + ' / 身份 ' + item.scope.identityId
        : '账号 ' + (item.scope?.accountId || '未确认');
      const contextLabel = (item) => {
        const account = (Array.isArray(accounts) ? accounts : []).find((candidate) => candidate.qq === item.scope?.accountId);
        const name = account?.name || (account ? '未命名聊天对象' : '其他聊天对象');
        if (item.scope?.type !== 'identity') return name + ' · 所有身份';
        const identity = account?.identities?.find((candidate) => candidate.id === item.scope.identityId);
        return name + ' · ' + (identity?.name || '其他身份');
      };
      const provenanceLabel = (item) => item.provenance?.type === 'inference' ? '推测'
        : item.provenance?.type === 'user_explicit' ? '用户明确告知' : '旧记录，来源未进一步确认';
      return h('section', { className: 'dfy-section', 'aria-label': '记忆管理' },
        h(SectionHeading, { title: '记忆', help: '查看大肥鱼记住的内容，发现错误可以纠正，也可以选择不再记住。修改会影响后续回忆，历史聊天、已有对话和备份仍会保留。' },
          h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: () => load() }, busy === 'read' ? '读取中…' : '读取最新记忆')),
        h('p', { className: 'dfy-description' }, '这里是长期记忆目录：查找明确记住的事实、资料和重要旧事，再打开所需内容。近期聊天细节在“生活与成长”中随时间更替；没有自动把所有聊天永久保存。'),
        failure?.code === 'DELETE_PENDING' ? h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: async () => {
          if (lock.current) return; lock.current = true; setBusy('delete');
          try { const value = await api.call('memory/resume-delete', 'POST', { confirmed: true }); setFailure(null); setNotice(value.memory.note); }
          catch (error) { setFailure(error); } finally { lock.current = false; setBusy(''); }
        } }, '确认完成中断的记忆删除（不可撤销）') : null,
        h('div', { className: 'dfy-grid' },
          h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', htmlFor: editorId.current + '-query' }, '搜索记忆'),
            h('input', { id: editorId.current + '-query', type: 'text', value: filters.query, maxLength: 200, disabled: Boolean(busy) || dirty,
              onChange: (event) => setFilters((previous) => ({ ...previous, query: event.target.value })) })),
          h('div', { className: 'dfy-field' }, h('label', { className: 'dfy-label', htmlFor: editorId.current + '-filter-status' }, '状态'),
            h('select', { id: editorId.current + '-filter-status', value: filters.status, disabled: Boolean(busy) || dirty,
              onChange: (event) => setFilters((previous) => ({ ...previous, status: event.target.value })) },
              [['all', '全部'], ['active', '已记住'], ['forgotten', '不再记住'], ['unconfirmed', '待确认']].map(([value, name]) => h('option', { value, key: value }, name))))),
        h(Advanced, { title: filters.kind !== 'all' || filters.scope !== 'all' ? '更多筛选 · 已设置' : '更多筛选' },
          h('div', { className: 'dfy-grid' }, ...[['kind', '类型', [['all', '全部'], ['fact', '事实'], ['event', '事件']]],
            ['scope', '适用范围', [['all', '全部'], ['account', '账号'], ['identity', '身份']]]].map(([key, label, options]) =>
            h('div', { className: 'dfy-field', key }, h('label', { className: 'dfy-label', htmlFor: editorId.current + '-filter-' + key }, label),
              h('select', { id: editorId.current + '-filter-' + key, value: filters[key], disabled: Boolean(busy) || dirty,
                onChange: (event) => setFilters((previous) => ({ ...previous, [key]: event.target.value })) },
              options.map(([value, name]) => h('option', { value, key: value }, name))))))),
        h('div', { className: 'dfy-inline-actions', style: { marginTop: 12 } },
          h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || dirty, onClick: () => load(0) }, '筛选记忆')),
        failure ? h('div', { className: 'dfy-notice dfy-error', role: 'alert', style: { marginTop: 12 } }, failure.code === 'CONFLICT'
          ? '记忆已被其他操作修改。草稿已保留，请读取最新记忆，再核对采用。' : resourceError(failure)) : null,
        notice ? h('div', { className: 'dfy-notice', role: 'status', style: { marginTop: 12 } }, notice) : null,
        snapshot ? h(React.Fragment, null,
          h('p', { className: 'dfy-meta', style: { marginTop: 12 } }, '共 ', snapshot.total, ' 条；本页 ', snapshot.items.length, ' 条', snapshot.truncated ? ' · 还有更多结果，可翻到下一页' : ''),
          snapshot.items.length ? snapshot.items.map((item) => h('article', { className: 'dfy-suite-component', key: item.id },
            h('div', { className: 'dfy-resource-heading' }, h('strong', null, item.summary), h('span', { className: 'dfy-badge' }, stateLabel(item))),
            h('p', { className: 'dfy-hint' }, contextLabel(item)),
            h('button', { type: 'button', className: 'dfy-link-button', disabled: Boolean(busy) || dirty && selected?.id !== item.id,
              'aria-label': '查看与纠正记忆：' + item.summary + '，' + contextLabel(item), 'data-memory-id': item.id,
              onClick: () => open(item) }, '查看与纠正'))) : h('div', { className: 'dfy-empty' }, '没有找到记忆，可以换个关键词或状态。'),
          h('div', { className: 'dfy-toolbar' }, h('span', { className: 'dfy-meta' }, '第 ', Math.floor(snapshot.offset / 50) + 1, ' 页'),
            h('div', { className: 'dfy-inline-actions' },
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || dirty || snapshot.offset < 50, onClick: () => load(Math.max(0, snapshot.offset - 50)) }, '上一页记忆'),
              h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || dirty || snapshot.offset + snapshot.limit >= snapshot.total, onClick: () => load(snapshot.offset + snapshot.limit) }, '下一页记忆')))) : null,
        selected && draft ? h('div', { className: 'dfy-meme-editor', 'aria-label': '纠正记忆编辑器' },
          h('h3', null, '这条记忆'), h('p', { className: 'dfy-meta' }, contextLabel(selected), ' · ', stateLabel(selected), dirty ? ' · 有未保存的修改' : ''),
          conflict ? h('div', { className: 'dfy-notice dfy-warning' }, '最新记忆版本已变化，当前草稿尚未覆盖它。',
            latestRecord ? h('button', { type: 'button', className: 'dfy-link-button', disabled: Boolean(busy), onClick: () => {
              const nextBase = values(latestRecord), changed = Object.fromEntries(Object.entries(draft).filter(([key, value]) => !equal(value, base[key])));
              setSelected(latestRecord); setBase(nextBase); setDraft({ ...nextBase, ...changed }); setRevision(snapshot.revision); setFailure(null);
            } }, '采用最新记忆版本，保留我修改的字段') : h('p', null, '当前列表未包含这条记忆，请先核对筛选条件或放弃草稿。')) : null,
          field('summary', '记忆摘要', false, 160), field('detail', '具体内容', true, 2000),
          h('div', { className: 'dfy-field', style: { marginTop: 12 } },
            h('label', { className: 'dfy-label', htmlFor: editorId.current + '-source' }, '内容依据'),
            h('select', { id: editorId.current + '-source', value: draft.sourceType, disabled: Boolean(busy), onChange: (event) =>
              setDraft((previous) => ({ ...previous, sourceType: event.target.value, confirmed: event.target.value === 'inference' ? false : previous.confirmed })) },
            h('option', { value: 'user_explicit' }, '用户明确告知'), h('option', { value: 'inference' }, '推测，尚需本人确认'))),
          h('label', { className: 'dfy-toggle' }, h('span', { className: 'dfy-toggle-copy' }, '这条内容已由本人确认'),
            h('input', { type: 'checkbox', checked: draft.confirmed, disabled: Boolean(busy) || draft.sourceType === 'inference',
              'aria-label': '记忆已由本人确认', onChange: (event) => setDraft((previous) => ({ ...previous, confirmed: event.target.checked })) })),
          h(Advanced, { title: '来源与修改记录' },
            h('p', { className: 'dfy-meta' }, scopeLabel(selected), ' · 来源：', selected.source || '未确认', ' · ', provenanceLabel(selected)),
            selected.history?.length ? selected.history.map((item, index) => h('p', { key: index }, displayTime(item.at), ' · ',
              { correct: '纠正内容', forget: '不再记住', restore: '撤销最近修改' }[item.action] || '记忆变更', item.summary ? ' · ' + item.summary : ''))
              : h('p', { className: 'dfy-meta' }, '暂无修改记录。')),
          writeBlocked ? h('p', { className: 'dfy-hint' }, '当前有任务处理、服务维护或配置待应用；可查看和保留草稿，稍后再保存记忆。') : null,
          h('p', { className: 'dfy-hint' }, '选择不再记住后，历史聊天和备份仍会保留。'),
          h('div', { className: 'dfy-inline-actions', style: { marginTop: 12 } },
            dirty ? h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy), onClick: () => {
              const record = latestRecord || selected; setSelected(record); setDraft(values(record)); setBase(values(record)); setRevision(snapshot.revision); setFailure(null);
            } }, '放弃记忆纠正草稿') : null,
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || writeBlocked || dirty || conflict || selected.status === 'forgotten', onClick: () => mutate('forget') }, '不再记住'),
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || writeBlocked || dirty || conflict || !selected.canRestore, onClick: () => mutate('restore') }, '撤销最近一次修改或停用'),
            h('label', null, h('input', { type: 'checkbox', checked: deleteChecked, onChange: (event) => setDeleteChecked(event.target.checked) }), ' 确认删除此条原档案与更正历史；DSH聊天和外部备份仍保留'),
            h('button', { type: 'button', className: 'dfy-button', disabled: Boolean(busy) || writeBlocked || dirty || conflict || !deleteChecked, onClick: () => mutate('delete') }, '删除受管原始记忆'),
            h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: Boolean(busy) || writeBlocked || !dirty || !valid || conflict, onClick: () => mutate('correct') }, busy === 'correct' ? '保存纠正中…' : '保存记忆纠正'))) : null);
    }
    function Panel() {
      const [snapshot, setSnapshot] = useState(null);
      const [base, setBase] = useState({});
      const [draft, setDraft] = useState({});
      const [revision, setRevision] = useState('');
      const [token, setToken] = useState('');
      const [clearToken, setClearToken] = useState(false);
      const [tab, setTab] = useState('overview');
      const [visitedTabs, setVisitedTabs] = useState(['overview']);
      const [personaDirty, setPersonaDirty] = useState(false);
      const [modelDirty, setModelDirty] = useState(false);
      const [voiceDirty, setVoiceDirty] = useState(false);
      const [speechDirty, setSpeechDirty] = useState(false);
      const [galleryDirty, setGalleryDirty] = useState(false);
      const [memoryDirty, setMemoryDirty] = useState(false);
      const [lifeDirty, setLifeDirty] = useState(false);
      const [capabilitiesBusy, setCapabilitiesBusy] = useState(false);
      const [resourceRefreshKey, setResourceRefreshKey] = useState(0);
      const [operation, setOperation] = useState('');
      const [queuedApply, setQueuedApply] = useState(false);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState('');
      const [updatedAt, setUpdatedAt] = useState('');
      const [runtimeRefreshFailed, setRuntimeRefreshFailed] = useState(false);
      const [issueDetailsOpen, setIssueDetailsOpen] = useState(false);
      const [conversationHighlighted, setConversationHighlighted] = useState(false);
      const live = useRef(false);
      const lock = useRef(false);
      const currentRequest = useRef(null);
      const runtimePollRequest = useRef(null);
      const runtimePollGeneration = useRef(0);
      const refreshGeneration = useRef(0);
      const latest = useRef({});
      const capabilityBusyChanged = useRef(null);
      if (!capabilityBusyChanged.current) capabilityBusyChanged.current = (value) => {
        latest.current.capabilitiesBusy = value; setCapabilitiesBusy(value);
      };
      const panelId = useRef('dfy-' + Math.random().toString(36).slice(2));
      const panelRoot = useRef(null);
      const scrollAfterNavigation = useRef(false);
      const conversationArea = useRef(null);
      const config = snapshot && snapshot.config || {};
      const runtime = snapshot && snapshot.runtime || {};
      const overridden = Array.isArray(config.overriddenFields) ? config.overriddenFields : [];
      const pendingReload = Boolean(snapshot && (snapshot.pendingReload || config.requiresReload));
      const dirty = Object.keys(draft).length > 0 || token !== '' || clearToken;
      latest.current = { draft, token, clearToken, dirty, revision, base, snapshot, personaDirty, modelDirty, voiceDirty, speechDirty, galleryDirty, memoryDirty, lifeDirty, capabilitiesBusy };
      const blocked = Boolean(operation) || capabilitiesBusy;
      const externalChange = Boolean(dirty && revision && config.revision && config.revision !== revision);
      const fieldErrors = [...(Array.isArray(config.validationErrors) ? config.validationErrors : []),
        ...(error && Array.isArray(error.validationErrors) ? error.validationErrors : [])];

      async function request(route, method, payload) {
        runtimePollGeneration.current++; runtimePollRequest.current?.abort();
        const controller = new AbortController();
        currentRequest.current = controller;
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
          const response = await fetch('/dafeiyu-panel/api/' + route, {
            method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
            headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
            ...(method === 'POST' ? { body: JSON.stringify(payload || {}) } : {}), signal: controller.signal,
          });
          let body;
          try { body = await response.json(); } catch { body = null; }
          if (!response.ok || !body || body.ok !== true) {
            const failure = new Error(typeof body?.error === 'string' ? body.error : body?.error?.message
              || body?.message || '服务暂不可用（HTTP ' + response.status + '），请稍后刷新');
            failure.code = body?.code || body?.error?.code || '';
            failure.status = response.status;
            failure.validationErrors = body?.validationErrors || body?.error?.validationErrors;
            throw failure;
          }
          return body;
        } catch (failure) {
          if (failure.name === 'AbortError') {
            const unknown = new Error(method === 'POST' ? '请求未得到确认，请刷新核对保存或应用状态；草稿已保留' : '读取状态超时，请重试');
            unknown.code = 'UNCONFIRMED';
            throw unknown;
          }
          throw failure;
        } finally {
          clearTimeout(timeout);
          if (currentRequest.current === controller) currentRequest.current = null;
        }
      }
      function acceptState(value, resetEditor) {
        if (!value.config || typeof value.config.revision !== 'string') throw new Error('配置响应不完整，请刷新重试');
        if (!live.current) return;
        setSnapshot(value);
        setRuntimeRefreshFailed(false);
        setResourceRefreshKey((previous) => previous + 1);
        setUpdatedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        if (resetEditor || !latest.current.dirty) {
          setBase(baseValues(value.config));
          setRevision(value.config.revision);
          if (resetEditor) { setDraft({}); setToken(''); setClearToken(false); }
        }
      }
      async function refresh() {
        if (lock.current) return;
        const generation = ++refreshGeneration.current;
        lock.current = true;
        setOperation('refresh');
        setError(null);
        try {
          let state;
          for (let attempt = 0; attempt < 5 && live.current; attempt++) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
            if (!live.current || refreshGeneration.current !== generation) return;
            try { state = await request('state'); break; }
            catch (failure) { if (![404, 503].includes(failure.status) || attempt === 4) throw failure; }
          }
          if (!state || refreshGeneration.current !== generation) return;
          acceptState(state, false);
          if (live.current) setNotice(latest.current.dirty || latest.current.personaDirty || latest.current.modelDirty || latest.current.voiceDirty || latest.current.speechDirty || latest.current.galleryDirty || latest.current.memoryDirty || latest.current.lifeDirty
            ? '状态已刷新，未保存的草稿已保留。' : '');
        } catch (failure) { if (live.current && refreshGeneration.current === generation) setError(failure); }
        finally {
          if (refreshGeneration.current === generation) {
            lock.current = false;
            if (live.current) setOperation('');
          }
        }
      }
      async function checkPhone() {
        if (lock.current || runtime.busy || pendingReload || latest.current.dirty || latest.current.personaDirty || latest.current.modelDirty || latest.current.voiceDirty || latest.current.speechDirty || latest.current.galleryDirty || latest.current.memoryDirty || latest.current.lifeDirty) return;
        lock.current = true; setOperation('phone'); setError(null);
        try {
          const result = await request('phone/check', 'POST', {});
          if (live.current) {
            if (result.state) acceptState(result.state, false);
            setNotice('已检查指定设备连接；未截图、录音或操作手机。');
          }
        } catch (failure) { if (live.current) setError(failure); }
        finally { lock.current = false; if (live.current) setOperation(''); }
      }
      async function connectPhone() {
        if (lock.current || runtime.busy || pendingReload || runtime.phone?.canConnect !== true || latest.current.dirty
          || latest.current.personaDirty || latest.current.modelDirty || latest.current.voiceDirty || latest.current.speechDirty || latest.current.galleryDirty || latest.current.memoryDirty || latest.current.lifeDirty) return;
        lock.current = true; setOperation('phone-connect'); setError(null);
        try {
          const result = await request('phone/connect', 'POST', {});
          if (live.current) {
            if (result.state) acceptState(result.state, false);
            setNotice(result.state?.runtime?.phone?.state === 'online' ? '已连接配置的设备并确认在线；未读取手机内容。'
              : '已尝试连接配置的设备，尚未确认在线；请查看连接状态与教程。');
          }
        } catch (failure) { if (live.current) setError(failure); }
        finally { lock.current = false; if (live.current) setOperation(''); }
      }
      useEffect(() => {
        live.current = true;
        refresh();
        return () => {
          live.current = false;
          refreshGeneration.current++;
          lock.current = false;
          currentRequest.current?.abort();
          runtimePollRequest.current?.abort();
        };
      }, []);
      useEffect(() => {
        if (tab !== 'overview') return;
        let stopped = false, timer;
        async function poll() {
          if (stopped || !live.current) return;
          if (!lock.current && (typeof document === 'undefined' || !document.hidden)) {
            const generation = ++runtimePollGeneration.current;
            const controller = new AbortController(); runtimePollRequest.current = controller;
            let timedOut = false;
            const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
            try {
              const response = await fetch('/dafeiyu-panel/api/state', { credentials: 'same-origin', cache: 'no-store',
                headers: { Accept: 'application/json' }, signal: controller.signal });
              const result = await response.json();
              if (!response.ok || result?.ok !== true || !result.runtime) throw new Error();
              if (!stopped && live.current && generation === runtimePollGeneration.current && !lock.current) {
                setSnapshot((previous) => previous ? { ...previous, runtime: result.runtime } : previous);
                setUpdatedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
                setRuntimeRefreshFailed(false);
              }
            } catch {
              if (!stopped && live.current && generation === runtimePollGeneration.current && (!controller.signal.aborted || timedOut)) setRuntimeRefreshFailed(true);
            } finally {
              clearTimeout(timeout);
              if (runtimePollRequest.current === controller) runtimePollRequest.current = null;
            }
          }
          if (!stopped) timer = setTimeout(poll, 5000);
        }
        timer = setTimeout(poll, 5000);
        return () => { stopped = true; clearTimeout(timer); runtimePollGeneration.current++; runtimePollRequest.current?.abort(); };
      }, [tab]);
      function changeFields(patch) {
        if (blocked || Object.keys(patch).some((key) => overridden.includes(key))) return;
        const next = { ...latest.current.draft };
        for (const [key, candidate] of Object.entries(patch)) {
          if (equal(candidate, base[key])) delete next[key]; else next[key] = candidate;
        }
        latest.current.draft = next;
        latest.current.dirty = Object.keys(next).length > 0 || latest.current.token !== '' || latest.current.clearToken;
        setDraft(next);
        setNotice('');
        if (error && error.code !== 'CONFLICT') setError(null);
      }
      function change(key, candidate) { changeFields({ [key]: candidate }); }
      useEffect(() => {
        if (!scrollAfterNavigation.current) return;
        scrollAfterNavigation.current = false;
        panelRoot.current?.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'auto' });
      }, [tab]);
      function selectTab(key) {
        const group = tabGroups.find((candidate) => candidate.id === key);
        const target = group && group.children.length ? group.children[0] : key;
        if (target !== 'overview' && !groupOfKey.has(target)) return;
        if (tab === target) panelRoot.current?.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'auto' });
        else scrollAfterNavigation.current = true;
        setVisitedTabs((previous) => previous.includes(target) ? previous : [...previous, target]);
        setTab(target);
      }
      function value(key) {
        if (overridden.includes(key)) return own(config.effective, key) ? config.effective[key] : defaults[key];
        return own(draft, key) ? draft[key] : own(base, key) ? base[key] : defaults[key];
      }
      function changePrimaryAccount(nextQq, reassignOnly = false) {
        const previousQq = String(value('ownerQq') || '');
        const accounts = Array.isArray(value('qqAccounts')) ? value('qqAccounts') : [];
        if (reassignOnly) { changeFields({ ownerQq: nextQq }); return; }
        const primaryIndex = accounts.findIndex((account) => account.qq === previousQq);
        let nextAccounts = accounts;
        if (primaryIndex >= 0) nextAccounts = accounts.map((account, index) => index === primaryIndex ? { ...account, qq: nextQq } : account);
        else if (nextQq) {
          const first = freshIdentity(); first.name = '默认身份';
          nextAccounts = [...accounts, { qq: nextQq, name: '主要使用者', enabled: true, activeIdentityId: first.id, identities: [first] }];
        }
        changeFields({ ownerQq: nextQq, qqAccounts: nextAccounts });
      }
      async function save() {
        if (lock.current || latest.current.capabilitiesBusy || !snapshot || !revision) return;
        if (accountErrors.length) return;
        if (latest.current.snapshot?.runtime?.busy === true) {
          setQueuedApply(true);
          setNotice('她正在处理消息。处理完成后会自动保存并生效。');
          return;
        }
        lock.current = true;
        setOperation('apply');
        setError(null); setNotice('');
        let saved = false;
        try {
          const current = latest.current;
          const overriddenDraft = Object.keys(current.draft).filter((key) => overridden.includes(key));
          if (overriddenDraft.length) {
            const conflict = new Error('有由 DSH 管理字段的本地草稿，这些字段不会随本次保存写入；请在 DSH 设置中修改它们。');
            conflict.code = 'CONFLICT'; throw conflict;
          }
          // 冲突自愈：配置在外部被修改时自动采用最新版本并保留本地草稿，不打断保存。
          const resync = async () => {
            const state = await request('state');
            if (!state.config || typeof state.config.revision !== 'string') throw new Error('配置响应不完整，请刷新重试');
            const nextBase = baseValues(state.config);
            const nextDraft = Object.fromEntries(Object.entries(current.draft)
              .filter(([key, candidate]) => !overridden.includes(key) && !equal(candidate, nextBase[key])));
            current.base = nextBase; current.revision = state.config.revision;
            current.draft = nextDraft; current.dirty = Object.keys(nextDraft).length > 0 || current.token !== '' || current.clearToken;
            if (live.current) { setBase(nextBase); setRevision(state.config.revision); setDraft(nextDraft); }
            return state;
          };
          if (externalChange) await resync();
          if (current.dirty) {
            const payload = () => {
              const patch = { ...current.draft };
              if (current.token !== '' && !current.clearToken) patch.onebotAccessToken = current.token;
              return { patch, revision: current.revision, clearSecrets: current.clearToken ? ['onebotAccessToken'] : [] };
            };
            let result;
            try { result = await request('config', 'POST', payload()); }
            catch (failure) {
              if (failure.code !== 'CONFLICT' || !live.current) throw failure;
              await resync();
              result = await request('config', 'POST', payload());
            }
            acceptState(result, true);
            saved = true;
          }
          if (personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty || memoryDirty || lifeDirty) {
            if (live.current) setNotice('配置已保存。其他页面还有独立草稿，先保存它们，再点「生效」。');
          } else if (live.current && snapshot.canApply) {
            await request('apply', 'POST', {});
            let state;
            for (let attempt = 0; attempt < 5 && live.current; attempt++) {
              if (attempt) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
              if (!live.current) return;
              try { state = await request('state'); break; }
              catch (failure) { if (![404, 503].includes(failure.status) || attempt === 4) throw failure; }
            }
            if (state) {
              acceptState(state, true);
              if (live.current) setNotice(state.pendingReload || state.config?.requiresReload
                ? '应用请求已完成，服务仍报告等待重载，请核对当前生效配置。'
                : '配置已保存并生效。');
            }
          } else if (saved && live.current) {
            setNotice('配置已保存。当前宿主暂不支持页内生效，重新加载 DSH 后生效。');
          }
        } catch (failure) {
          if (live.current) {
            setError(failure);
            if (saved) {
              setSnapshot((previous) => previous && ({ ...previous, pendingReload: true }));
              setNotice('配置已保存，应用尚未确认。稍后点一次「生效」即可，无需重新填写。');
            }
          }
        } finally { lock.current = false; if (live.current) setOperation(''); }
      }
      useEffect(() => {
        if (!queuedApply || runtime.busy === true || capabilitiesBusy || lock.current) return;
        setQueuedApply(false);
        const stillPending = latest.current.dirty || latest.current.snapshot?.pendingReload
          || latest.current.snapshot?.config?.requiresReload;
        if (stillPending) save();
      }, [queuedApply, runtime.busy, capabilitiesBusy]);
      function tag(key) {
        return overridden.includes(key) ? h('span', { className: 'dfy-badge' }, '由 DSH 管理') : null;
      }
      function hint(key, text) {
        const format = (candidate) => typeof candidate === 'boolean' ? candidate ? '开启' : '关闭'
          : Array.isArray(candidate) ? candidate.join('、') || '无' : String(candidate || '未填写');
        const different = own(config.saved, key) && own(config.effective, key) && !equal(config.saved[key], config.effective[key]);
        return h(React.Fragment, null,
          overridden.includes(key) ? h('div', { className: 'dfy-hint', id: panelId.current + '-' + key + '-hint' },
            '请在 DSH 设置中修改此项。') : null,
          different ? h('div', { className: 'dfy-hint' },
            '当前使用其他设置；本地保存值：' + format(config.saved[key]) + ' · 实际使用值：' + format(config.effective[key])) : null,
          pendingReload && config.running && own(config.running, key) && !equal(value(key), config.running[key])
            ? h('div', { className: 'dfy-hint' }, '尚未生效，当前使用：' + format(config.running[key])) : null,
          fieldErrors.filter((item) => item.field === key).map((item, index) =>
            h('div', { className: 'dfy-field-error', key: index }, String(item.message || '字段无效'))));
      }
      function field(key, label, help, options) {
        const opts = options || {};
        const id = panelId.current + '-' + key;
        const props = { id, value: String(value(key) ?? ''), disabled: blocked || overridden.includes(key),
          'aria-describedby': overridden.includes(key) ? id + '-hint' : undefined, 'aria-invalid': fieldErrors.some((item) => item.field === key) || undefined,
          onChange: (event) => change(key, opts.numeric ? Number(event.target.value) : event.target.value) };
        return h('div', { className: 'dfy-field', key },
          h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: id }, label, tag(key)),
            help ? h(HelpTip, { label }, help) : null),
          opts.select ? h('select', props, opts.select.map((choice) => h('option', { value: choice, key: choice }, choice + ' 秒')))
            : h('input', { ...props, type: 'text', autoComplete: 'off', spellCheck: false,
              placeholder: opts.placeholder || '', ...(opts.qq ? { inputMode: 'numeric', maxLength: 20 } : {}) }),
          hint(key, help));
      }
      function toggle(key, label, help) {
        const id = panelId.current + '-' + key;
        return h('div', { key, className: 'dfy-toggle' },
            h('div', { className: 'dfy-toggle-copy' },
              h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-toggle-title', htmlFor: id }, label, tag(key)),
                help ? h(HelpTip, { label }, help) : null),
              hint(key, help)),
            h('input', { id, type: 'checkbox', checked: value(key) === true, disabled: blocked || overridden.includes(key),
              'aria-describedby': overridden.includes(key) ? id + '-hint' : undefined, onChange: (event) => change(key, event.target.checked) }));
      }
      function toolToggle(name, label, help) {
        const selected = Array.isArray(value('allowedPhoneTools')) ? value('allowedPhoneTools') : [];
        const id = panelId.current + '-tool-' + name;
        return h('div', { className: 'dfy-toggle', key: name },
          h('div', { className: 'dfy-toggle-copy dfy-titleline' },
            h('label', { className: 'dfy-toggle-title', htmlFor: id }, label), h(HelpTip, { label }, help)),
          h('input', { id, type: 'checkbox', checked: selected.includes(name),
            disabled: blocked || overridden.includes('allowedPhoneTools'),
            onChange: (event) => change('allowedPhoneTools', tools.map((item) => item[0])
              .filter((item) => item === name ? event.target.checked : selected.includes(item))) }));
      }
      function section(title, description, children, actions) {
        return h('section', { className: 'dfy-section' }, h(SectionHeading, { title, help: description }, actions), children);
      }
      function readonly(label, text) {
        return h('div', { className: 'dfy-readonly', key: label }, h('span', null, label), h('span', null, text));
      }
      const qq = qqStatus(runtime.personalQQ);
      const companion = companionStatus(runtime.companion, runtime);
      const paths = snapshot && snapshot.paths || {};
      const secretConfigured = config.secretConfigured || {};
      const secretId = panelId.current + '-token';
      const engine = config.effective?.onebotEngine || '尚未读取';
      const policyConflict = engine !== '尚未读取' && engine !== 'native' || config.effective?.catchUpUnread === true;
      const overrideDraft = Object.keys(draft).some((key) => overridden.includes(key));
      const editedAccounts = Array.isArray(value('qqAccounts')) ? value('qqAccounts') : [];
      const accountErrors = accountValidation(editedAccounts, value('ownerQq'), value('onebotSelfId'));
      const runningAccounts = Array.isArray(config.running?.qqAccounts) ? config.running.qqAccounts : [];
      const conversationIssues = currentConversationIssues(runtime.companion);
      const unlocatedIssue = unlocatedConversationIssue(runtime.companion);
      const hasConversationIssue = conversationIssues.length > 0 || unlocatedIssue;
      const onlyInputIssues = conversationIssues.length > 0 && conversationIssues.every(conversationNeedsInput);
      const issueDetailsId = panelId.current + '-issue-details';
      const conversationAreaId = panelId.current + '-conversation-state';
      const operationBlocked = blocked || runtime.busy === true || runtime.phone?.checking === true || dirty || pendingReload
        || personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty || memoryDirty || lifeDirty;
      const operationReason = dirty || pendingReload || personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty || memoryDirty || lifeDirty
        ? '请先保存并生效相关配置，避免使用未生效的设备设置。' : runtime.busy || runtime.phone?.checking ? '当前有任务执行，请完成后再操作。' : '';
      // 教程全文已迁至仓库 docs/面板排查指南.md；面板内只保留最常用的 QQ 连接篇，其余以指引代替。
      function guide(kind) {
        const content = {
          qq: {
            title: 'QQ 连接教程与排查',
            steps: ['到「高级 · 安装与更新」检测 QQ 接入套件。Linux QQ 和 NapCat 共用一个容器，启动与更新只需操作一次。',
              '到「聊天 · QQ账号」检查小号登录，明确点击获取二维码后，用手机 QQ 扫码确认小号；容器运行不代表已经登录。',
              '二维码反复登录失败时，可到「高级 · 安装与更新」的 QQ 接入套件点击「重启 QQ 服务」，保留配置和登录资料；重启会短暂断开 QQ，完成后再检查登录状态。',
              '到「聊天 · 聊天对象」配置可接待的用户和关系，再核对接收小号、本机 OneBot 地址和令牌，保存生效。用已启用用户私聊小号测试，仍未回复时检查当前页最近收发和模型状态。'],
            links: [['NapCat 接入教程', 'https://napneko.github.io/guide/napcat']],
          },
        }[kind];
        return h('details', { className: 'dfy-detail' }, h('summary', null, content.title),
          h('div', { className: 'dfy-guide-copy' }, h('ol', null, content.steps.map((step, index) => h('li', { key: index }, step))),
            (content.links || []).map(([label, url]) => h('p', { key: url }, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label)))));
      }
      const guideDoc = (topic) => h('details', { className: 'dfy-detail' }, h('summary', null, topic + ' 排查指南'),
        h('div', { className: 'dfy-guide-copy' }, h('p', null, '完整排查步骤在仓库 ', h('code', null, 'docs/面板排查指南.md'), ' 的「' + topic + '」一节。')));
      const navButton = (label, target) => h('button', { key: target + ':' + label, type: 'button', className: 'dfy-button', onClick: () => selectTab(target) }, label);
      const overview = h(React.Fragment, null,
        h('section', { className: 'dfy-section', 'aria-label': '大肥鱼当前状态' },
          h('div', { className: 'dfy-home-status' },
            h('div', { className: 'dfy-titleline' }, h(hasConversationIssue ? 'button' : 'strong', {
              className: 'dfy-home-status-title dfy-' + companion[1] + (hasConversationIssue ? ' dfy-home-status-trigger' : ''),
              ...(hasConversationIssue ? { type: 'button', 'aria-expanded': issueDetailsOpen, 'aria-controls': issueDetailsId,
                onClick: () => setIssueDetailsOpen((open) => !open) } : {}) },
              h('span', { className: 'dfy-dot', 'aria-hidden': true }), ' ', companion[0],
              hasConversationIssue ? h('span', { 'aria-hidden': true }, issueDetailsOpen ? '⌃' : '⌄') : null),
              h(HelpTip, { label: '当前状态' }, '状态会自动更新。最近更新时间：' + (updatedAt || '尚未读取') + '。当前页面不会替你发送消息或操作设备。')),
            h('button', { className: 'dfy-button', type: 'button', disabled: blocked, onClick: refresh }, operation === 'refresh' ? '刷新中…' : '刷新状态')),
          runtimeRefreshFailed ? h('div', { className: 'dfy-notice dfy-warning', role: 'alert' }, '状态更新失败，当前显示上次结果。请刷新后再确认连接。') : null,
          hasConversationIssue ? h('div', { className: 'dfy-notice' + (onlyInputIssues ? '' : ' dfy-warning'), role: onlyInputIssues ? 'status' : 'alert' },
            h('p', null, onlyInputIssues ? String(conversationIssues.length) + ' 条消息暂未处理，可展开原因和发生时间。'
              : conversationIssues.length ? String(conversationIssues.length) + ' 个聊天状态需要查看，可展开原因和发生时间。'
              : '有一条旧处理记录尚未定位到具体聊天，请先查看说明。'),
            h('button', { type: 'button', className: 'dfy-button', style: { marginTop: 10 }, 'aria-expanded': issueDetailsOpen,
              'aria-controls': issueDetailsId, onClick: () => setIssueDetailsOpen((open) => !open) }, onlyInputIssues
                ? issueDetailsOpen ? '收起消息详情' : '查看消息详情' : issueDetailsOpen ? '收起异常详情' : '查看异常详情'),
            h('div', { id: issueDetailsId, className: 'dfy-home-issue-details', hidden: !issueDetailsOpen, 'aria-label': onlyInputIssues ? '消息详情' : '异常详情' },
              conversationIssues.map((item) => {
                const account = runningAccounts.find((candidate) => candidate.qq === item.qq);
                return h('article', { className: 'dfy-home-issue', key: item.qq + ':' + item.identityId },
                  h('strong', null, account?.name || 'QQ ' + item.qq, ' / ', item.identityName || item.identityId || '身份未确认'),
                  h('p', null, '原因：', conversationFailures[item.failureType] || (item.state === 'blocked' ? '会话已暂停，具体原因尚未确认' : '处理未完成，具体原因尚未确认')),
                  h('p', null, '发生时间：', item.failedAt ? displayTime(item.failedAt) : '时间未记录'),
                  item.requiresUncertainAcknowledgement ? h('p', null, '执行或送达结果未知。请先核对结果，再在聊天状态中决定是否恢复。') : null);
              }),
              conversationIssues.length ? h(React.Fragment, null,
                h('p', { className: 'dfy-hint' }, '下方聊天状态提供对应处理入口。查看详情不会恢复聊天或重试原请求。'),
                h('button', { type: 'button', className: 'dfy-button', style: { marginTop: 8 }, 'aria-controls': conversationAreaId,
                  onClick: () => { setConversationHighlighted(true); conversationArea.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' }); } }, '查看聊天状态'))
                : h('p', { className: 'dfy-hint' }, '当前没有可对应的会话详情，无法确认对象、原因或发生时间。请刷新状态后核对；这里不会跳转到无关任务，也不会自动重试。'))) : null),
        h('nav', { className: 'dfy-home-shortcuts dfy-inline-actions', 'aria-label': '常用入口' },
          h('span', { className: 'dfy-meta' }, '常用入口'), navButton('查看功能', 'capabilities'), navButton('查看任务', 'background')),
        h('div', { className: 'dfy-home-summary', 'aria-label': '连接状态' },
          h('div', { className: 'dfy-card' }, h('div', { className: 'dfy-titleline' }, h('span', { className: 'dfy-card-label' }, 'QQ'),
            h(HelpTip, { label: 'QQ连接' }, '使用接收小号登录后，已启用的聊天对象就可以通过 QQ 与大肥鱼交流。')),
            h('div', { className: 'dfy-card-value dfy-' + qq[1] }, h('span', { className: 'dfy-dot', 'aria-hidden': true }), qq[0]),
            h('div', { className: 'dfy-home-actions' }, navButton(qq[1] === 'good' ? '管理QQ' : '连接QQ', 'qq')),
            qq[1] !== 'good' ? h(HomeQrInline, null) : null),
          h('div', { className: 'dfy-card' }, h('div', { className: 'dfy-titleline' }, h('span', { className: 'dfy-card-label' }, '手机'),
            h(HelpTip, { label: '手机连接' }, '手机连接与允许的操作分别设置；连接成功不代表已授权所有操作。')),
            h('div', { className: 'dfy-card-value dfy-' + (runtime.phone?.state === 'online' ? 'good' : 'neutral') },
              h('span', { className: 'dfy-dot', 'aria-hidden': true }), phoneStatus(runtime.phone)),
            h('div', { className: 'dfy-home-actions' }, navButton(runtime.phone?.state === 'online' ? '手机设置' : '连接手机', 'phone'))),
          h('div', { className: 'dfy-card' }, h('div', { className: 'dfy-titleline' }, h('span', { className: 'dfy-card-label' }, '语音'),
            h(HelpTip, { label: '语音' }, '接收语音和语音回复可以分别开启。识别结果以实际收到的语音为准。')),
            h('div', { className: 'dfy-card-value' }, voiceInputStatus(runtime.voiceInput)),
            h('div', { className: 'dfy-home-actions' }, navButton('声音设置', 'voice'))),
          h('div', { className: 'dfy-card' }, h('div', { className: 'dfy-titleline' }, h('span', { className: 'dfy-card-label' }, '任务'),
            h(HelpTip, { label: '任务' }, '耗时任务可以在后台进行，期间仍可聊天。打开任务页查看进度、结果或取消。')),
            h('div', { className: 'dfy-card-value' }, Number(runtime.backgroundTasks?.active) > 0 ? String(runtime.backgroundTasks.active) + ' 项进行中' : '暂无进行中的任务'),
            h('div', { className: 'dfy-home-actions' }, navButton('管理任务', 'background')))),
        (runtime.companion?.conversations || []).some((item) => item.running || item.queued || ['failed', 'blocked'].includes(item.state))
          ? h('div', { id: conversationAreaId, ref: conversationArea, className: 'dfy-conversation-location',
            'data-highlighted': conversationHighlighted ? 'true' : undefined }, h(ConversationPanel, { conversations: (runtime.companion?.conversations || []).filter((item) => item.running || item.queued || ['failed', 'blocked'].includes(item.state)), accounts: runningAccounts,
            recoveryBlocked: dirty || pendingReload || personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty || memoryDirty || lifeDirty,
            controlBlocked: blocked || runtime.applying === true, onNavigate: selectTab, onNotice: setNotice,
            onUpdated: (state) => state ? acceptState(state, false) : refresh() })) : null,
        h('section', { className: 'dfy-section', style: { marginTop: 16 } },
          h(SectionHeading, { title: '聊天对象', help: '这里显示当前启用的聊天对象和身份。可以在设置中添加账号或调整关系。' }, navButton('管理聊天对象', 'accounts')),
          runningAccounts.some((account) => account.enabled) && engine !== 'legacy'
            ? runningAccounts.filter((account) => account.enabled).slice(0, 3).map((account) => {
              const identity = account.identities?.find((item) => item.id === account.activeIdentityId);
              return h('div', { className: 'dfy-account-running', key: account.qq }, h('strong', null, account.name || account.qq),
                ' · ', identity?.name || '尚未选择身份', ' · ', relationLabel(identity));
            }) : h('p', { className: 'dfy-meta' }, '还没有启用聊天对象。'),
          runningAccounts.filter((account) => account.enabled).length > 3 ? h('p', { className: 'dfy-meta' }, '还有其他聊天对象，可在管理中查看。') : null),
        h(Advanced, { title: '高级设置' },
          h(DesktopContextPanel, { active: tab === 'overview', autoLoad: false, controlBlocked: blocked || pendingReload || runtime.applying === true }),
          h('div', { className: 'dfy-status-table' },
            readonly('服务状态', runtime.ready === true ? '已启动' : runtime.ready === false ? '未启动' : '尚未读取'),
            readonly('当前任务', runtime.busy ? '有任务运行' : '当前空闲'),
            readonly('上下文保护', runtime.contextProtection?.enabled === true ? '已加载 · 容量不足时暂停' : '尚未确认'),
            readonly('等待处理', String(Number(runtime.companion?.pending || 0)) + ' 项'),
            readonly('QQ 会话', runtime.personalQQ?.sessionCreated ? '已创建' : '尚未创建'),
            readonly('当前模型', runtime.model?.activeSelection ? selectionLabel(runtime.model.activeSelection) : '新对话使用默认模型'),
            readonly('默认模型', selectionLabel(runtime.model?.defaultSelection)),
            readonly('最近收到消息', displayTime(runtime.companion?.lastEventAt)),
            readonly('最近回复', displayTime(runtime.companion?.lastReplyAt)),
            readonly('配置', pendingReload ? '已保存，等待生效' : '当前设置已生效')),
          h('div', { className: 'dfy-paths' },
            [['configFile', '私有配置'], ['memoryProjectRoot', '角色与记忆'], ['companionConfigPath', '伴侣配置'], ['memeDir', '图库']]
              .map(([key, label]) => h('div', { className: 'dfy-path', key }, h('span', null, label), h('code', null, paths[key] || '尚未读取')))),
          guideDoc('消息引擎')));
      const qqPanel = h(React.Fragment, null,
        visitedTabs.includes('qq') ? h(NapCatPanel, { active: tab === 'qq', refreshKey: resourceRefreshKey,
          expectedSelfId: config.running?.onebotSelfId || config.effective?.onebotSelfId || '', onNavigate: selectTab }) : null,
        section('接收消息', '登录接收小号后，开启消息连接。可接待的用户和关系在“聊天对象”中管理。修改设置后需保存并生效。', [
          readonly('聊天连接', qq[0]),
          toggle('autoStartOneBot', '接收 QQ 消息', '开启后接收已启用用户发给小号的私聊；关闭后停止个人 QQ 接入。'),
          h('div', { className: 'dfy-grid', key: 'ids', style: { marginTop: 16 } },
            field('onebotSelfId', '接收小号 QQ', '填写上方登录的小号 QQ，不是向它发消息的主号。', { qq: true })),
          h('div', { className: 'dfy-inline-actions', key: 'accounts', style: { marginTop: 12 } }, navButton('管理聊天对象', 'accounts')),
        ]),
        clearToken ? h('p', { className: 'dfy-notice dfy-warning', role: 'status' }, '保存后会清除已保存的 QQ 访问令牌，请同时核对 QQ 服务的认证设置。') : null,
        h('section', { className: 'dfy-section' }, h(Advanced, { title: '高级设置' },
          h(SectionHeading, { title: 'OneBot 连接', help: '仅允许本机回环地址。正向 WebSocket 使用根路径，避免填写仅提供 API 的 /api 路径。' }),
          h('div', { className: 'dfy-grid', key: 'urls' },
            field('onebotWs', 'WebSocket 地址', '个人 QQ 的消息入口。', { placeholder: 'ws://127.0.0.1:3001/' }),
            field('onebotHttp', 'HTTP 地址（可选）', '没有启用 HTTP 服务时可留空。', { placeholder: 'http://127.0.0.1:3000' })),
          h('div', { className: 'dfy-field', key: 'token', style: { marginTop: 17 } },
            h('div', { className: 'dfy-titleline' }, h('label', { className: 'dfy-label', htmlFor: secretId }, 'OneBot 访问令牌', tag('onebotAccessToken')),
              h(HelpTip, { label: 'OneBot 访问令牌' }, '留空保留现有值，不回显令牌。这里的修改不会同步到 NapCat；两端认证需一致。WebUI 密码单独管理。')),
            h('input', { id: secretId, type: 'password', value: token, autoComplete: 'new-password', maxLength: 8192,
              placeholder: secretConfigured.effective?.onebotAccessToken ? '已配置 · 留空保留现有令牌' : '尚未配置',
              disabled: blocked || clearToken || overridden.includes('onebotAccessToken'),
              'aria-describedby': overridden.includes('onebotAccessToken') ? panelId.current + '-onebotAccessToken-hint' : undefined, onChange: (event) => {
                latest.current.token = event.target.value; latest.current.dirty = true;
                setToken(event.target.value); setNotice('');
              } }),
            hint('onebotAccessToken', '留空保留现有值，不回显令牌。这里的修改不会同步到 NapCat；两端认证需一致。WebUI 密码单独管理。'),
            h('label', { className: 'dfy-toggle', htmlFor: secretId + '-clear' },
              h('span', { className: 'dfy-toggle-copy' }, h('span', { className: 'dfy-toggle-title' }, '明确清除已保存令牌'),
                h('span', { className: 'dfy-hint', style: { display: 'block' } }, '保存后生效，请同时核对网关的认证配置。')),
              h('input', { id: secretId + '-clear', type: 'checkbox', checked: clearToken,
                disabled: blocked || overridden.includes('onebotAccessToken'),
                onChange: (event) => { setClearToken(event.target.checked); setToken(''); latest.current.clearToken = event.target.checked; latest.current.token = ''; } }))),
          readonly('原生引擎（只读）', engine),
          readonly('历史消息补回（只读）', config.effective?.catchUpUnread === true ? '已开启，请修正配置' : '关闭'),
          guide('qq'), h('div', { className: 'dfy-inline-actions' }, navButton('管理 QQ 服务', 'dependencies')))));
      const phonePanel = h(React.Fragment, null,
        section('手机连接', '只连接指定的已配对手机。检查与连接不会读取屏幕或录音；修改设置后需保存并生效。', h(React.Fragment, null,
          readonly('连接状态', runtime.phone?.checking ? '正在连接或检测' : phoneStatus(runtime.phone)),
          runtime.phone?.note && runtime.phone?.state !== 'online' ? h('p', { className: 'dfy-hint' }, runtime.phone.note) : null,
          runtime.phone?.nextStep ? h('div', { className: 'dfy-notice', role: 'status', style: { marginTop: 10 } },
            h('strong', null, '下一步'), h('p', { style: { marginTop: 4 } }, runtime.phone.nextStep)) : null,
          runtime.phone?.lastTool?.ok === false ? h('p', { className: 'dfy-notice dfy-warning' }, '最近一次手机操作未完成，请检查连接后再试。') : null,
          toggle('phoneEnabled', '连接我的手机', '开启后，大肥鱼可以使用你在下方允许的操作；执行前仍需确认指定设备。'),
          h('div', { className: 'dfy-grid', style: { marginTop: 16 } },
            field('phoneDevice', '手机地址', '无线填写手机无线调试页面的 IP:连接端口，不是配对端口。USB 连接时可填写设备序列号。不会扫描其他手机。', { placeholder: '如 192.168.1.10:37123' })),
          h('div', { className: 'dfy-inline-actions', style: { marginTop: 12 } },
            h('button', { type: 'button', className: 'dfy-button', disabled: operationBlocked || runtime.phone?.enabled !== true || !runtime.phone?.device,
              title: operationReason || '仅检测当前配置设备的连接状态', onClick: checkPhone }, operation === 'phone' ? '检查中…' : '检查连接'),
            h('button', { type: 'button', className: 'dfy-button dfy-primary', disabled: operationBlocked || runtime.phone?.canConnect !== true,
              title: operationReason || runtime.phone?.connectReason || '连接已配对的指定无线设备', onClick: connectPhone }, operation === 'phone-connect' ? '连接中…' : '连接手机')),
          operationReason || runtime.phone?.connectReason ? h('p', { className: 'dfy-hint' }, operationReason || runtime.phone.connectReason) : null)),
        section('允许的操作', '开启的操作才会向大肥鱼开放。短时录音只采集手机播放的声音，执行情况以实际结果为准。',
          h(React.Fragment, null,
            h('div', { className: 'dfy-label' }, '手机操作', tag('allowedPhoneTools')),
            overridden.includes('allowedPhoneTools') ? hint('allowedPhoneTools', '') : null,
            h('div', { className: 'dfy-tool-grid' }, tools.map((item) => toolToggle(...item))),
            h('div', { className: 'dfy-toggle' },
              h('span', { className: 'dfy-toggle-copy' },
                h('span', { className: 'dfy-titleline' }, h('label', { className: 'dfy-toggle-title', htmlFor: panelId.current + '-back' }, '允许返回键', tag('allowedPhoneKeys')),
                  h(HelpTip, { label: '允许返回键' }, '需要同时开启上方“返回按键”。')),
                hint('allowedPhoneKeys', '需要同时选中“返回按键”工具。')),
              h('input', { id: panelId.current + '-back', type: 'checkbox',
                checked: Array.isArray(value('allowedPhoneKeys')) && value('allowedPhoneKeys').includes('back'),
                disabled: blocked || overridden.includes('allowedPhoneKeys'),
                onChange: (event) => change('allowedPhoneKeys', event.target.checked ? ['back'] : []) })),
            h('div', { className: 'dfy-grid', style: { marginTop: 16 } }, field('maxListenSeconds', '录音时长', '可选 1–3 秒。', { numeric: true, select: [1, 2, 3] })),
            h('p', { className: 'dfy-hint' }, '短时录音会采集手机正在播放的声音，单次最多 ', value('maxListenSeconds'), ' 秒。'))),
        h('section', { className: 'dfy-section' }, h(Advanced, { title: '高级设置' },
          readonly('运行中的设备', runtime.phone?.device || '尚未配置'),
          readonly('最近检查', displayTime(runtime.phone?.checkedAt)),
          runtime.phone?.state === 'online' && runtime.phone?.note ? h('p', { className: 'dfy-hint' }, runtime.phone.note) : null,
          runtime.phone?.lastTool ? readonly('最近工具结果', runtime.phone.lastTool.name + ' · ' + (runtime.phone.lastTool.ok ? '成功' : '失败')
            + ' · ' + displayTime(runtime.phone.lastTool.at)) : null,
          toggle('autoConnectPhone', '设置生效后自动连接', '仅尝试连接指定设备；未连接时保持离线状态。'),
          guideDoc('手机连接'),
          toggle('allowMemoryWrites', '允许写入伴侣记忆', '开启后，授权的主要账号会话可通过工具更新共享记忆。'),
          toggle('allowMemeSync', '允许同步手机图库', '同步会读取手机图片并写入桌面图库，需要手机能力和实际连接。'),
        )));
      const voicePanel = visitedTabs.includes('voice') ? h(React.Fragment, null,
        section('接收语音', '收到已启用用户的私聊语音后，将它转成文字。修改开关后需保存并生效。',
          h(React.Fragment, null, readonly('当前运行状态', voiceInputStatus(runtime.voiceInput)),
            runtime.voiceInput?.lastResult?.ok === false ? readonly('最近识别结果', '失败'
              + ' · ' + displayTime(runtime.voiceInput.lastResult.at) + (runtime.voiceInput.lastResult.note ? ' · ' + runtime.voiceInput.lastResult.note : '')) : null,
            toggle('voiceTranscription', '识别收到的语音', '仅处理已启用用户发给小号的私聊语音；保存并生效后启用。')),
          h('button', { type: 'button', className: 'dfy-button', disabled: blocked, onClick: refresh },
            operation === 'refresh' ? '刷新中…' : '刷新状态')),
        h(SpeechInputPanel, { active: tab === 'voice', onDirtyChange: setSpeechDirty }),
        h(VoiceOutputPanel, { active: tab === 'voice', refreshKey: resourceRefreshKey, onDirtyChange: setVoiceDirty, onSaved: refresh }),
        h('section', { className: 'dfy-section' }, h(Advanced, { title: '高级设置' },
          runtime.voiceInput?.lastResult ? readonly('最近识别记录', (runtime.voiceInput.lastResult.ok ? '成功' : '失败')
            + ' · ' + displayTime(runtime.voiceInput.lastResult.at) + (runtime.voiceInput.lastResult.note ? ' · ' + runtime.voiceInput.lastResult.note : '')) : null,
          guideDoc('语音设置'),
          h(DependencyPanel, { active: tab === 'voice', scope: 'voice', onNavigate: selectTab, maintenanceBlocked: operationBlocked })))) : null;
      const renderContent = (key) =>
        key === 'overview' ? overview : key === 'qq' ? qqPanel : key === 'phone' ? phonePanel : key === 'voice' ? voicePanel
              : key === 'capabilities' ? visitedTabs.includes(key) ? h(CapabilitiesPanel, {
                active: tab === 'capabilities', onNavigate: selectTab, onBusyChange: capabilityBusyChanged.current,
                probeBlocked: Boolean(operation) || runtime.applying === true || runtime.busy === true || runtime.phone?.checking === true
                  || pendingReload || dirty || personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty || memoryDirty || lifeDirty,
                checkBlocked: Boolean(operation) || runtime.applying === true || runtime.busy === true,
                runtimeBusy: runtime.busy === true || runtime.applying === true,
                onUpdated: (state) => state ? acceptState(state, false) : refresh(),
              }) : null
              : key === 'background' ? visitedTabs.includes(key) ? h(React.Fragment, null,
                h(BackgroundTaskPanel, { snapshot: runtime.backgroundTasks, controlBlocked: blocked || runtime.applying === true,
                  testBlocked: runtime.busy === true || Number(runtime.backgroundTasks?.active) > 0
                    || Number(runtime.backgroundTasks?.running) > 0 || Number(runtime.backgroundTasks?.queued) > 0,
                  refreshing: operation === 'refresh', onRefresh: refresh,
                  onUpdated: (state) => state ? acceptState(state, false) : refresh() }),
                h('section', { className: 'dfy-section' }, h(Advanced, { title: '任务设置' },
                  toggle('backgroundTasksEnabled', '启用后台任务', '允许从 QQ 委派子任务，并将结果回传到原聊天对象与身份。'),
                  toggle('externalTaskRouting', '自动分配任务', '使用已配置的 Z Code、MiniMax Code 等执行器。未验证可用时不会假定已可调用。'),
                  h('p', { className: 'dfy-hint' }, '修改后需保存并生效，执行中的任务结束后才能让设置生效。')))) : null
              : key === 'accounts' ? h(AccountIdentityPanel, { accounts: editedAccounts, ownerQq: value('ownerQq'), engine,
                onChange: (accounts) => change('qqAccounts', accounts), onOwnerChange: changePrimaryAccount,
                disabled: blocked || overridden.includes('qqAccounts'), ownerDisabled: overridden.includes('ownerQq'),
                readOnlyReason: overridden.includes('qqAccounts') ? '账号与身份由宿主 profile 指定；请在宿主配置中修改，此处显示当前生效值。' : '', errors: accountErrors })
              : visitedTabs.includes(key) ? key === 'model' ? h(ModelPanel, { active: tab === 'model', onDirtyChange: setModelDirty,
                canRebind: snapshot.canApply && !blocked && !runtime.busy && !dirty && !pendingReload && !personaDirty && !voiceDirty && !modelDirty && !speechDirty && !galleryDirty && !memoryDirty && !lifeDirty,
                onRebound: refresh })
                : key === 'social' ? h(VideoPlatformsPanel, { active: tab === 'social' })
                : key === 'dependencies' ? h(DependencyPanel, { active: tab === 'dependencies', onNavigate: selectTab, maintenanceBlocked: operationBlocked })
                  : key === 'memes' ? h(GalleryPanel, { active: tab === 'memes', onDirtyChange: setGalleryDirty })
                    : key === 'life' ? h(LifePanel, { active: tab === 'life', accounts: runningAccounts.length ? runningAccounts : editedAccounts,
                      ownerQq: String(value('ownerQq') || ''), onManageAccounts: () => selectTab('accounts'), onDirtyChange: setLifeDirty,
                      writeBlocked: blocked || runtime.busy === true || runtime.applying === true || pendingReload || dirty || personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty || memoryDirty,
                      revokeBlocked: blocked || runtime.applying === true || pendingReload || dirty || personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty || memoryDirty,
                      cancelBlocked: blocked || runtime.applying === true })
                    : key === 'memory' ? h(MemoryPanel, { active: tab === 'memory', onDirtyChange: setMemoryDirty, accounts: runningAccounts.length ? runningAccounts : editedAccounts,
                      writeBlocked: blocked || runtime.busy === true || pendingReload || dirty || personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty })
                      : h(PersonaPanel, { onDirtyChange: setPersonaDirty }) : null;
      const activeGroup = tabGroups.find((group) => group.id === tab || group.children.includes(tab));
      const groupIds = tabGroups.map((group) => group.id);
      const parentFields = { qq: ['autoStartOneBot', 'onebotSelfId', 'onebotWs', 'onebotHttp'], accounts: ['ownerQq', 'qqAccounts'],
        phone: ['phoneEnabled', 'phoneDevice', 'autoConnectPhone', 'allowedPhoneTools', 'allowedPhoneKeys', 'maxListenSeconds', 'allowMemoryWrites', 'allowMemeSync'],
        voice: ['voiceTranscription'], background: ['backgroundTasksEnabled', 'externalTaskRouting'] };
      const pageDirty = (key) => {
        const group = tabGroups.find((candidate) => candidate.id === key);
        if (group) return group.children.some(pageDirty);
        return Boolean(({ model: modelDirty, voice: voiceDirty || speechDirty, persona: personaDirty,
          memes: galleryDirty, memory: memoryDirty, life: lifeDirty })[key]) || (parentFields[key] || []).some((field) => own(draft, field))
          || key === 'qq' && (token !== '' || clearToken);
      };
      const hasChildDraft = personaDirty || modelDirty || voiceDirty || speechDirty || galleryDirty || memoryDirty || lifeDirty;
      const cannotApply = blocked || !snapshot?.canApply || runtime.busy === true || hasChildDraft || Boolean(accountErrors.length);
      const tabButton = (key, index, keys, secondary = false) => {
        const group = tabGroups.find((candidate) => candidate.id === key);
        const selected = group ? tab === key || group.children.includes(tab) : tab === key;
        const label = group ? group.label : subTabs[key];
        const dirtyMark = group ? group.children.some(pageDirty) : pageDirty(key);
        return h('button', { key, id: panelId.current + '-tab-' + key, type: 'button', role: 'tab',
          className: secondary ? 'dfy-settings-tab' : 'dfy-tab', 'aria-selected': selected,
          'aria-controls': panelId.current + '-content-' + key, tabIndex: selected ? 0 : -1,
          'data-dirty': dirtyMark || undefined, 'aria-description': dirtyMark ? '有未保存的修改' : undefined,
          onClick: () => selectTab(key), onKeyDown: (event) => {
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % keys.length;
            if (event.key === 'ArrowLeft') next = (index + keys.length - 1) % keys.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = keys.length - 1;
            if (next !== undefined) { event.preventDefault(); selectTab(keys[next]); event.currentTarget.parentNode.children[next].focus(); }
          } }, label);
      };
      const page = (key) => h('div', { key, role: 'tabpanel', id: panelId.current + '-content-' + key,
        'aria-labelledby': panelId.current + '-tab-' + key, tabIndex: 0, hidden: tab !== key }, renderContent(key));
      return h('div', { className: 'dfy-panel', ref: panelRoot },
        h('style', null, style + consumerStyle + navigationStyle),
        h('header', { className: 'dfy-hero' },
          h('span', { className: 'dfy-mark', 'aria-hidden': true }, '≈'),
          h('div', null, h('h2', null, '大肥鱼')),
          h('span', { className: 'dfy-live' }, h('span', { className: 'dfy-dot', 'aria-hidden': true }), updatedAt ? updatedAt + ' 更新' : '读取状态'),
          h('button', { className: 'dfy-button', type: 'button', style: { marginLeft: 8 }, disabled: blocked, onClick: refresh }, operation === 'refresh' ? '刷新中…' : '刷新状态')),
        runtime.error ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' },
          h('strong', null, '伴侣启动失败'),
          h('div', null, typeof runtime.error === 'string' ? errorText({ message: runtime.error }, token) : '伴侣未能启动，请检查配置后重新应用。'),
          h('p', { style: { marginTop: 6 } }, dirty || hasChildDraft ? '请先保存或放弃未保存的修改，再重试启动。'
            : runtime.busy ? '请先等待当前任务结束，再重试启动。' : !snapshot?.canApply ? '请检查设置，重新加载 DSH 后重试。' : '可检查设置后重试启动，QQ 会短暂断线。'),
          h('button', { type: 'button', className: 'dfy-button', disabled: cannotApply || dirty,
            onClick: () => {
              const current = latest.current;
              if (current.dirty || !current.snapshot?.runtime?.error || current.snapshot.runtime.busy || current.snapshot.runtime.applying
                || !current.snapshot.canApply || current.capabilitiesBusy || current.personaDirty || current.modelDirty || current.voiceDirty
                || current.speechDirty || current.galleryDirty || current.memoryDirty || current.lifeDirty) return;
              save();
            } }, operation === 'apply' ? '启动中…' : '重试启动')) : null,
        h('div', { role: 'status', 'aria-live': 'polite' },
          notice ? h('div', { className: 'dfy-notice' }, notice) : null,
          pendingReload ? h('div', { className: 'dfy-notice dfy-warning' }, '设置已保存，还未生效。生效时 QQ 会短暂断线，请先等待当前任务结束。') : null),
        error ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' },
          h('strong', null, error.code === 'CONFLICT' ? '配置版本冲突' : '操作未完成'),
          h('div', null, errorText(error, token)),
          error.validationErrors?.length ? h('ul', null, error.validationErrors.map((item, index) =>
            h('li', { key: index }, String(item.field || '配置') + '：' + String(item.message || '字段无效')))) : null) : null,
        overrideDraft ? h('div', { className: 'dfy-notice dfy-warning' },
          h('p', null, '有由 DSH 管理字段的本地草稿，保存时不会应用这些字段；请在 DSH 设置中修改它们。')) : null,
        policyConflict ? h('div', { className: 'dfy-notice dfy-warning', role: 'alert' },
          '当前配置与原生模式要求不一致。此页不切换引擎；请在宿主配置中设为 native，并关闭历史补回。') : null,
        snapshot && config.validationErrors?.length ? h('div', { className: 'dfy-notice dfy-error', role: 'alert' },
          '当前生效配置需要修正：', h('ul', null, config.validationErrors.map((item, index) =>
            h('li', { key: index }, String(item.field) + '：' + String(item.message))))) : null,
        snapshot ? h('form', { onSubmit: (event) => { event.preventDefault(); } },
          h('nav', { className: 'dfy-tabs', role: 'tablist', 'aria-label': '大肥鱼' },
            tabGroups.map((group, index) => tabButton(group.id, index, groupIds))),
          activeGroup && activeGroup.children.length ? h('nav', { className: 'dfy-settings-nav', role: 'tablist', 'aria-label': activeGroup.label },
            activeGroup.children.map((key, index) => tabButton(key, index, activeGroup.children, true))) : null,
          everyPageKey.map(page),
          dirty || pendingReload ? h('footer', { className: 'dfy-footer' },
            h('div', { className: 'dfy-footer-note' },
              queuedApply ? '她正在处理消息，完成后自动保存并生效。'
                : hasChildDraft ? '先保存其他页面的独立草稿，保存后一起生效。'
                : dirty ? '保存后立即生效，QQ 会短暂重连。' : '有已保存的设置待生效。',
              accountErrors.length ? ' 聊天对象信息尚未完整，请补齐后保存。' : ''),
            h('div', { className: 'dfy-actions' },
              h('button', { className: 'dfy-button dfy-primary', type: 'button',
                disabled: blocked || Boolean(accountErrors.length),
                onClick: save }, operation === 'apply' ? '生效中…' : queuedApply ? '等待她忙完…'
                : pendingReload && !dirty ? '生效' : '保存'))) : null)
          : h('div', { className: 'dfy-empty' }, operation === 'refresh' ? '正在读取伴侣状态…' : '尚未读取配置。',
            h('div', { style: { marginTop: 12 } }, h('button', { className: 'dfy-button', type: 'button', disabled: blocked, onClick: refresh }, '刷新'))));
    }
    exports.inject = ['slots'];
    exports.apply = (ctx) => {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'dsh-dafeiyu', order: 51, label: () => '大肥鱼' },
        () => h(Panel),
      ));
    };
    return module.exports;
  },
});
