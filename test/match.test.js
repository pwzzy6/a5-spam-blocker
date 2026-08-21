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
  test('关键词本身也做归一化', () => {
    expect(matchKeywords('A5', ['Ａ５'])).toBe('a5');
    expect(matchKeywords('哎小呜', ['哎 小 呜'])).toBe('哎小呜');
  });
  test('子串语义（ba5 也命中）', () => {
    expect(matchKeywords('xba5c', kws)).toBe('a5');
  });
});
