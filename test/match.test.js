import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// userscript 在非浏览器环境下只导出纯函数，不触碰 DOM
const { normalizeText, matchKeywords } = require('../s1-a5-blocker.user.js');

describe('normalizeText', () => {
  test('全角折半角', () => {
    expect(normalizeText('ａ５')).toBe('a5');
  });
  test('小写化', () => {
    expect(normalizeText('A5')).toBe('a5');
  });
  test('去空白', () => {
    expect(normalizeText('哎 小 呜')).toBe('哎小呜');
    expect(normalizeText('a\n5\trepo')).toBe('a5repo');
  });
  test('去零宽字符（防变体绕过）', () => {
    expect(normalizeText('a\u200b5')).toBe('a5');
    expect(normalizeText('\ufeff哎小呜')).toBe('哎小呜');
  });
  test('空值安全', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
  test('剔除 URL（防止链接里的 a5 误伤）', () => {
    // URL 替换为 \u0000 占位而非删除，避免两侧字符拼接出新命中（选A<URL>5号 不得拼成 a5）
    expect(normalizeText('看 https://img.example.com/a5/x.jpg 很好')).toBe('看\u0000很好');
    expect(normalizeText('HTTPS://EXAMPLE.COM/A5')).toBe('\u0000');
    expect(normalizeText('www.imgur.com/a5abc.png')).toBe('\u0000');
    expect(normalizeText('ｈｔｔｐｓ：//example.com/a5/x')).toBe('\u0000');
  });
});

describe('matchKeywords', () => {
  const kws = ['a5', '哎小呜'];
  test('正文命中 a5', () => {
    expect(matchKeywords('发a5repo还能一眼掠过无视', kws)).toBe('a5');
  });
  test('全角变体命中', () => {
    expect(matchKeywords('ａ５直播repo', kws)).toBe('a5');
  });
  test('大小写不敏感', () => {
    expect(matchKeywords('A5推送何意味', kws)).toBe('a5');
  });
  test('带空格混淆命中', () => {
    expect(matchKeywords('发 a 5 repo', kws)).toBe('a5');
  });
  test('中文昵称命中', () => {
    expect(matchKeywords('哎小呜今天播了吗', kws)).toBe('哎小呜');
  });
  test('无命中返回 null', () => {
    expect(matchKeywords('今天天气不错', kws)).toBeNull();
    expect(matchKeywords('', kws)).toBeNull();
  });
  test('空关键词被忽略', () => {
    expect(matchKeywords('xx', ['', '  '])).toBeNull();
  });
  test('URL 形态关键词被忽略（不成为命中一切链接的通配符）', () => {
    expect(matchKeywords('正常发言 https://weibo.com/abc 大家看', ['https://x.com/a5'])).toBeNull();
    expect(matchKeywords('看看 www.baidu.com', ['www.a5.com'])).toBeNull();
  });
  test('含 URL 的混合关键词仍按占位符语义匹配', () => {
    expect(matchKeywords('看 https://x.com/a5 图 哈哈', ['看 https://x.com/a5 图'])).toBe('看\u0000图');
  });
  test('关键词本身也做归一化', () => {
    expect(matchKeywords('A5', ['Ａ５'])).toBe('a5');
    expect(matchKeywords('哎小呜', ['哎 小 呜'])).toBe('哎小呜');
  });
  test('子串语义（ba5 也命中）', () => {
    expect(matchKeywords('xba5c', kws)).toBe('a5');
  });
  test('URL 豁免：链接里的 a5 不命中', () => {
    expect(matchKeywords('https://b23.tv/a5abc', kws)).toBeNull();
    expect(matchKeywords('链接 https://x.com/a5_yy 不错', kws)).toBeNull();
  });
  test('URL 剔除不拼接两侧字符', () => {
    expect(matchKeywords('选A https://x.com/vote 5号', kws)).toBeNull();
    expect(matchKeywords('哎 https://x.com 小呜', kws)).toBeNull();
  });
  test('URL 豁免不放过正文里的 a5 文字', () => {
    expect(matchKeywords('a5仓库 https://github.com/x/a5', kws)).toBe('a5');
  });
});
