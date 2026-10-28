import { allowed, deny, exactKeys } from './platforms.mjs';

export const SOCIAL_ACCOUNT_ROUTES = Object.freeze({
  'social/accounts': 'GET', 'social/check-browser': 'POST', 'social/hold': 'POST', 'social/resume': 'POST', 'social/login/start': 'POST', 'social/login/image': 'POST', 'social/login/check': 'POST', 'social/login/close': 'POST',
  'social/account/confirm': 'POST', 'social/read': 'POST', 'social/browse': 'POST', 'social/prepare': 'POST',
  'social/approve': 'POST', 'social/execute': 'POST', 'social/cancel': 'POST', 'social/acknowledge': 'POST', 'social/recover-executor': 'POST', 'social/stop-executor': 'POST',
});
export const SOCIAL_ACCOUNT_ERRORS = Object.freeze({
  COOLDOWN: '本地请求间隔或次数已达上限，请稍后由本人重新发起；不会排队重试。',
  RISK_CONTROL: '平台要求安全验证，本平台操作已停止；请由本人在官方页面处理。',
  INCOMPLETE_CREDENTIAL: '平台没有返回完整登录凭据，没有绑定账号；不会反复生成二维码。',
  LOGIN_REQUEST_FAILED: '登录状态读取未得到确认，没有自动重试或重新扫码。',
  LOGIN_RESPONSE_INVALID: '平台登录响应格式已变化，没有保存不完整的凭据。',
  LOGIN_STATUS_UNKNOWN: '平台登录状态无法识别，已停止后续步骤。',
  LOGIN_SESSION_MISMATCH: '登录会话已变化，请核对原会话。',
  INVALID_CREDENTIAL: '私有登录记录无法校验，请核对存储。',
  IDENTITY_UNAVAILABLE: '平台尚未确认当前账号身份，没有绑定账号。',
  FORBIDDEN: '当前主人权限已失效，请重新打开设置。', CONFLICT: '账号或内容版本已变化，请刷新后重新核对。',
  BUSY: '该平台有正在运行或尚待核对的执行器。', STORAGE_BUSY: '账号记录正在写入或旧写入需核对，请稍后刷新。',
  LOGIN_PENDING: '已有登录会话，请先检查登录或明确关闭该会话。', LOGIN_REQUIRED: '请先登录该平台的专用账号。',
  ACCOUNT_REQUIRED: '请先登录并确认大肥鱼自己的账号。', ACCOUNT_MISMATCH: '当前平台账号与绑定账号不一致，操作已停止。',
  RESULT_UNKNOWN: '此前操作结果未知，请先核对原平台与执行器；不会重发。', ACK_REQUIRED: '需要明确确认旧执行器已停止，并已核对平台结果。',
  NO_REPLAY: '这个操作已开始或已处理，不会重复执行。', INVALID_REQUEST: '平台操作参数无效。', INVALID_PLATFORM: '请选择B站、抖音或X。',
  INVALID_TARGET: '请核对平台链接、作品、评论或接收对象。', INVALID_OPERATION: '所选操作不可用。', INVALID_MEDIA: '本地媒体格式或大小不符合要求。',
  MEDIA_CHANGED: '媒体文件已经变化，请重新准备并核对草稿。', BINDINGS_REQUIRED: '当前账号的页面控件尚待核验，没有发起发送操作。',
  OPERATION_UNAVAILABLE: '该操作尚未完成当前平台适配，没有发起发送操作。', DRIVER_UNAVAILABLE: '当前平台驱动尚未就绪。',
  BROWSE_NEXT_UNAVAILABLE: '稳定作品身份尚未核验，暂不能切换下一个视频；没有发起切换，可继续只读当前页面。',
  BROWSER_UNKNOWN: '浏览器执行未得到完整确认，请刷新核对；不会重试发送。', WORKER_UNKNOWN: '平台执行器未得到完整确认，请核对原结果。',
  SDK_VERSION_MISMATCH: '平台SDK版本与已核验版本不一致，请检查组件。', PLATFORM_REQUEST_FAILED: '平台未确认请求，请检查登录、验证提示及最新记录。',
  INVALID_RECEIPT: '平台回执与本次操作未能精确匹配，不能称为发送成功。', CLEANUP_UNCONFIRMED: '旧执行器尚未确认清理，后续操作已暂停。',
  VIDEO_METADATA_REQUIRED: '投稿需要完整封面、标签、分区及已核验声明；尚未上传。',
  DECLARATION_BINDING_REQUIRED: '内容声明控件尚未核验，尚未上传或发布。',
  STORAGE_INVALID: '平台账号记录无法验证，请先检查存储。', STORAGE_CAPACITY: '平台记录达到容量上限，请保留记录并检查存储。',
});
export async function socialAccountRoute(endpoint, manager, body, context) {
  if (!manager) deny('DRIVER_UNAVAILABLE'); if (!allowed(context.authorize)) deny('FORBIDDEN');
  let result;
  if (endpoint === 'social/accounts') result = { accounts: manager.snapshot() };
  else if (endpoint === 'social/check-browser') result = await manager.checkBrowser(body, context);
  else if (endpoint === 'social/hold') result = manager.holdPlatform(body, context);
  else if (endpoint === 'social/resume') result = manager.resumePlatform(body, context);
  else if (endpoint === 'social/login/start') result = await manager.startLogin(body, context);
  else if (endpoint === 'social/login/image') result = manager.loginImage(body, context);
  else if (endpoint === 'social/login/check') result = await manager.checkLogin(body, context);
  else if (endpoint === 'social/login/close') result = await manager.closeLogin(body, context);
  else if (endpoint === 'social/account/confirm') result = await manager.confirmAccount(body, context);
  else if (endpoint === 'social/read') {
    exactKeys(body, ['platform', 'request']); result = { read: await manager.read(body.platform, body.request, context) };
  } else if (endpoint === 'social/browse') {
    exactKeys(body, ['platform', 'request']); result = { browse: await manager.browse(body.platform, body.request, context) };
  } else if (endpoint === 'social/prepare') {
    exactKeys(body, ['platform', 'request', 'requestId']); result = await manager.prepare(body.platform, body.request, { ...context, requestId: body.requestId });
  } else if (endpoint === 'social/approve') result = manager.approve(body, context);
  else if (endpoint === 'social/execute') result = await manager.execute(body, context);
  else if (endpoint === 'social/cancel') result = manager.cancel(body, context);
  else if (endpoint === 'social/stop-executor') result = await manager.stopExecutor(body, context);
  else if (endpoint === 'social/recover-executor') result = await manager.recoverExecutor(body, context);
  else if (endpoint === 'social/acknowledge') result = manager.acknowledgeUnknown(body, context);
  else deny('INVALID_REQUEST');
  if (!allowed(context.authorize)) deny('FORBIDDEN');
  return { ok: true, ...result, accounts: result.accounts || manager.snapshot() };
}
