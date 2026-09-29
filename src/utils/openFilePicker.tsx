import { FileSelectionType, openFilePicker } from '@decky/api';
import { findSteamUI } from './steamWindow';

export class FilePickerCancelled extends Error {}
export const isFilePickerCancelled = (error: unknown): boolean =>
  error instanceof FilePickerCancelled || error === 'User Canceled'
  || (error as { result?: number })?.result === 52;

export type FilePickerFilter = RegExp | ((file: File) => boolean) | undefined;

export default async (
  startPath: string,
  includeFiles?: boolean,
  filter?: FilePickerFilter,
  filePickerSettings?: {
    validFileExtensions?: string[];
    defaultHidden?: boolean;
  }
): Promise<{ path: string; realpath: string }> => {
  // Steam's own native picker works in Windows without Decky's Linux-oriented
  // directory browser. Use the visible Steam window to parent the dialog.
  const owner = findSteamUI()?.window as any;
  const system = owner?.SteamClient?.System?.OpenFileDialog
    ? owner.SteamClient.System : (window as any).SteamClient?.System;
  if (typeof system?.OpenFileDialog === 'function') {
    const extensions = filePickerSettings?.validFileExtensions;
    const path = await system.OpenFileDialog({
      strTitle: 'Playhub Artworks',
      strInitialFile: startPath,
      rgFilters: extensions?.length ? [{
        strFileTypeName: extensions.map(extension => `*.${extension}`).join(', '),
        rFilePatterns: extensions.map(extension => `*.${extension}`),
        bUseAsDefault: true,
      }] : undefined,
    });
    if (!path) throw new FilePickerCancelled();
    if (typeof path !== 'string') throw new Error('Invalid file picker response');
    if (extensions?.length && !extensions.some(extension => path.toLowerCase().endsWith(`.${extension.toLowerCase()}`))) {
      throw new Error('Unsupported image format');
    }
    return { path, realpath: path };
  }
  return await openFilePicker(
      FileSelectionType.FILE,
      startPath,
      includeFiles,
      true,
      filter,
      filePickerSettings?.validFileExtensions,
      filePickerSettings?.defaultHidden,
      false
    );
};
