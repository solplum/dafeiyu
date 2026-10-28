const PACKAGE = 'com.tencent.mobileqq';

export function validateQqSendProfile(value) {
  if (!value || value.version !== 1) throw new Error('手机 QQ 发送未配置可验证的收件人范围（PHONE_QQ_SEND_PROFILE）');
  for (const key of ['recipientName', 'recipientIdentity', 'titleResourceId', 'identityResourceId', 'editorResourceId', 'sendResourceId']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`QQ 发送配置缺少 ${key}`);
  }
  const resourceKeys = ['titleResourceId', 'identityResourceId', 'editorResourceId', 'sendResourceId', 'contactResourceId'];
  for (const key of resourceKeys) {
    if (value[key] !== undefined && !value[key].startsWith(PACKAGE + ':id/')) throw new Error(`QQ ${key} 必须为已核对的 QQ 控件资源 ID`);
  }
  if (value.titleResourceId === value.identityResourceId || value.editorResourceId === value.sendResourceId) throw new Error('QQ 身份和操作控件必须分别配置');
  return value;
}

const label = (node) => node.text || node['content-desc'] || '';
const matches = (nodes, resourceId) => nodes.filter((node) => node.package === PACKAGE && node['resource-id'] === resourceId && node.enabled !== 'false');

export function verifiedQqSession(nodes, profile) {
  const titles = matches(nodes, profile.titleResourceId);
  const identities = matches(nodes, profile.identityResourceId);
  return titles.length === 1 && identities.length === 1 &&
    label(titles[0]) === profile.recipientName && label(identities[0]) === profile.recipientIdentity;
}

export function qqContact(nodes, profile) {
  if (!profile.contactResourceId) throw new Error('当前不是已验证会话，且未配置可验证的联系人控件');
  const hits = matches(nodes, profile.contactResourceId).filter((node) => label(node) === profile.recipientName && node.point);
  if (hits.length !== 1) throw new Error('无法唯一定位已授权联系人控件，已取消发送');
  return hits[0];
}

export function qqSendControls(nodes, profile) {
  if (!verifiedQqSession(nodes, profile)) throw new Error('无法验证聊天标题及收件人身份，已取消发送');
  const editors = matches(nodes, profile.editorResourceId).filter((node) => node.class === 'android.widget.EditText' && node.point);
  const sends = matches(nodes, profile.sendResourceId).filter((node) => label(node) === '发送' && node.point);
  if (editors.length !== 1 || sends.length !== 1) throw new Error('未找到已核对的唯一输入框和发送按钮');
  return { editor: editors[0], send: sends[0] };
}
