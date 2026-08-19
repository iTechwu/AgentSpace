// channel focus 引用：/im 与 /contacts 的 focus 查询参数构建与匹配。
// 新格式用 "-" 分隔前缀（避免浏览器对 ":" 做百分号编码），旧 "prefix:value" 链接继续兼容。

export interface ChannelFocusTarget {
  id: string;
  channelName?: string | null;
  kind?: string | null;
  contactId?: string | null;
  humanContactUserId?: string | null;
}

function channelFocusValues(prefix: string, value: string): [string, string] {
  return [`${prefix}-${value}`, `${prefix}:${value}`];
}

export function buildChannelFocusKeys(channel: ChannelFocusTarget): string[] {
  const keys = [...channelFocusValues("channel", channel.id)];
  const channelName = channel.channelName ?? channel.id;
  if (channelName !== channel.id) {
    keys.push(...channelFocusValues("channel", channelName));
  }
  if (channel.kind === "direct" && channel.contactId) {
    keys.push(...channelFocusValues("contact", channel.contactId));
  }
  if (channel.kind === "direct" && channel.humanContactUserId) {
    keys.push(...channelFocusValues("human", channel.humanContactUserId));
  }
  return keys;
}

export function buildChannelFocusValue(channel: ChannelFocusTarget | undefined, fallbackChannelId: string): string {
  if (channel?.kind === "direct" && channel.contactId) {
    return `contact-${channel.contactId}`;
  }
  if (channel?.kind === "direct" && channel.humanContactUserId) {
    return `human-${channel.humanContactUserId}`;
  }
  return `channel-${channel?.channelName ?? fallbackChannelId}`;
}
