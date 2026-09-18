# Frozen runtime for the offline 1.1.4 build

`runtime.js` contains only the third-party helper/icon runtime already bundled in the user-supplied Playhub Artworks 1.1.3 `dist/index.js`. It does not contain the previous plugin implementation or Steam client code. All plugin modules in `src/` are recompiled by `tools/build-offline.cjs`.

`manifest.json` records the SHA-256 of that original bundle, the dependency exports used by the offline builder and SHA-256 hashes of the unchanged SCSS source files. `style.css` is the corresponding compiled CSS from the same supplied release. No fonts are included. A change to SCSS requires the normal Rollup/Sass build; the offline builder intentionally refuses to reuse stale CSS.

This is a frozen distribution of the dependencies already used by the project, not new implementations or a claim of authorship. It preserves the runtime used by 1.1.3 without fetching new packages in a network-restricted build environment. The dependency names and declared versions remain in `package.json` / `pnpm-lock.yaml`. Existing licenses and attributions in `LICENSE`, `NOTICE.md`, and the runtime comments continue to apply. The normal package-manager build uses the original dependency packages instead of this snapshot.

The preserved runtime covers just-debounce, react-fast-compare, async-wait-until and the react-icons families listed in the manifest. React and ReactDOM remain supplied by Steam; Decky UI and API remain supplied by Decky at runtime. No Steam/Decky installation files are distributed here.
