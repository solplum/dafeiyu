/* Isolated preview uses exactly the same manager/routes as the DSH panel. */
(() => {
  const token = location.hash.slice(1) || sessionStorage.getItem('dfy-preview-owner') || '';
  if (token) sessionStorage.setItem('dfy-preview-owner', token);
  history.replaceState(null, '', location.pathname);
  const $ = id => document.getElementById(id), pictures = new Map(), pending = new Set(); let state, generation = 0, browsing = null, browseGeneration = 0, browseScope = null, metadataExpiryTimer;
  const labels = { disconnected: '尚未绑定', 'login-pending': '等待扫码或登录', candidate: '请确认账号', bound: '已绑定',
    expired: '二维码已过期', 'login-unknown': '登录状态待核对', 'identity-binding-required': '账号识别待适配', 'account-mismatch': '登录账号与原绑定不一致', 'verification-required': '需要本人完成验证' };
  const verbs = { profile: '账号资料', search: '搜索', posts: '我的作品', comments: '作品评论', replies: '收到的回复', inbox: '收件箱', messages: '私信会话',
    notifications: '通知', 'comment-management': '我的作品评论管理', 'message-management': '我的私信管理', comment: '发表评论', reply: '回复评论', message: '发送私信', video: '发布视频', post: '发帖', like: '点赞', follow: '关注', bookmark: '收藏' };
  const states = { draft: '待核对', approved: '已批准，尚未执行', dispatching: '正在执行', unknown: '结果未知，未重试', sent: '平台已返回编号' };
  const el = (tag, text, props = {}) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; Object.assign(node, props); return node; };
  const message = (text, error = false) => { const box = $('message'); box.className = text ? 'notice' + (error ? ' error' : '') : ''; box.textContent = text || ''; };
  async function api(route, payload) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), route === 'social/execute' ? 660000 : 90000);
    try {
      const response = await fetch('/api/' + route, { method: payload === undefined ? 'GET' : 'POST', signal: controller.signal,
        cache: 'no-store', credentials: 'omit', headers: { 'X-Dafeiyu-Owner': token, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      const value = await response.json();
      if (!response.ok || value.ok !== true) { const failure = new Error(value.error || '请求未完成，请刷新状态核对。'); failure.code = value.code; throw failure; } return value;
    } catch (error) { if (error.name === 'AbortError') throw new Error('尚未得到完整回执，请刷新核对；不会自动重发。'); throw error; }
    finally { clearTimeout(timeout); }
  }
  async function refresh() {
    const current = ++generation, value = await api('social/accounts');
    if (current === generation) {
      const account = value.accounts.platforms.find(row => row.platform === 'douyin');
      const scope = JSON.stringify([account?.accountId || null, account?.generation || 0, account?.state || null]);
      if (browseScope !== null && browseScope !== scope) { browseGeneration++; browsing = null; }
      browseScope = scope; state = value.accounts;
      clearTimeout(metadataExpiryTimer);
      const browser = account?.browser, expiresAt = Date.parse(browser?.expiresAt);
      if (['ready', 'ready-to-start', 'unconfirmed'].includes(browser?.state) && Number.isFinite(expiresAt)) {
        const captured = state;
        metadataExpiryTimer = setTimeout(() => { if (state !== captured) return;
          state = { ...state, platforms: state.platforms.map(row => row.platform === 'douyin'
            ? { ...row, driverAvailable: false, browser: { ...row.browser, ready: false, canStartNewActivity: false, activityReady: false, state: 'expired' } } : row) }; render();
        }, Math.max(0, expiresAt - Date.now()));
      }
      for (const account of state.platforms.filter(row => row.loginImageAvailable && pictures.get(row.platform)?.sessionId !== row.loginSession)) {
        try { const cached = await api('social/login/image', { platform: account.platform, sessionId: account.loginSession });
          if (cached.image?.mime === 'image/png' && /^[A-Za-z0-9+/=]+$/.test(cached.image.base64 || '') && cached.image.base64.length < 1500000)
            pictures.set(account.platform, { sessionId: cached.sessionId, image: cached.image.base64 });
        } catch { /* No automatic QR regeneration or login. */ }
      }
      if (current === generation) render();
    }
  }
  async function run(key, operation) {
    if (pending.has(key)) return; pending.add(key); render(); message('正在处理…');
    try { const text = await operation(); await refresh(); if (text?.silent !== true) message(text || '状态已更新。'); }
    catch (error) { message(error.message, true); try { await refresh(); } catch {} }
    finally { pending.delete(key); render(); }
  }
  const button = (text, key, handler, primary = false, disabled = false) => {
    const value = el('button', pending.has(key) ? '处理中…' : text, { disabled: pending.has(key) || disabled });
    if (primary) value.className = 'primary'; value.addEventListener('click', () => { if (!value.disabled && !pending.has(key)) handler(); }); return value;
  };
  const browseMessages = { open: '已打开抖音推荐页，保持静音。', current: '已读取当前视频页面文字与播放状态。', next: '已切换到下一个视频，保持静音。', stop: '本次浏览已停止，登录资料保留。', history: '已读取最多20条本地浏览记录，没有访问平台。' };
  const canOpenBrowse = account => account?.browser?.lifecycle === undefined ? account?.driverAvailable === true
    : account.browser.canStartNewActivity === true || account.browser.activityReady === true;
  const canReadBrowse = account => account?.browser?.lifecycle === undefined ? account?.driverAvailable === true
    : account.browser.activityReady === true && account.browse?.state === 'active';
  const nextReady = () => {
    const account = state?.platforms.find(row => row.platform === 'douyin');
    return !pending.has('browse-stop') && account?.state === 'bound' && canReadBrowse(account) && !account.safetyPause
      && !account.busy && !account.blocked && !account.cleanupRequired && account.nextAvailable === true
      && typeof browsing?.current?.platformVideoId === 'string' && /^[0-9]{10,25}(?![\s\S])/.test(browsing.current.platformVideoId);
  };
  async function browse(action) {
    const account = state?.platforms.find(row => row.platform === 'douyin');
    if (['open', 'current'].includes(action) && (pending.has('browse-stop') || account?.state !== 'bound' || account.safetyPause
      || account.busy || account.blocked || account.cleanupRequired || !(action === 'open' ? canOpenBrowse(account) : canReadBrowse(account)))) return;
    const currentId = browsing?.current?.id;
    if (action === 'next' && (!currentId || !nextReady())) return;
    const currentGeneration = ++browseGeneration, request = { action };
    if (action === 'next') request.expectedVideoId = currentId;
    await run(action === 'stop' ? 'browse-stop' : 'douyin', async () => {
      try {
        const value = await api('social/browse', { platform: 'douyin', request });
        if (currentGeneration !== browseGeneration) return { silent: true };
        browsing = value.browse; return browseMessages[action];
      } catch (error) { if (currentGeneration !== browseGeneration) return { silent: true }; browsing = { ...browsing, state: 'unknown', current: null }; if (error.code === 'DRIVER_UNAVAILABLE') error.message = '专用 Ego 浏览环境待核验。'; throw error; }
    });
  }
  function browseVideo(video) {
    const box = el('div');
    if (!video || typeof video.id !== 'string') return box;
    box.append(el('p', video.author || '作者暂未读取'));
    box.append(el('p', video.description || '页面未提供视频文案。'));
    const media = video.media || {}, seconds = value => Number.isFinite(value) ? value.toFixed(1) + '秒' : '未读取';
    box.append(el('small', '页面播放器静音：' + (media.muted === true ? '已确认' : '未确认') + ' · 播放：' + (media.paused === true ? '已暂停' : media.paused === false ? '播放中' : '未读取') + ' · 进度 ' + seconds(media.currentTime) + ' / ' + seconds(media.duration)));
    return box;
  }
  function renderBrowse() {
    const account = state.platforms.find(row => row.platform === 'douyin'), actions = $('browse-actions'), content = $('browse-content');
    actions.replaceChildren(); content.replaceChildren();
    const unavailable = !account || Boolean(account.safetyPause) || account.busy || account.blocked || account.cleanupRequired || account.state !== 'bound';
    for (const [action, label] of [['open', '打开推荐'], ['current', '读取当前'], ['next', '下一个'], ['stop', '停止'], ['history', '查看有限历史']]) {
      const key = action === 'stop' ? 'browse-stop' : 'douyin';
      actions.append(button(label, key, () => browse(action), action === 'open', action === 'stop' ? false : pending.has('browse-stop') || (action !== 'history' && unavailable) || (action === 'open' && !canOpenBrowse(account)) || (['current', 'next'].includes(action) && !canReadBrowse(account)) || (action === 'next' && (!browsing?.current?.id || !nextReady()))));
    }
    if (account?.browser) {
      const texts = { 'ready-to-start': '后台浏览入口已核验；打开时会再次核对账号。本次浏览已结束，登录资料保留。', ready: '最近已核验 Ego 浏览空间；登录和内容以实际读取为准。', 'not-checked': '浏览环境已配置，当前 Ego 空间尚未核验。',
        expired: '上次空间核验已过期，请重新核验；这不代表账号已退出。', unconfirmed: '当前执行器未能确认专用 Ego 空间；这不代表账号已退出。', unavailable: '专用 Ego 浏览环境暂不可用。' };
      content.append(el('p', account.browser.lifecycle === 'closed' && account.browser.state !== 'ready-to-start' ? '本次浏览已结束，登录资料保留；开始前请核验后台入口。' : texts[account.browser.state] || '专用 Ego 空间待核验。', { className: 'muted' }),
        button('核验 Ego 浏览环境', 'check-browser', () => run('check-browser', async () => {
          const value = await api('social/check-browser', { platform: 'douyin', revision: state.revision });
          return value.browser?.ready === true ? value.browser.state === 'ready-to-start' ? '后台浏览入口已核验；打开时会再次核对账号。没有访问平台页面。' : '已核验当前专用 Ego 空间，没有访问平台页面。' : '当前执行器尚未确认专用 Ego 空间，账号绑定和登录资料保留。';
        }), false, !account.driverConfigured || Boolean(account.safetyPause) || account.busy || account.blocked || account.cleanupRequired));
    } else if (account?.driverAvailable === false) content.append(el('p', '专用 Ego 浏览环境待核验。', { className: 'muted' }));
    if (account?.nextAvailable !== true) content.append(el('p', '切换视频仍待验证，当前仅开放读取。', { className: 'muted' }));
    content.append(el('p', browsing?.state === 'active' ? '本次浏览已打开；只有你操作时才执行下一步。' : browsing?.state === 'unknown' ? '浏览状态待核对；不会自动继续。' : '当前未在浏览。', { className: 'muted' }));
    if (browsing?.current) content.append(browseVideo(browsing.current));
    const history = Array.isArray(browsing?.history) ? browsing.history.slice(-20) : [];
    if (history.length) {
      const details = el('details'); details.append(el('summary', '本次有限历史（最多20条）'));
      for (const video of history) details.append(browseVideo(video)); content.append(details);
    } else if (browsing?.action === 'history') content.append(el('p', '暂无本地浏览记录。', { className: 'muted' }));
  }
  function render() {
    if (!state) return;
    const cards = $('platforms'); cards.replaceChildren();
    for (const account of state.platforms) {
      const key = account.platform, card = el('article'), head = el('div', undefined, { className: 'row' });
      head.append(el('h2', account.name), el('span', account.safetyPause ? '已暂停，待本人处理' : labels[account.state] || '状态待确认', { className: 'badge' })); card.append(head);
      card.append(el('p', account.accountId ? account.accountName + ' · ' + account.accountId : key === 'x' ? '由本人完成官方注册或登录' : '使用大肥鱼的专用账号扫码确认', { className: 'muted' }));
      card.append(button(account.loginMethod === 'qr' ? '打开扫码登录' : '打开官方登录', key, () => run(key, async () => {
        const current = state.platforms.find(value => value.platform === key);
        if (!current || current.busy || current.blocked) throw Error('平台状态已变化，请先刷新。'); pictures.delete(key);
        const result = await api('social/login/start', { platform: key, requestId: crypto.randomUUID(), revision: state.revision });
        if (result.login?.image?.mime === 'image/png' && /^[A-Za-z0-9+/=]+$/.test(result.login.image.base64 || '')
          && result.login.image.base64.length < 1500000) pictures.set(key, { sessionId: result.sessionId, image: result.login.image.base64 });
        return key === 'x' ? '已打开 X 官方登录页；请由本人注册或登录，完成后检查登录。' : '请用对应手机 App 扫码并确认，然后点击“检查登录”。';
      }), true, Boolean(account.safetyPause) || account.loginAvailable === false || !account.driverAvailable || account.busy || account.blocked || account.state === 'login-pending'));
      if (account.loginAvailable === false) card.append(el('p', account.state === 'bound' ? '当前复用已在 Ego 登录的账号，暂不从本页重新发起登录。' : '本页暂不提供 Ego 登录管理。', { className: 'muted' }));
      if (account.loginSession) {
        card.append(button('检查登录', key, () => run(key, async () => {
          const current = state.platforms.find(value => value.platform === key), sessionId = current?.loginSession;
          if (!sessionId || current.busy) throw Error('登录会话已变化，请刷新。');
          const result = await api('social/login/check', { platform: key, sessionId });
          if (!['login-pending'].includes(result.login?.state)) pictures.delete(key);
          return result.login?.state === 'candidate' ? '已读取账号，请核对后确认归属。'
            : result.login?.state === 'identity-binding-required' ? '账号识别规则待适配，尚未绑定或发送。' : '登录尚未核验完成；可查看专用浏览器中的登录或验证提示。';
        }), false, account.loginAvailable === false || account.busy));
        card.append(button('关闭本次登录', key, () => run(key, async () => {
          pictures.delete(key); const current = state.platforms.find(value => value.platform === key);
          await api('social/login/close', { platform: key, sessionId: current.loginSession, revision: state.revision });
          return '已关闭本次登录流程；没有执行发布或发送。';
        }), false, account.busy || account.blocked));
      }
      const picture = pictures.get(key);
      if (picture && picture.sessionId === account.loginSession && account.state === 'login-pending') {
        card.append(el('img', undefined, { src: 'data:image/png;base64,' + picture.image, alt: account.name + '本次专用登录页面', className: 'qr' }));
        card.append(el('small', '本次登录专用，请在手机确认账号；二维码不要转发。'));
      }
      if (account.candidate) {
        card.append(el('p', '当前登录：' + account.candidate.name + ' · ' + account.candidate.accountId));
        card.append(button('确认这是大肥鱼的账号', key, () => run(key, async () => {
          const current = state.platforms.find(value => value.platform === key);
          if (!current?.candidate) throw Error('待确认账号已变化。');
          await api('social/account/confirm', { platform: key, accountId: current.candidate.accountId, revision: state.revision });
          pictures.delete(key); return '已核验并绑定此账号；发送功能仍按逐项实际证据显示。';
        }), true));
      }
      if (account.safetyPause) {
        card.append(el('p', account.safetyPause.reason === 'owner-paused' ? '已按本人要求暂停。' : '平台要求安全验证，已停止后续平台请求。'));
        const label = el('label'), checked = el('input', undefined, {type:'checkbox'});label.append(checked, document.createTextNode(' 我已在官方页面处理完成，并确认继续使用这个账号'));
        const resume = button('按本人确认继续', key, () => { if (!checked.checked) return; run(key, async () => { await api('social/resume', {platform:key,revision:state.revision,verificationCompleted:true}); return '已恢复准入，没有自动重做。'; }); }, false, true);
        checked.addEventListener('change', () => {resume.disabled=!checked.checked||pending.has(key)||account.busy||account.blocked||account.cleanupRequired;});card.append(label,resume);
      }
      if (account.busy) card.append(button('请求停止后续步骤', 'cancel-' + key, () => run('cancel-' + key, async () => {
        const result = await api('social/cancel', { platform: key }); return result.note;
      })));
      if (account.cleanupRequired && !account.busy) card.append(button('停止该平台独立执行器', key, () => run(key, async () => {
        await api('social/stop-executor', { platform: key, revision: state.revision }); return '独立执行器已停止；请核对原平台结果，没有重发。';
      })));
      if (account.cleanupRequired && !account.busy && !account.blocked) {
        const reviewedRevision = state.revision, label = el('label'), checked = el('input', undefined, { type: 'checkbox' });
        label.append(checked, document.createTextNode(' 我已确认旧执行器停止，并核对了原平台结果'));
        const recover = button('解除执行器保护', key, () => {
          if (!checked.checked || state.revision !== reviewedRevision) return message('状态已变化，请重新核对后确认。', true);
          run(key, async () => { await api('social/recover-executor', { platform: key, revision: reviewedRevision, executionStopped: true, resultReviewed: true });
            return '已按明确确认解除保护，原操作没有重跑。'; });
        }, false, true);
        checked.addEventListener('change', () => { recover.disabled = !checked.checked || pending.has(key) || state.revision !== reviewedRevision; });
        card.append(label, recover);
      }
      if (account.blocked) card.append(el('p', '有结果未知的操作，请先核对；没有自动重试。', { className: 'muted' }));
      const details = el('details'); details.append(el('summary', '功能与验证状态'));
      for (const capability of account.capabilities) details.append(el('div', (verbs[capability.operation] || capability.operation) + ' · '
        + ({ 'needs-login': '先登录并确认', 'implemented-not-verified': '已接驱动，待现场验证', 'bindings-required': '待核验当前页面控件', 'empty-state-only': '当前仅支持空列表状态，非空内容待适配', 'not-verified': '待验证', 'not-implemented': '尚未接入' }[capability.state] || capability.state), { className: 'cap' }));
      card.append(details); cards.append(card);
    }
    renderBrowse();
    const operations = $('operations'); operations.replaceChildren();
    if (!state.operations.length) operations.append(el('p', '当前没有待发内容。', { className: 'muted' }));
    for (const row of state.operations) {
      const card = el('article'); card.style.marginTop = '14px'; card.append(el('h3', (verbs[row.operation] || row.operation) + ' · ' + (states[row.state] || row.state)));
      card.append(el('p', row.platform + ' / ' + row.accountId));
      if (row.target) card.append(el('p', '对象：' + row.target)); if (row.parentId) card.append(el('p', '回复评论：' + row.parentId));
      if (row.rootId) card.append(el('p', '主评论：' + row.rootId));
      if (row.title) card.append(el('p', '标题：' + row.title)); if (row.text) card.append(el('pre', row.text));
      if (row.mediaName) card.append(el('p', '视频：' + row.mediaName + ' · ' + row.mediaBytes + ' 字节'));
      if (row.coverName) card.append(el('p', '封面：' + row.coverName));
      if (row.declaration) card.append(el('p', '声明：' + (row.declaration === 'none' ? '非 AI 生成' : 'AI 生成') + ' · 标签：' + row.tags.join('、') + (row.category ? ' · 分区：' + row.category : '')));
      if (['draft', 'approved'].includes(row.state)) card.append(button(row.state === 'draft' ? '确认内容并执行' : '执行已批准内容', row.platform, () => run(row.platform, async () => {
        const current = state.operations.find(value => value.id === row.id);
        if (!current || current.approvalDigest !== row.approvalDigest || !['draft', 'approved'].includes(current.state)) throw Error('草稿已变化，请重新核对。');
        if (current.state === 'draft') await api('social/approve', { operationId: row.id, approvalDigest: row.approvalDigest, revision: state.revision });
        const result = await api('social/execute', { operationId: row.id, approvalDigest: row.approvalDigest });
        return result.operation.state === 'sent' ? '平台已返回本次编号：' + result.operation.resultId : result.operation.note || '请核对最新状态。';
      }), true));
      if (row.state === 'unknown' && state.platforms.find(account => account.platform === row.platform)?.blocked) {
        const label = el('label'), checkbox = el('input', undefined, { type: 'checkbox' }); label.append(checkbox, document.createTextNode(' 我已核对原平台结果，确认旧执行器已停止；解除保护不会重做原操作。'));
        card.append(label); const ack = button('按上述确认解除保护', row.platform, () => {
          if (!checkbox.checked) return;
          run(row.platform, async () => { await api('social/acknowledge', { operationId: row.id, revision: state.revision, executionStopped: true, resultReviewed: true }); return '保护已按明确确认解除；原结果仍标未知，没有重跑。'; });
        }, false, true); checkbox.addEventListener('change', () => { ack.disabled = !checkbox.checked || pending.has(row.platform); }); card.append(ack);
      }
      if (row.note) card.append(el('small', row.note)); if (row.resultId) card.append(el('small', '平台编号：' + row.resultId)); operations.append(card);
    }
  }
  $('refresh').addEventListener('click', () => run('refresh', async () => { await refresh(); return '已读取最新状态，没有发起平台检查或发送。'; }));
  $('read').addEventListener('click', () => {
    const key = $('read-platform').value; run(key, async () => {
      const request = { operation: $('read-operation').value, limit: 10 };
      if ($('read-target').value.trim()) request.target = $('read-target').value.trim(); if ($('read-query').value.trim()) request.query = $('read-query').value.trim();
      const result = await api('social/read', { platform: key, request }); $('reading').textContent = JSON.stringify(result.read, null, 2); return '已读取该账号的指定内容。';
    });
  });
  $('prepare').addEventListener('click', () => {
    const key = $('draft-platform').value; run(key, async () => {
      const request = { operation: $('draft-operation').value };
      for (const [field, id] of Object.entries({ target: 'draft-target', parentId: 'draft-parent', rootId: 'draft-root', text: 'draft-text', title: 'draft-title', video: 'draft-video', cover: 'draft-cover', category: 'draft-category', declaration: 'draft-declaration' }))
        if ($(id).value.trim() && (request.operation === 'video' || ['target', 'text', ...(request.operation === 'reply' ? ['parentId', 'rootId'] : [])].includes(field))) request[field] = field === 'text' ? $(id).value : $(id).value.trim();
      if (request.operation === 'video' && $('draft-tags').value.trim()) request.tags = $('draft-tags').value.split(',').map(value => value.trim()).filter(Boolean);
      await api('social/prepare', { platform: key, request, requestId: crypto.randomUUID() }); return '已准备本地草稿；尚未上传或发送。';
    });
  });
  refresh().catch(error => message(error.message, true));
})();
