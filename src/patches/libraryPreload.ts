import { libraryGridScope, mountedLibraryGrids } from './libraryGridScope';

let timer: ReturnType<typeof setInterval> | undefined;
const patches = new Map<any, () => void>();

export function stopLibraryPreload() {
  if (timer) clearInterval(timer);
  timer = undefined;
  patches.forEach((restore) => restore());
  patches.clear();
}

export function startLibraryPreload() {
  stopLibraryPreload();
  const scan = () => {
    try {
      const grids = new Set(mountedLibraryGrids());
      patches.forEach((restore, grid) => {
        if (!grids.has(grid)) { restore(); patches.delete(grid); }
      });
      for (const grid of grids) {
        // Steam already uses 3 rows for collections and 2 for showcases.
        // Fill smaller margins only, without changing Steam's image/cache lifecycle.
        if (patches.has(grid) || (grid.props.renderOutsideRows || 0) >= 2) continue;
        const own = Object.getOwnPropertyDescriptor(grid, 'ComputeLayout');
        if (own && !own.configurable) continue;
        const original = grid.ComputeLayout;
        const wrapped = function(this: any, ...args: any[]) {
          const props = this.props;
          const columns = props?.iItemsPerRow;
          if (!libraryGridScope(this) || !Number.isInteger(columns) || columns < 1 || columns > 16) {
            return original.apply(this, args);
          }
          const rows = Math.min(2, Math.floor(16 / columns));
          if ((props.renderOutsideRows || 0) >= rows) return original.apply(this, args);
          this.props = { ...props, renderOutsideRows: rows };
          try { return original.apply(this, args); }
          finally { this.props = props; }
        };
        Object.defineProperty(grid, 'ComputeLayout', { configurable: true, writable: true, value: wrapped });
        patches.set(grid, () => {
          if (grid.ComputeLayout !== wrapped) return;
          if (own) Object.defineProperty(grid, 'ComputeLayout', own);
          else delete grid.ComputeLayout;
        });
      }
    } catch { /* Window transition; retry without discarding active patches. */ }
  };
  timer = setInterval(scan, 2000);
  scan();
}
