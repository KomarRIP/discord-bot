import type { ChannelType, ChannelKey, RoleKey } from "../../domain/template/types.js";

export function managedRoleName(displayName: string, roleKey: RoleKey): string {
  return `〚SSO〛 ${displayName} 〔${roleKey}〕`;
}

export function managedCategoryName(displayName: string, categoryKey: ChannelKey): string {
  return `〚SSO〛 ${displayName} 〔${categoryKey}〕`;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function managedChannelName(name: string, channelKey: ChannelKey, type: ChannelType): string {
  if (type === "category") return managedCategoryName(name, channelKey);
  // Discord channel names are limited; we keep a stable suffix for adoption.
  const base = slugify(name);
  const shortKey = channelKey.replace(/^CH_/, "").replace(/^CAT_/, "").toLowerCase();
  const suffix = shortKey.slice(0, 12);
  const combined = [base, suffix].filter(Boolean).join("-");
  return combined.slice(0, 90); // safety margin under Discord limits
}

