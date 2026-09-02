import {
  useState,
  createContext,
  FC,
  ReactNode,
  useEffect,
  useContext,
  useMemo,
} from 'react';
import { call } from '@decky/api';
import debounce from 'just-debounce';

import log from '../utils/log';

const SETTINGS_TIMEOUT_MS = 5000;

const withTimeout = <T,>(promise: Promise<T>, fallback: T, key: unknown): Promise<T> =>
  new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      log('setting read timeout', key);
      resolve(fallback);
    }, SETTINGS_TIMEOUT_MS);
    promise.then((value) => {
      window.clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      window.clearTimeout(timer);
      log('setting read failed', key, error);
      resolve(fallback);
    });
  });

export const SettingsContext = createContext({});

type SettingsContextType = {
  set: (key: any, value: any, immediate?: boolean) => Promise<void>;
  get: (key: any, fallback: any) => Promise<any>;
  settings: any;
};

export const SettingsProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [setting, setSetting] = useState<{key: any, value: any}>();

  const save = useMemo(() => async (setting: {key: any, value: any}) => {
    log('writing setting', { key: setting.key, value: String(setting.key).includes('api_key') ? '[redacted]' : setting.value });
    await call('set_setting', setting.key, setting.value);
  }, []);

  const saveDb = useMemo(() => debounce(async (key, value) => {
    log('set setting state', key, value);
    setSetting({ key, value });
  }, 1500), []);

  const set = useMemo(() => async (key, value, immediate = false) => {
    if (immediate) {
      await save({ key, value });
      return;
    }
    saveDb(key, value);
  }, [save, saveDb]) as SettingsContextType['set'];

  const get: SettingsContextType['get'] = useMemo(() => async (key, fallback) => {
    return await withTimeout(call('get_setting', key, fallback), fallback, key);
  }, []);

  useEffect(() => {
    if (setting) {
      save(setting);
    }
  }, [save, setting]);

  return (
    <SettingsContext.Provider value={{ set, get }}>
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => useContext(SettingsContext) as SettingsContextType;

export default useSettings;
