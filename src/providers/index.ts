import type { ProviderId } from '../domain/types.ts';
import { googleProvider } from './google.ts';
import { outlookProvider } from './outlook.ts';
import type { CalendarProvider } from './types.ts';

export const providers: Record<ProviderId, CalendarProvider> = {
  google: googleProvider,
  outlook: outlookProvider,
};

export function getProvider(id: string): CalendarProvider {
  const provider = providers[id as ProviderId];
  if (!provider) throw new Error(`Provider inconnu : ${id}`);
  return provider;
}

export { ProviderError } from './types.ts';
export type { CalendarProvider } from './types.ts';
