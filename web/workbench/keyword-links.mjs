import { escapeHTML as e } from './model.mjs';

export function keywordLinksText(links = []) {
  return links.map(([source,target]) => `${source} → ${target}`).join('\n');
}

export function keywordLinksField(value = '') {
  return `<label class="field"><span>串联关键词</span><textarea class="input" name="keyword_links" rows="3" placeholder="每行一组，例如：橡胶金属粘接 → 西邦胶粘剂">${e(value)}</textarea><small>以左侧搜索词为主词写作时，有资料依据才会关联右侧词。</small></label>`;
}

export function parseKeywordLinks(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line,index) => {
    const pair = line.split(/→|->/).map(word => word.trim());
    if (pair.length !== 2 || pair.some(word => !word || word.length > 500) || pair[0] === pair[1]) {
      throw new Error(`串联关键词第 ${index + 1} 组需填写两个不同的词，用 → 分隔`);
    }
    return pair;
  });
}
