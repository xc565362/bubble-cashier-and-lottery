import React from 'react';
import { normalizeRulesText, RULES_TEXT_MAX_LENGTH } from './rulesText.js';

export function ActivityRulesEditor({ id, activity, value = '', supported, disabled, onChange }) {
  const text = value.replace(/\r\n?/g, '\n').trim();
  let error = '';
  try { normalizeRulesText(value); } catch (issue) { error = issue.message; }
  return <section className="activityRulesEditor" aria-label={`${activity}活动说明编辑`}>
    <div className="activityRulesHeading"><label htmlFor={id}>活动说明正文</label><span id={`${id}-count`} className={error ? 'dangerText' : ''}>{text.length} / {RULES_TEXT_MAX_LENGTH}</span></div>
    <p id={`${id}-help`} className="lotteryHelp">保存后同步到 H5 的活动说明页。支持多行纯文本，留空恢复默认说明；奖品、概率和活动时间会自动显示，无需手写。</p>
    {!supported && <p className="lotteryNotice" role="status">当前「{activity}」尚未支持活动说明编辑。请先升级该活动的云端服务和 H5 页面，再刷新连接。其他奖品配置仍可保存。</p>}
    <textarea id={id} aria-label={`${activity}活动说明正文`} aria-describedby={`${id}-help ${id}-count${error ? ` ${id}-error` : ''}`} aria-invalid={!!error}
      rows={6} maxLength={RULES_TEXT_MAX_LENGTH} value={value} disabled={disabled || !supported}
      placeholder="填写现场参与步骤、领取地点或其他补充说明；留空使用默认说明"
      onChange={event => onChange(event.target.value.replace(/\r\n?/g, '\n'))} />
    {error && <p id={`${id}-error`} className="dangerText" role="alert">{error}</p>}
    <div className="activityRulesPreview" aria-label={`${activity}活动说明文字预览`}><strong>文字预览</strong>{text ? <p>{text}</p> : <p className="lotteryHelp">未填写自定义正文，H5 将显示默认活动说明。奖品、概率和时间仍按已保存配置显示。</p>}</div>
  </section>;
}
