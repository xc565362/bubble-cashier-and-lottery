export const RULES_TEXT_CAPABILITY = 'rules-text-v1';
export const RULES_TEXT_MAX_LENGTH = 5000;

export function normalizeRulesText(value) {
  if (typeof value !== 'string') throw new Error('活动说明必须为纯文本');
  const normalized = value.replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(normalized)) throw new Error('活动说明含有不支持的控制字符，请删除后重试');
  const text = normalized.trim();
  if (text.length > RULES_TEXT_MAX_LENGTH) throw new Error('活动说明最多 5000 个字符');
  return text;
}

export function rulesTextPayload(snapshot, value, previous, activity) {
  const text = normalizeRulesText(value ?? '');
  if (snapshot.capabilities?.includes(RULES_TEXT_CAPABILITY)) return { rulesText: text };
  if (text !== normalizeRulesText(previous ?? '')) throw new Error(`请先升级「${activity}」的云端活动服务和 H5 页面，再编辑活动说明；本次没有保存修改`);
  return {};
}
