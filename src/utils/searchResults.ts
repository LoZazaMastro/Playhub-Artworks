/** Preserve provider failures instead of converting a rejected lookup into "no art". */
export const combineAssetSearchResults = (results: PromiseSettledResult<any[]>[]): any[] => {
  const successes = results.filter((entry): entry is PromiseFulfilledResult<any[]> => entry.status === 'fulfilled');
  if (!successes.length) {
    const failed = results.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return uniqueAssets(successes.flatMap(entry => Array.isArray(entry.value) ? entry.value : []));
};
export const uniqueAssets = (assets: any[]): any[] => {
  const seen = new Set<string>();
  return assets.filter(asset => {
    const key = String(asset?.url ?? asset?.thumb ?? asset?.id ?? '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
/** Do not silently associate a sequel/edition simply because autocomplete ranked it first. */
export const exactTitleMatch = (title: string, matches: any[]): any | undefined => {
  const normalize = (value: string) => String(value).replace(/[™®©]/g, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const target = normalize(title);
  return target ? matches.find(game => normalize(game?.name ?? '') === target) : undefined;
};
