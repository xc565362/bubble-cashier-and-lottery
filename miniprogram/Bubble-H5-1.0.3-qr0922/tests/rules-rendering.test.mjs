import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { campaignView, escapeHtml, dateLabel } from '../public/core.mjs';
import { prizeBoard, probabilityExplanation } from '../public/catalog.mjs';

const source = fs.readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
const rulesSource = source.slice(source.indexOf('function rules(){'), source.indexOf('\nfunction staff(){'));
const campaign = { venue: '测试展位', cashTerms: '默认购物券说明', drawMode: 'fixed',
  startsAt: 1800000000000, endsAt: 1800000600000, redeemEndsAt: 1800001200000 };
const prizes = [{ id: 'server-gift', kind: 'physical', name: '动态奖品', configuredProbability: 100, effectiveProbability: 100 }];
function render(patch = {}, preview = false) {
  return vm.runInNewContext(rulesSource + '\nrules();', {
    S: { state: { campaign: { ...campaign, ...patch }, prizes } }, campaignView, prizeBoard,
    probabilityExplanation, e: escapeHtml, api: { isPreview: preview },
    heading: () => '<h1>活动规则</h1>',
  });
}

test('custom instructions replace participation paragraphs while keeping live prizes, probability, dates and privacy help', () => {
  const html = render({ rulesText: '请在现场确认资格。\r\n核销后领取奖品。' });
  assert.match(html, /02 \/ 活动说明/);
  assert.match(html, /请在现场确认资格。<br>核销后领取奖品。/);
  assert.doesNotMatch(html, /每个微信账号在本次活动中有 1 次抽奖机会|默认购物券说明/);
  assert.ok(html.includes('动态奖品'));
  assert.ok(html.includes(escapeHtml(probabilityExplanation(campaign, prizes))));
  for (const time of [campaign.startsAt, campaign.endsAt, campaign.redeemEndsAt]) assert.ok(html.includes(dateLabel(time)));
  assert.match(html, /隐私与帮助|工作人员核销入口/);
});

test('instruction text escapes markup and attributes before preserving newlines', () => {
  const html = render({ rulesText: '</p><script>alert("x")</script>\n<img src=x onerror=alert(1)>&\'尾行' });
  assert.match(html, /&lt;\/p&gt;&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&amp;&#39;尾行/);
  assert.doesNotMatch(html, /<script|<img/);
});

test('missing, empty, whitespace or non-string instructions render the entire existing default guide', () => {
  const original = render();
  for (const rulesText of [undefined, '', ' \r\n\t ', null, 42, {}]) assert.equal(render({ rulesText }), original);
  assert.match(original, /02 \/ 参与与领取/);
  assert.match(original, /每个微信账号在本次活动中有 1 次抽奖机会/);
  assert.match(original, /默认购物券说明/);
  assert.match(render({ rulesText: '' }, true), /当前为隔离预览/);
});
