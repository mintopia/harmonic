import type { AdvertisedCommand } from '../../types.js';

export function commandPickerState(
  text: string,
  caret: number,
  prefix: string,
  commands: AdvertisedCommand[],
): { start: number; end: number; commands: AdvertisedCommand[] } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  const token = text.slice(start, end);
  if (!token.startsWith(prefix)) return null;
  const query = token.slice(prefix.length).toLocaleLowerCase();
  const matching = commands.filter((command) => command.name.toLocaleLowerCase().startsWith(query));
  return matching.length > 0 ? { start, end, commands: matching } : null;
}
