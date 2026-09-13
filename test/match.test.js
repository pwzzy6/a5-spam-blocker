import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// userscript 在非浏览器环境下只导出纯函数，不触碰 DOM
const { normalizeText, matchKeywords, isNewerVersion, SCRIPT_VERSION } = require('../s1-a5-blocker.user.js');

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

describe('图片链接豁免', () => {
  const kws = ['a5', '哎小呜'];
  test('裸域名图片 URL 不命中（无协议也豁免）', () => {
    expect(normalizeText('图 i.imgur.com/a5abc.png 看看')).toBe('图\u0000看看');
    expect(normalizeText('x.com/a5.png?v=1')).toBe('\u0000');
  });
  test('[img] BBCode 残留不命中（含 [img=url] 形式）', () => {
    expect(normalizeText('[img]https://x.com/a5.png[/img]')).toBe('\u0000');
    expect(normalizeText('[img=x.com/a5.png]图[/img]')).toBe('\u0000');
  });
  test('markdown 图片不命中', () => {
    expect(normalizeText('![截图](https://x.com/a5.png)')).toBe('\u0000');
  });
  test('全角域名/扩展名经 NFKC 折叠后同样豁免', () => {
    expect(normalizeText('ｉｍｇｕｒ．ｃｏｍ／ａ５ａｂｃ．ｐｎｇ')).toBe('\u0000');
  });
  test('多张图片分属不同 token 时各自替换为占位符，不拼接出新命中', () => {
    expect(normalizeText('发我x.jpg y.png两张图')).toBe('\u0000\u0000两张图');
  });
  test('同一 token 内多个后缀只剔除到首个（锚定起点换线性的代价，等同 0.1.4 行为）', () => {
    expect(normalizeText('发我x.jpg和y.png两张图')).toBe('\u0000和y.png两张图');
  });
  test('非图片后缀的文件链接不在豁免范围', () => {
    expect(normalizeText('a5repo.zip')).toBe('a5repo.zip');
  });
  test('matchKeywords：裸域名图片链接整体不触发', () => {
    expect(matchKeywords('图 imgur.com/a5abc.png 看看', kws)).toBeNull();
    expect(matchKeywords('[img]x.com/a5.png[/img]', kws)).toBeNull();
    expect(matchKeywords('看 markdown 图 ![x](imgur.com/a5.png) 就好', kws)).toBeNull();
  });
  test('matchKeywords：图片链接剔除不放过正文 a5 文字', () => {
    expect(matchKeywords('a5图包 x.com/a5.png', kws)).toBe('a5');
  });
  test('超长无空格输入线性完成（回归：惰性起扫曾为二次方）', () => {
    expect(normalizeText('啊'.repeat(100000))).toBe('啊'.repeat(100000));
    expect(normalizeText('x'.repeat(99995) + '.jpx')).toBe('x'.repeat(99995) + '.jpx');
    expect(normalizeText('y'.repeat(99996) + '.png')).toBe('\u0000');
  });
});

describe('isNewerVersion', () => {
  test('高版本返回 true', () => {
    expect(isNewerVersion('0.1.3', '0.1.2')).toBe(true);
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true); // 数字比较而非字典序
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });
  test('相同或更低版本返回 false', () => {
    expect(isNewerVersion('0.1.3', '0.1.3')).toBe(false);
    expect(isNewerVersion('0.1.2', '0.1.3')).toBe(false);
    expect(isNewerVersion('0.1.9', '0.1.10')).toBe(false);
  });
  test('段数不同按缺省 0 补齐', () => {
    expect(isNewerVersion('0.1.1', '0.1')).toBe(true);
    expect(isNewerVersion('0.1', '0.1.0')).toBe(false);
  });
  test('畸形输入一律 false（不弹更新）', () => {
    expect(isNewerVersion('', '0.1.3')).toBe(false);
    expect(isNewerVersion('v0.2.0', '0.1.3')).toBe(false);
    expect(isNewerVersion('0.1.x', '0.1.3')).toBe(false);
    expect(isNewerVersion(null, '0.1.3')).toBe(false);
    expect(isNewerVersion(undefined, '0.1.3')).toBe(false);
  });
});

describe('版本一致性', () => {
  test('metadata @version 与 SCRIPT_VERSION 导出一致', async () => {
    const src = await Bun.file(new URL('../s1-a5-blocker.user.js', import.meta.url)).text();
    const m = /^\/\/ @version\s+(\S+)$/m.exec(src);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(SCRIPT_VERSION);
  });
});
