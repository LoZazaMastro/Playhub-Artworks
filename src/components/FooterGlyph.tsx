import { FC, CSSProperties } from 'react';
import { findModuleExport } from '@decky/ui';

export enum FooterGlyphType { Knockout, Light, Dark }
export enum FooterGlyphSize { Small, Medium, Large }

export interface FooterGlyphProps {
  button: number;
  type?: FooterGlyphType;
  size?: FooterGlyphSize;
  style?: CSSProperties;
  additionalClassName?: string;
}

/** Steam 11006468 moved .Knockout into a helper outside the glyph component.
 * Inspect the component's own button labels instead of relying on inlining.
 * Never invoke a component, its hooks or an export's custom toString here.
 */
export const isFooterGlyphExport = (value: unknown): boolean => {
  try {
    let component: any = value;
    for (let depth = 0; depth < 4; depth++) {
      if (typeof component === 'function') {
        const source = Function.prototype.toString.call(component);
        if (!source.includes('additionalClassName')) return false;
        return source.includes('.Knockout') || (
          source.includes('#ControllerButton_A') &&
          source.includes('#ControllerButton_Menu') &&
          source.includes('.button')
        );
      }
      if (component?.$$typeof === Symbol.for('react.memo')) component = component.type;
      else if (component?.$$typeof === Symbol.for('react.forward_ref')) component = component.render;
      else return false;
    }
  } catch { /* A Steam export can be an inaccessible proxy or a late module. */ }
  return false;
};

let nativeGlyph: FC<FooterGlyphProps> | undefined;
let nextLookupAt = 0;

const resolveNativeGlyph = (): FC<FooterGlyphProps> | undefined => {
  if (nativeGlyph) return nativeGlyph;
  const now = Date.now();
  if (now < nextLookupAt) return undefined;
  // A grid can contain many Note badges. Avoid scanning all modules for each one.
  // Only successful lookups are permanent; late modules can recover on a render.
  nextLookupAt = now + 2000;
  try {
    const candidate = typeof findModuleExport === 'function'
      ? findModuleExport(isFooterGlyphExport) : undefined;
    if (isFooterGlyphExport(candidate)) nativeGlyph = candidate as FC<FooterGlyphProps>;
  } catch { /* The local fallback remains usable without a Decky/Steam match. */ }
  return nativeGlyph;
};

/** This plugin uses button 11 (Start/Menu) next to the translated Notes label.
 * A decorative local glyph keeps the page usable when Steam's module is absent.
 */
const MenuGlyphFallback: FC<FooterGlyphProps> = ({ style, additionalClassName }) => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
    className={additionalClassName}
    style={style}
    data-playhub-glyph="menu-fallback"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M8 8h8M8 12h8M8 16h8" />
  </svg>
);

/** Always export a real component, never the possibly undefined lookup result. */
const FooterGlyph: FC<FooterGlyphProps> = (props) => {
  const NativeGlyph = resolveNativeGlyph();
  if (NativeGlyph) return <NativeGlyph {...props} />;
  // Do not display the wrong button for an unknown future caller.
  return props.button === 11 ? <MenuGlyphFallback {...props} /> : null;
};

export default FooterGlyph;
