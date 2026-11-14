export const LOCALES: string[];
export const FILES: string[];
export function validate(file: string, json: unknown): void;
export function syncEmojibase(options?: {
  from?: string;
  to?: string;
  locales?: string[];
  version?: string;
}): Promise<{ written: string[]; unchanged: string[] }>;
