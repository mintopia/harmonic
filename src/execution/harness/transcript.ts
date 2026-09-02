export interface TranscriptLogEvent {
  id: number;
  seq: number;
  ts: number;
  type: 'session_update';
  payload: Record<string, unknown>;
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;

export const timestamp = (value: unknown): number =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : 0;

export function contentText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const text = value
    .map((part) => {
      const block = asRecord(part);
      return block?.type === 'output_text' || block?.type === 'text' ? block.text : null;
    })
    .filter((part): part is string => typeof part === 'string')
    .join('');
  return text || null;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const targets: Record<string, (input: Record<string, unknown>) => string> = {
  Skill: (input) => [str(input.skill) && `/${str(input.skill)}`, str(input.args)].filter(Boolean).join(' '),
  Agent: (input) => [str(input.description) || str(input.prompt), str(input.subagent_type) && `(${str(input.subagent_type)})`].filter(Boolean).join(' '),
  Task: (input) => [str(input.description) || str(input.prompt), str(input.subagent_type) && `(${str(input.subagent_type)})`].filter(Boolean).join(' '),
  TodoWrite: (input) => (Array.isArray(input.todos) ? `${input.todos.length} todo${input.todos.length === 1 ? '' : 's'}` : ''),
  Grep: (input) => [str(input.pattern), str(input.path)].filter(Boolean).join(' in '),
  Glob: (input) => [str(input.pattern), str(input.path)].filter(Boolean).join(' in '),
  AskUserQuestion: (input) => str(Array.isArray(input.questions) ? asRecord(input.questions[0])?.question : null),
};

const genericTargetKeys = ['command', 'cmd', 'script', 'file_path', 'path', 'filename', 'pattern', 'query', 'url', 'skill', 'description', 'prompt', 'title', 'name', 'message', 'text', 'model'];

export function withTarget(name: string, rawInput: unknown): string {
  let value = rawInput;
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) return name;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return `${name} ${oneLine(trimmed)}`;
    }
  }
  if (typeof value === 'string') return `${name} ${oneLine(value)}`;
  const record = asRecord(value);
  if (!record) return name;
  const specific = targets[name]?.(record);
  if (specific) return `${name} ${oneLine(specific)}`;
  if (typeof record.action === 'string' && record.action) {
    const args = record.args === undefined ? '' : ` ${JSON.stringify(record.args)}`;
    return `${name} ${oneLine(`${record.action}${args}`)}`;
  }
  for (const key of genericTargetKeys) {
    const field = record[key];
    if (Array.isArray(field)) return `${name} ${oneLine(field.map(String).join(' '))}`;
    if (typeof field === 'string' && field) return `${name} ${oneLine(field)}`;
  }
  return name;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed;
}
