import { homeRecentsClasses, sel } from '../static-classes';
import { addStyle, removeStyle } from '../utils/styleInjector';

const STYLE_ID = 'playhub-artworks-home-hero-center';

/*
  Centre the Home hero vertically.

  Steam scales the Home hero to fill a wide, short band. Which part of a taller image
  survives that crop is decided by `object-position`, and the Playhub CSS Loader profile
  ("Proper Hero Scaling", 169home.css) sets it to `top center !important`:

      .BasicUI .gamepadhomerecentgames_RecentGamesBackgroundImage_3Mp8R {
        object-fit: cover !important;
        object-position: top center !important;
      }

  For a 1920x620 hero that is invisible - there is nothing to crop. For a hero with any
  other aspect ratio it keeps the top of the picture and throws the rest away, which is
  why the Home and the game page show two different framings of the same artwork.

  This is opt-in, because a theme setting is the user's choice and not something a plugin
  should quietly override. When it is on, the rule below wins on specificity: three
  classes against the theme's two, both `!important`.
*/
export const applyHomeHeroCentering = (enabled: boolean): boolean => {
  if (!enabled) {
    removeStyle(STYLE_ID);
    return true;
  }

  const images = sel(homeRecentsClasses, 'RecentGamesBackgroundImages');
  const background = sel(homeRecentsClasses, 'RecentGamesBackground');
  const image = sel(homeRecentsClasses, 'RecentGamesBackgroundImage');
  if (!images || !image) return false;

  const scope = background ? `${images} ${background} ${image}` : `${images} ${image}`;
  return addStyle(STYLE_ID, `
    .BasicUI ${scope},
    ${scope} {
      object-position: center center !important;
    }
  `);
};

export const removeHomeHeroCentering = () => removeStyle(STYLE_ID);
