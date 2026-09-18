import { AppDetails } from '@decky/ui/dist/globals/steam-client/App';

export default async function getAppDetails(appId: number): Promise<AppDetails | null> {
  return await new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let registration: { unregister: () => void } | undefined;
    let settled = false;
    const finish = (details: AppDetails | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try { registration?.unregister(); } catch { /* Steam window closed. */ }
      resolve(details);
    };
    try {
      registration = SteamClient.Apps.RegisterForAppDetails(appId, (details: AppDetails) => finish(details));
      if (settled) { try { registration?.unregister(); } catch { /* Already removed. */ } }
      else timer = setTimeout(() => finish(null), 1000);
    } catch { finish(null); }
  });
}
