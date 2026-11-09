// Mirror the display-only resolution in bridge/creation_context.py. The server
// still resolves and freezes the target from the submitted inputs.
function lengthIn(text = '') {
  const pattern = /(?:全文|正文|篇幅|字数|口播)?\s*(?:控制在\s*)?(?:不得超过|不超过|不低于|最多|至少|大约|约)?\s*(?<!\p{Nd})\p{Nd}{1,5}\s*(?:[—–\-~～至到]\s*\p{Nd}{1,5}\s*)?字(?:左右|以内|以上|以下)?/gu;
  return [...text.matchAll(pattern)].at(-1)?.[0].trim() || '';
}

function decimal(value) {
  return Number(value.replace(/\p{Nd}/gu,digit=>{
    const point = digit.codePointAt(0);
    let start = point;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((point - start) % 10);
  }));
}

export function articleLengthHint(platform, format, preset, note, customerNote) {
  const rule = platform.length_hint || '';
  const clauses = rule.split(/[；;]/u);
  const hint = clauses.length > 1 && format ? clauses.map(value=>value.trim()).find(value=>value.startsWith(format)) || rule : rule;
  if (!preset) return lengthIn(note) || lengthIn(customerNote) || hint;
  const [low,high] = (lengthIn(hint).match(/\p{Nd}+/gu) || []).map(decimal);
  if (low > 0 && high > low) {
    const middle = Math.floor((low + high) / 2);
    return preset === '短篇' ? `正文 ${low}—${middle} 字` : `正文 ${middle + 1}—${high} 字`;
  }
  return hint ? `${preset}，遵循平台建议：${hint}` : preset;
}
