const SIZE_UNITS = {
  '': 1, B: 1,
  K: 1024,       KB: 1024,
  M: 1024 ** 2,  MB: 1024 ** 2,
  G: 1024 ** 3,  GB: 1024 ** 3,
  T: 1024 ** 4,  TB: 1024 ** 4,
};

export function parseSize(value) {
  const str = String(value).trim();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/);
  if (!match) throw new Error(`Invalid size value: "${value}"`);
  const unit = match[2].toUpperCase();
  if (!(unit in SIZE_UNITS)) throw new Error(`Unknown size unit "${match[2]}" in: "${value}"`);
  return Math.round(parseFloat(match[1]) * SIZE_UNITS[unit]);
}
