import { Navigation } from '@decky/ui';

import { steamPath } from '../utils/steamRoute';

export function rerenderAfterPatchUpdate(): void {
  const path = steamPath();
  if (path.startsWith('/routes/library/home')) {
    Navigation.Navigate('/library/home');
    Navigation.NavigateBack();
  } else if (path.startsWith('/routes/library')) {
    Navigation.Navigate('/library');
    Navigation.NavigateBack();
  }
}
