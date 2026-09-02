import { createContext, useContext, type ReactNode } from 'react';
import type { AppConfig, Workspace } from './types';

type AppContextValue = {
  config: AppConfig | null;
  workspace: Workspace | null;
  refresh: () => void;
};

const AppContext = createContext<AppContextValue>({
  config: null,
  workspace: null,
  refresh: () => {},
});

export function AppContextProvider({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
