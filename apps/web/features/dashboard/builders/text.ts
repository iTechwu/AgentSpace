// 跨领域共享的文本比较 helper（zh-CN 大小写/音调不敏感）。

export function sameText(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}
