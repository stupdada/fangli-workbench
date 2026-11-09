const MAX_ACCOUNT_COUNT = 20;

export const accountCapacity = selections => selections.length * MAX_ACCOUNT_COUNT;

export function distributeCount(selections, count) {
  const total = selections.reduce((sum, item) => sum + item.count, 0);
  if (count == null || count === total || !selections.length) return selections;
  if (count > accountCapacity(selections)) {
    throw new Error('现有账号篇数不足，请添加账号或减少每客户篇数');
  }
  const increasing = count > total;
  const result = selections.map(item => ({...item,count:increasing ? item.count : 0}));
  let remaining = increasing ? count - total : count;
  while (remaining > 0) {
    for (const [index, item] of result.entries()) {
      if (item.count >= (increasing ? MAX_ACCOUNT_COUNT : selections[index].count)) continue;
      item.count++;
      if (--remaining === 0) break;
    }
  }
  return result.filter(item => item.count > 0);
}
